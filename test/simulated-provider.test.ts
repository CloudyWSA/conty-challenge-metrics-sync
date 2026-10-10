import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase, type SyncRun } from "../src/db.ts";
import { platforms, type Platform, type SyncWindow } from "../src/provider.ts";
import { SimulatedProvider } from "../src/simulated-provider.ts";

const timestamp = "2026-10-09T12:00:00.000Z";
const window = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-10T00:00:00.000Z" };
const totals = { views: 350, likes: 35, comments: 7, shares: 4 };

describe("API com o provedor simulado", () => {
  let db: ReturnType<typeof openDatabase>;
  let app: ReturnType<typeof createApp>;
  let provider: SimulatedProvider;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(timestamp));
    db = openDatabase();
    provider = new SimulatedProvider();
    vi.spyOn(provider, "fetchPosts");
    app = createApp(db, provider);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    db.close();
  });

  function post(path: string, body: unknown) {
    return app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function connect(accessToken: string, platform: Platform = "instagram") {
    const response = await post("/connections", { platform, account_id: "account-1", access_token: accessToken });
    expect(response.status).toBe(201);
    return await response.json() as { id: string };
  }

  function sync(connectionId: string, syncWindow: SyncWindow = window) {
    return post(`/connections/${connectionId}/sync`, syncWindow);
  }

  async function complete(response: Response, status = 200) {
    expect(response.status).toBe(status);
    const run = await response.json() as SyncRun;
    const stored = await app.request(`/syncs/${run.id}`);
    expect(stored.status).toBe(200);
    expect(await stored.json()).toEqual(run);
    expect(vi.getTimerCount()).toBe(0);
    return run;
  }

  async function metrics(connectionId: string) {
    const response = await app.request(`/connections/${connectionId}/metrics`);
    expect(response.status).toBe(200);
    return await response.json() as { posts: Array<{ post_id: string }>; totals: typeof totals };
  }

  it.each(platforms)("sincroniza os posts simulados de %s", async (platform) => {
    const connection = await connect("valid-token", platform);
    const run = await complete(await sync(connection.id));
    expect(run).toMatchObject({ status: "succeeded", attempts: 1, waited_ms: 0, received: 2, inserted: 2 });
    const result = await metrics(connection.id);
    expect(result.posts.map((post) => post.post_id)).toEqual(["post-1", "post-2"]);
    expect(result.totals).toEqual(totals);
    expect(provider.fetchPosts).toHaveBeenCalledTimes(1);
  });

  it("não duplica snapshots em respostas repetidas e janelas sobrepostas", async () => {
    const connection = await connect("duplicates");
    const first = await complete(await sync(connection.id));
    expect(first).toMatchObject({ received: 4, inserted: 2 });
    const originalMetrics = await metrics(connection.id);
    vi.setSystemTime(new Date("2026-10-09T12:01:00.000Z"));

    const repeated = await complete(await sync(connection.id));
    expect(repeated).toMatchObject({ received: 4, inserted: 0 });
    const overlap = await complete(await sync(connection.id, {
      from: "2026-10-02T12:00:00.000Z",
      to: window.to,
    }));
    expect(overlap).toMatchObject({ received: 2, inserted: 0 });
    expect(await metrics(connection.id)).toEqual(originalMetrics);
    expect(originalMetrics.totals).toEqual(totals);
    for (const postId of ["post-1", "post-2"]) {
      const response = await app.request(`/connections/${connection.id}/posts/${postId}/snapshots`);
      expect(response.status).toBe(200);
      expect((await response.json() as { snapshots: unknown[] }).snapshots).toHaveLength(1);
    }
    expect(provider.fetchPosts).toHaveBeenCalledTimes(3);
  });

  it("aborta o timeout simulado em 1 segundo e tenta de novo após 100 ms", async () => {
    const connection = await connect("timeout-once");
    const pending = sync(connection.id);
    await vi.advanceTimersByTimeAsync(999);
    expect(provider.fetchPosts).toHaveBeenCalledTimes(1);
    const firstSignal = vi.mocked(provider.fetchPosts).mock.calls[0][2];
    expect(firstSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(firstSignal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(99);
    expect(provider.fetchPosts).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    const run = await complete(await pending);
    expect(provider.fetchPosts).toHaveBeenCalledTimes(2);
    expect(run).toMatchObject({
      status: "succeeded", attempts: 2, waited_ms: 100, received: 2, inserted: 2,
      finished_at: "2026-10-09T12:00:01.100Z",
    });
    expect((await metrics(connection.id)).totals).toEqual(totals);
  });

  it("espera os 2 segundos do Retry-After antes de repetir um 429", async () => {
    const connection = await connect("rate-limit-once");
    const pending = sync(connection.id);
    await vi.advanceTimersByTimeAsync(1999);
    expect(provider.fetchPosts).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    const run = await complete(await pending);
    expect(provider.fetchPosts).toHaveBeenCalledTimes(2);
    expect(run).toMatchObject({
      status: "succeeded", attempts: 2, waited_ms: 2000, inserted: 2,
      finished_at: "2026-10-09T12:00:02.000Z",
    });
  });

  it("encerra um 429 contínuo após 3 tentativas e 4 segundos de espera", async () => {
    const connection = await connect("rate-limit-always");
    const pending = sync(connection.id);
    await vi.advanceTimersByTimeAsync(1999);
    expect(provider.fetchPosts).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.fetchPosts).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(provider.fetchPosts).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    const run = await complete(await pending, 503);
    expect(provider.fetchPosts).toHaveBeenCalledTimes(3);
    expect(run).toMatchObject({
      status: "failed", attempts: 3, waited_ms: 4000, received: 0, inserted: 0,
      error: "attempts_exhausted", finished_at: "2026-10-09T12:00:04.000Z",
    });
    expect((await metrics(connection.id)).posts).toEqual([]);
  });

  it("não encurta a espera quando Retry-After ultrapassa o orçamento", async () => {
    const connection = await connect("retry-after-too-long");
    const run = await complete(await sync(connection.id), 503);
    expect(run).toMatchObject({
      status: "failed", attempts: 1, waited_ms: 0, received: 0, inserted: 0,
      error: "wait_budget_exceeded", finished_at: timestamp,
    });
    await vi.advanceTimersByTimeAsync(6000);
    expect(provider.fetchPosts).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect((await metrics(connection.id)).posts).toEqual([]);
  });

  it("recupera um 503 simulado depois do backoff", async () => {
    const connection = await connect("unavailable-once");
    const pending = sync(connection.id);
    await vi.advanceTimersByTimeAsync(99);
    expect(provider.fetchPosts).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    const run = await complete(await pending);
    expect(provider.fetchPosts).toHaveBeenCalledTimes(2);
    expect(run).toMatchObject({
      status: "succeeded", attempts: 2, waited_ms: 100, inserted: 2,
      finished_at: "2026-10-09T12:00:00.100Z",
    });
  });

  it("não repete uma falha simulada de autenticação", async () => {
    const connection = await connect("unauthorized");
    const run = await complete(await sync(connection.id), 502);
    expect(run).toMatchObject({
      status: "failed", attempts: 1, waited_ms: 0, received: 0, inserted: 0,
      error: "provider_rejected", finished_at: timestamp,
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(provider.fetchPosts).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect((await metrics(connection.id)).posts).toEqual([]);
  });
});
