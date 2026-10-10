import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMetrics, getSnapshots, openDatabase, saveConnection } from "../src/db.ts";
import { ProviderError, type PostSnapshot, type Provider } from "../src/provider.ts";
import { syncMetrics } from "../src/sync.ts";

const timestamp = "2026-10-09T12:00:00.000Z";
const window = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-10T00:00:00.000Z" };
const policy = { maxAttempts: 3, timeoutMs: 1000, backoffMs: 100, maxWaitMs: 5000 };
let db: ReturnType<typeof openDatabase>;
let connection: ReturnType<typeof saveConnection>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(timestamp));
  db = openDatabase();
  connection = saveConnection(db, {
    platform: "instagram",
    account_id: "account-1",
    access_token: "token-1",
  }, timestamp);
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

function snapshot(overrides: Partial<PostSnapshot> = {}): PostSnapshot {
  return {
    post_id: "post-1",
    published_at: "2026-10-07T10:00:00.000Z",
    captured_at: "2026-10-09T11:00:00.000Z",
    views: 100,
    likes: 10,
    comments: 2,
    shares: 1,
    ...overrides,
  };
}

function provider(posts: PostSnapshot[] = [snapshot()]) {
  return { fetchPosts: vi.fn<Provider["fetchPosts"]>().mockResolvedValue(posts) };
}

