import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase, type SyncRun } from "../src/db.ts";
import { platforms, ProviderError, type Platform, type PostSnapshot, type Provider } from "../src/provider.ts";
import type { Clock } from "../src/sync.ts";

const window = { from: "2026-05-01T00:00:00.000Z", to: "2026-06-01T00:00:00.000Z" };
const policy = { maxAttempts: 3, timeoutMs: 1000, backoffMs: 100, maxWaitMs: 5000 };
const token = "private-access-token";
const firstSnapshot: PostSnapshot = {
  post_id: "post_1",
  published_at: "2026-05-10T12:00:00.000Z",
  captured_at: "2026-05-30T12:00:00.000Z",
  views: 100,
  likes: 10,
  comments: 3,
  shares: 2,
};

type PublicConnection = { id: string; platform: Platform; account_id: string; created_at: string };

describe("API de sincronização", () => {
  let db: ReturnType<typeof openDatabase>;
  let app: ReturnType<typeof createApp>;
  let fetchPosts: ReturnType<typeof vi.fn<Provider["fetchPosts"]>>;
  let now: Date;
  let clock: Clock;

  beforeEach(() => {
    db = openDatabase();
    fetchPosts = vi.fn<Provider["fetchPosts"]>().mockResolvedValue([]);
    now = new Date("2026-06-01T12:00:00.000Z");
    clock = { now: () => new Date(now), sleep: vi.fn(async () => {}) };
    app = createApp(db, { fetchPosts }, policy, clock);
  });

  afterEach(() => {
    db.close();
  });

  function post(path: string, body: unknown) {
    return app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function connect(platform: Platform = "instagram", accountId = "account_1") {
    const response = await post("/connections", { platform, account_id: accountId, access_token: token });
    expect(response.status).toBe(201);
    return await response.json() as PublicConnection;
  }

  it.each(platforms)("cadastra uma conexão %s sem devolver o token", async (platform) => {
    const connection = await connect(platform);
    expect(connection).toEqual({
      id: expect.any(String),
      platform,
      account_id: "account_1",
      created_at: now.toISOString(),
    });
    expect(JSON.stringify(connection)).not.toContain(token);
  });

  it("reautoriza a mesma conta mantendo a identidade e usa o token novo", async () => {
    const original = await connect();
    const otherPlatform = await connect("youtube");
    now = new Date("2026-06-02T12:00:00.000Z");
    const response = await post("/connections", {
      platform: "instagram",
      account_id: "account_1",
      access_token: "updated-token",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(original);
    expect(otherPlatform.id).not.toBe(original.id);

    const sync = await post(`/connections/${original.id}/sync`, window);
    expect(sync.status).toBe(200);
    expect(fetchPosts).toHaveBeenCalledWith(
      { ...original, access_token: "updated-token" },
      window,
      expect.any(AbortSignal),
    );
    expect(await sync.text()).not.toContain("updated-token");
  });

  it("devolve métricas vazias antes da primeira sincronização", async () => {
    const connection = await connect();
    const response = await app.request(`/connections/${connection.id}/metrics`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      posts: [],
      totals: { views: 0, likes: 0, comments: 0, shares: 0 },
    });
    expect(fetchPosts).not.toHaveBeenCalled();
  });

  it("normaliza a janela com offset e permite consultar o resultado persistido", async () => {
    const connection = await connect();
    const response = await post(`/connections/${connection.id}/sync`, {
      from: "2026-05-01T00:00:00-03:00",
      to: "2026-06-01T00:00:00-03:00",
    });
    expect(response.status).toBe(200);
    const run = await response.json() as SyncRun;
    expect(run).toMatchObject({
      connection_id: connection.id,
      from: "2026-05-01T03:00:00.000Z",
      to: "2026-06-01T03:00:00.000Z",
      status: "succeeded",
      attempts: 1,
      received: 0,
      inserted: 0,
      error: null,
    });
    expect(fetchPosts).toHaveBeenCalledWith(
      { ...connection, access_token: token },
      { from: run.from, to: run.to },
      expect.any(AbortSignal),
    );
    const persisted = await app.request(`/syncs/${run.id}`);
    expect(persisted.status).toBe(200);
    expect(await persisted.json()).toEqual(run);
    expect(JSON.stringify(run)).not.toContain(token);
  });

  it("persiste o histórico e soma apenas o snapshot mais recente de cada post", async () => {
    const connection = await connect();
    fetchPosts.mockResolvedValueOnce([firstSnapshot]);
    const first = await post(`/connections/${connection.id}/sync`, window);
    expect(first.status).toBe(200);
    now = new Date("2026-06-01T12:00:01.000Z");
    const newer: PostSnapshot = { ...firstSnapshot, captured_at: "2026-05-31T12:00:00.000Z", views: 40, likes: 5 };
    const other: PostSnapshot = {
      ...firstSnapshot,
      post_id: "post_2",
      views: 20,
      likes: 4,
      comments: 1,
      shares: 0,
    };
    fetchPosts.mockResolvedValueOnce([newer, other]);
    const second = await post(`/connections/${connection.id}/sync`, window);
    expect(second.status).toBe(200);

    const restarted = createApp(db, { fetchPosts }, policy, clock);
    const metrics = await restarted.request(`/connections/${connection.id}/metrics`);
    expect(metrics.status).toBe(200);
    const result = await metrics.json() as { posts: Array<PostSnapshot & { fetched_at: string }>; totals: Record<string, number> };
    expect(result.posts).toHaveLength(2);
    expect(result.posts).toEqual(expect.arrayContaining([
      { ...newer, fetched_at: now.toISOString() },
      { ...other, fetched_at: now.toISOString() },
    ]));
    expect(result.totals).toEqual({ views: 60, likes: 9, comments: 4, shares: 2 });

    const history = await restarted.request(`/connections/${connection.id}/posts/post_1/snapshots`);
    expect(history.status).toBe(200);
    const { snapshots } = await history.json() as { snapshots: Array<PostSnapshot & { fetched_at: string }> };
    expect(snapshots).toHaveLength(2);
    expect(snapshots).toEqual(expect.arrayContaining([
      { ...firstSnapshot, fetched_at: "2026-06-01T12:00:00.000Z" },
      { ...newer, fetched_at: now.toISOString() },
    ]));
    expect(fetchPosts).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(snapshots)).not.toContain(token);
  });

  it.each([
    [503, 503, 3],
    [401, 502, 1],
  ])("registra a falha %s do provedor e responde %s", async (providerStatus, responseStatus, attempts) => {
    const connection = await connect();
    fetchPosts.mockRejectedValue(new ProviderError(providerStatus));
    const response = await post(`/connections/${connection.id}/sync`, window);
    expect(response.status).toBe(responseStatus);
    const run = await response.json() as SyncRun;
    expect(run).toMatchObject({ connection_id: connection.id, status: "failed", attempts });
    expect(fetchPosts).toHaveBeenCalledTimes(attempts);
    const persisted = await app.request(`/syncs/${run.id}`);
    expect(persisted.status).toBe(200);
    expect(await persisted.json()).toEqual(run);
    expect(JSON.stringify(run)).not.toContain(token);
  });

  it.each([
    ["GET", "/connections/missing/metrics"],
    ["GET", "/connections/missing/posts/post_1/snapshots"],
    ["GET", "/syncs/missing"],
    ["POST", "/connections/missing/sync"],
  ])("responde 404 para %s %s", async (method, path) => {
    const response = method === "POST" ? await post(path, window) : await app.request(path);
    expect(response.status).toBe(404);
    expect(fetchPosts).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["array", []],
    ["objeto vazio", {}],
    ["plataforma desconhecida", { platform: "facebook", account_id: "account_1", access_token: token }],
    ["conta vazia", { platform: "instagram", account_id: "", access_token: token }],
    ["conta sem texto", { platform: "instagram", account_id: 12, access_token: token }],
    ["token vazio", { platform: "instagram", account_id: "account_1", access_token: "" }],
    ["token sem texto", { platform: "instagram", account_id: "account_1", access_token: {} }],
  ])("rejeita cadastro inválido: %s", async (_name, body) => {
    const response = await post("/connections", body);
    expect(response.status).toBe(400);
    expect(fetchPosts).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["array", []],
    ["objeto vazio", {}],
    ["sem timezone", { ...window, from: "2026-05-01T00:00:00" }],
    ["data impossível", { ...window, from: "2026-02-30T00:00:00Z" }],
    ["início sem texto", { ...window, from: 123 }],
    ["janela vazia", { from: window.from, to: window.from }],
    ["janela invertida", { from: window.to, to: window.from }],
  ])("rejeita janela inválida: %s", async (_name, body) => {
    const connection = await connect();
    const response = await post(`/connections/${connection.id}/sync`, body);
    expect(response.status).toBe(400);
    expect(fetchPosts).not.toHaveBeenCalled();
  });

  it("rejeita JSON malformado sem chamar o provedor", async () => {
    const connection = await connect();
    for (const path of ["/connections", `/connections/${connection.id}/sync`]) {
      const response = await app.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      });
      expect(response.status).toBe(400);
    }
    expect(fetchPosts).not.toHaveBeenCalled();
  });
});