describe("sincronização e histórico", () => {
  it("grava métricas absolutas e registra a execução", async () => {
    const source = provider();
    const run = await syncMetrics(db, source, connection, window, policy);
    expect(run).toEqual({
      id: expect.any(String),
      connection_id: connection.id,
      from: window.from,
      to: window.to,
      status: "succeeded",
      attempts: 1,
      waited_ms: 0,
      received: 1,
      inserted: 1,
      started_at: timestamp,
      finished_at: timestamp,
      error: null,
    });
    expect(source.fetchPosts).toHaveBeenCalledWith(connection, window, expect.any(AbortSignal));
    expect(getMetrics(db, connection.id)).toEqual({
      posts: [{ ...snapshot(), fetched_at: timestamp }],
      totals: { views: 100, likes: 10, comments: 2, shares: 1 },
    });
  });

  it("repetir a janela não duplica nem reescreve o snapshot original", async () => {
    await syncMetrics(db, provider(), connection, window, policy);
    const before = getMetrics(db, connection.id);
    vi.setSystemTime(new Date("2026-10-09T13:00:00.000Z"));
    const repeated = await syncMetrics(db, provider([snapshot({ views: 999 })]), connection, window, policy);
    expect(repeated.inserted).toBe(0);
    expect(repeated.received).toBe(1);
    expect(getMetrics(db, connection.id)).toEqual(before);
    expect(getSnapshots(db, connection.id, "post-1")).toHaveLength(1);
  });

  it("janelas sobrepostas somam somente o snapshot atual de cada post", async () => {
    const second = snapshot({ post_id: "post-2", views: 40, likes: 3, comments: 1, shares: 0 });
    await syncMetrics(db, provider([snapshot(), second]), connection, window, policy);
    const newer = snapshot({ captured_at: "2026-10-09T12:00:00.000Z", views: 120, likes: 12, comments: 3, shares: 2 });
    const run = await syncMetrics(db, provider([newer, second]), connection, {
      from: "2026-10-05T00:00:00.000Z",
      to: window.to,
    }, policy);
    expect(run.received).toBe(2);
    expect(run.inserted).toBe(1);
    expect(getMetrics(db, connection.id).totals).toEqual({ views: 160, likes: 15, comments: 4, shares: 2 });
    expect(getSnapshots(db, connection.id, "post-1").map((post) => post.views)).toEqual([100, 120]);
  });

  it("duas sincronizações concorrentes de janelas sobrepostas não duplicam métricas", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const source = provider();
    source.fetchPosts.mockImplementation(async () => {
      await barrier;
      return [snapshot()];
    });
    const pending = [window, { from: "2026-10-05T00:00:00.000Z", to: window.to }].map(
      (period) => syncMetrics(db, source, connection, period, policy),
    );
    expect(source.fetchPosts).toHaveBeenCalledTimes(2);
    expect(getMetrics(db, connection.id).posts).toEqual([]);
    release();
    const runs = await Promise.all(pending);
    expect(runs.map((run) => run.status)).toEqual(["succeeded", "succeeded"]);
    expect(runs.reduce((total, run) => total + run.inserted, 0)).toBe(1);
    expect(getSnapshots(db, connection.id, "post-1")).toHaveLength(1);
    expect(getMetrics(db, connection.id).totals).toEqual({ views: 100, likes: 10, comments: 2, shares: 1 });
  });

  it("guarda um snapshot atrasado sem trocar o atual e aceita métricas menores depois", async () => {
    await syncMetrics(db, provider([snapshot({ captured_at: "2026-10-09T12:00:00.000Z", views: 150 })]), connection, window, policy);
    await syncMetrics(db, provider([snapshot({ captured_at: "2026-10-09T10:00:00.000Z", views: 200 })]), connection, window, policy);
    expect(getMetrics(db, connection.id).totals.views).toBe(150);
    await syncMetrics(db, provider([snapshot({ captured_at: "2026-10-09T13:00:00.000Z", views: 80 })]), connection, window, policy);
    expect(getMetrics(db, connection.id).totals.views).toBe(80);
    expect(getSnapshots(db, connection.id, "post-1").map((post) => ({ captured_at: post.captured_at, views: post.views }))).toEqual([
      { captured_at: "2026-10-09T10:00:00.000Z", views: 200 },
      { captured_at: "2026-10-09T12:00:00.000Z", views: 150 },
      { captured_at: "2026-10-09T13:00:00.000Z", views: 80 },
    ]);
  });

  it("normaliza offsets equivalentes para não criar dois snapshots do mesmo instante", async () => {
    await syncMetrics(db, provider(), connection, window, policy);
    const run = await syncMetrics(db, provider([snapshot({
      published_at: "2026-10-07T07:00:00-03:00",
      captured_at: "2026-10-09T08:00:00-03:00",
      views: 999,
    })]), connection, window, policy);
    expect(run.inserted).toBe(0);
    expect(getSnapshots(db, connection.id, "post-1")).toHaveLength(1);
    expect(getMetrics(db, connection.id).posts[0].captured_at).toBe("2026-10-09T11:00:00.000Z");
    expect(getMetrics(db, connection.id).totals.views).toBe(100);
  });

  it("separa contas e plataformas mesmo quando o provider repete o ID do post", async () => {
    const otherAccount = saveConnection(db, { platform: "instagram", account_id: "account-2", access_token: "token-2" }, timestamp);
    const otherPlatform = saveConnection(db, { platform: "tiktok", account_id: "account-1", access_token: "token-3" }, timestamp);
    await syncMetrics(db, provider(), connection, window, policy);
    await syncMetrics(db, provider([snapshot({ views: 200 })]), otherAccount, window, policy);
    await syncMetrics(db, provider([snapshot({ views: 300 })]), otherPlatform, window, policy);
    expect(new Set([connection.id, otherAccount.id, otherPlatform.id]).size).toBe(3);
    expect(getMetrics(db, connection.id).totals.views).toBe(100);
    expect(getMetrics(db, otherAccount.id).totals.views).toBe(200);
    expect(getMetrics(db, otherPlatform.id).totals.views).toBe(300);
  });

  it("renovar a conexão mantém sua identidade e seus snapshots", async () => {
    await syncMetrics(db, provider(), connection, window, policy);
    const renewed = saveConnection(db, { platform: "instagram", account_id: "account-1", access_token: "new-token" }, "2026-10-09T13:00:00.000Z");
    expect(renewed.id).toBe(connection.id);
    expect(renewed.access_token).toBe("new-token");
    expect(getMetrics(db, renewed.id).totals.views).toBe(100);
  });

  it("filtra a janela pelo horário de publicação, incluindo início e excluindo fim", async () => {
    const posts = [
      snapshot({ post_id: "before", published_at: "2026-09-30T23:59:59.999Z" }),
      snapshot({ post_id: "start", published_at: window.from }),
      snapshot({ post_id: "inside", published_at: "2026-10-09T23:59:59.999Z" }),
      snapshot({ post_id: "end", published_at: window.to }),
    ];
    const run = await syncMetrics(db, provider(posts), connection, window, policy);
    expect(run.received).toBe(4);
    expect(run.inserted).toBe(2);
    expect(getMetrics(db, connection.id).posts.map((post) => post.post_id).sort()).toEqual(["inside", "start"]);
    expect(getSnapshots(db, connection.id, "before")).toEqual([]);
    expect(getSnapshots(db, connection.id, "end")).toEqual([]);
  });

  it("uma resposta vazia conclui a execução sem criar métricas", async () => {
    const run = await syncMetrics(db, provider([]), connection, window, policy);
    expect(run.status).toBe("succeeded");
    expect(run.received).toBe(0);
    expect(run.inserted).toBe(0);
    expect(getMetrics(db, connection.id)).toEqual({ posts: [], totals: { views: 0, likes: 0, comments: 0, shares: 0 } });
  });
});

describe("retries", () => {
  it("repete falha de rede e 5xx com backoff até obter uma resposta", async () => {
    const source = provider();
    source.fetchPosts.mockRejectedValueOnce(new Error("connection reset")).mockRejectedValueOnce(new ProviderError(503));
    const pending = syncMetrics(db, source, connection, window, policy);
    await vi.advanceTimersByTimeAsync(99);
    expect(source.fetchPosts).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(source.fetchPosts).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(source.fetchPosts).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    const run = await pending;
    expect(source.fetchPosts).toHaveBeenCalledTimes(3);
    expect(run.status).toBe("succeeded");
    expect(run.attempts).toBe(3);
    expect(run.waited_ms).toBe(300);
    expect(run.finished_at).toBe("2026-10-09T12:00:00.300Z");
    expect(run.inserted).toBe(1);
  });

  it("repete 408 antes de desistir", async () => {
    const source = provider();
    source.fetchPosts.mockRejectedValueOnce(new ProviderError(408));
    const pending = syncMetrics(db, source, connection, window, policy);
    await vi.advanceTimersByTimeAsync(100);
    const run = await pending;
    expect(run.status).toBe("succeeded");
    expect(run.attempts).toBe(2);
    expect(run.waited_ms).toBe(100);
  });

  it.each([400, 401, 403, 404])("não repete uma rejeição permanente %i", async (status) => {
    const source = provider();
    source.fetchPosts.mockRejectedValue(new ProviderError(status, "2"));
    const run = await syncMetrics(db, source, connection, window, policy);
    expect(source.fetchPosts).toHaveBeenCalledTimes(1);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("provider_rejected");
    expect(run.attempts).toBe(1);
    expect(run.waited_ms).toBe(0);
    expect(run.inserted).toBe(0);
    expect(getMetrics(db, connection.id).posts).toEqual([]);
  });

  it("limita falhas transitórias a três tentativas e registra o motivo final", async () => {
    const source = provider();
    source.fetchPosts.mockRejectedValue(new ProviderError(500));
    const pending = syncMetrics(db, source, connection, window, policy);
    await vi.advanceTimersByTimeAsync(300);
    const run = await pending;
    expect(source.fetchPosts).toHaveBeenCalledTimes(3);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("attempts_exhausted");
    expect(run.attempts).toBe(3);
    expect(run.waited_ms).toBe(300);
    expect(run.received).toBe(0);
    expect(run.inserted).toBe(0);
    expect(getMetrics(db, connection.id).posts).toEqual([]);
  });

  it("aborta cada chamada no timeout mesmo se o provider não resolver a promessa", async () => {
    const signals: AbortSignal[] = [];
    const source = provider();
    source.fetchPosts.mockImplementation((_connection, _window, signal) => {
      signals.push(signal);
      return new Promise(() => {});
    });
    const pending = syncMetrics(db, source, connection, window, { ...policy, timeoutMs: 50, backoffMs: 10, maxWaitMs: 30 });
    await vi.advanceTimersByTimeAsync(49);
    expect(signals[0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0].aborted).toBe(true);
    expect(source.fetchPosts).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9);
    expect(source.fetchPosts).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(source.fetchPosts).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120);
    const run = await pending;
    expect(source.fetchPosts).toHaveBeenCalledTimes(3);
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true, true]);
    expect(run.error).toBe("attempts_exhausted");
    expect(run.waited_ms).toBe(30);
    expect(run.finished_at).toBe("2026-10-09T12:00:00.180Z");
  });
});

describe("Retry-After e orçamento de espera", () => {
  it("espera os segundos inteiros de Retry-After sem chamar o provider antes", async () => {
    const source = provider();
    source.fetchPosts.mockRejectedValueOnce(new ProviderError(429, "2"));
    const pending = syncMetrics(db, source, connection, window, policy);
    await vi.advanceTimersByTimeAsync(1999);
    expect(source.fetchPosts).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const run = await pending;
    expect(source.fetchPosts).toHaveBeenCalledTimes(2);
    expect(run.status).toBe("succeeded");
    expect(run.waited_ms).toBe(2000);
  });

  it.each([
    "Fri, 09 Oct 2026 12:00:03 GMT",
    "Friday, 09-Oct-26 12:00:03 GMT",
    "Fri Oct  9 12:00:03 2026",
  ])("interpreta Retry-After como data HTTP %s em relação ao relógio controlado", async (retryAfter) => {
    const source = provider();
    source.fetchPosts.mockRejectedValueOnce(new ProviderError(429, retryAfter));
    const pending = syncMetrics(db, source, connection, window, policy);
    await vi.advanceTimersByTimeAsync(2999);
    expect(source.fetchPosts).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const run = await pending;
    expect(run.status).toBe("succeeded");
    expect(run.waited_ms).toBe(3000);
  });

  it.each(["0", "Fri, 09 Oct 2026 11:59:59 GMT"])("repete sem retroceder o relógio quando Retry-After é %s", async (retryAfter) => {
    const source = provider();
    source.fetchPosts.mockRejectedValueOnce(new ProviderError(429, retryAfter));
    const pending = syncMetrics(db, source, connection, window, policy);
    await vi.advanceTimersByTimeAsync(0);
    const run = await pending;
    expect(source.fetchPosts).toHaveBeenCalledTimes(2);
    expect(run.status).toBe("succeeded");
    expect(run.waited_ms).toBe(0);
    expect(run.finished_at).toBe(timestamp);
  });

  it.each([undefined, "invalid", "-1", "1.5"])("usa backoff quando Retry-After é inválido ou ausente: %s", async (retryAfter) => {
    const source = provider();
    source.fetchPosts.mockRejectedValueOnce(new ProviderError(429, retryAfter));
    const pending = syncMetrics(db, source, connection, window, policy);
    await vi.advanceTimersByTimeAsync(99);
    expect(source.fetchPosts).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const run = await pending;
    expect(run.status).toBe("succeeded");
    expect(run.waited_ms).toBe(100);
  });

  it("não encurta Retry-After quando a espera não cabe no orçamento", async () => {
    const source = provider();
    source.fetchPosts.mockRejectedValueOnce(new ProviderError(429, "6"));
    const run = await syncMetrics(db, source, connection, window, policy);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("wait_budget_exceeded");
    expect(run.waited_ms).toBe(0);
    expect(run.attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(6000);
    expect(source.fetchPosts).toHaveBeenCalledTimes(1);
  });

  it("aplica o teto à soma das esperas, sem consumir parcialmente o saldo restante", async () => {
    const source = provider();
    source.fetchPosts.mockRejectedValueOnce(new ProviderError(429, "3")).mockRejectedValueOnce(new ProviderError(429, "3"));
    const pending = syncMetrics(db, source, connection, window, policy);
    await vi.advanceTimersByTimeAsync(3000);
    const run = await pending;
    expect(run.status).toBe("failed");
    expect(run.error).toBe("wait_budget_exceeded");
    expect(run.attempts).toBe(2);
    expect(run.waited_ms).toBe(3000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(source.fetchPosts).toHaveBeenCalledTimes(2);
  });

  it("permite Retry-After exatamente igual ao teto", async () => {
    const source = provider();
    source.fetchPosts.mockRejectedValueOnce(new ProviderError(429, "5"));
    const pending = syncMetrics(db, source, connection, window, policy);
    await vi.advanceTimersByTimeAsync(4999);
    expect(source.fetchPosts).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const run = await pending;
    expect(run.status).toBe("succeeded");
    expect(run.waited_ms).toBe(5000);
  });

  it("inclui backoff de erros diferentes no mesmo teto acumulado", async () => {
    const source = provider();
    source.fetchPosts.mockRejectedValueOnce(new ProviderError(429, "5")).mockRejectedValueOnce(new ProviderError(503));
    const pending = syncMetrics(db, source, connection, window, policy);
    await vi.advanceTimersByTimeAsync(5000);
    const run = await pending;
    expect(run.status).toBe("failed");
    expect(run.error).toBe("wait_budget_exceeded");
    expect(run.attempts).toBe(2);
    expect(run.waited_ms).toBe(5000);
    expect(source.fetchPosts).toHaveBeenCalledTimes(2);
  });
});
