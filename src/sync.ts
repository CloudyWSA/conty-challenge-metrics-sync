import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { insertSnapshots, saveSync, transaction } from "./db.ts";
import type { SyncRun } from "./db.ts";
import { ProviderError } from "./provider.ts";
import type { Connection, PostSnapshot, Provider, SyncWindow } from "./provider.ts";

export type RetryPolicy = {
  maxAttempts: number;
  timeoutMs: number;
  backoffMs: number;
  maxWaitMs: number;
};

export type Clock = { now: () => Date; sleep: (ms: number) => Promise<void> };

export const defaultPolicy: RetryPolicy = {
  maxAttempts: 3,
  timeoutMs: 1000,
  backoffMs: 100,
  maxWaitMs: 5000,
};

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function retryAfterMs(header: string | undefined, now: Date): number | undefined {
  if (header === undefined) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!/^[A-Za-z]+[ ,]/.test(value)) return undefined;
  const date = Date.parse(value.endsWith("GMT") ? value : `${value} GMT`);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now.getTime());
}

async function fetchWithTimeout(provider: Provider, connection: Connection, window: SyncWindow, timeoutMs: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("provider timeout"));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([provider.fetchPosts(connection, window, controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function syncMetrics(
  db: DatabaseSync,
  provider: Provider,
  connection: Connection,
  inputWindow: SyncWindow,
  policy: RetryPolicy = defaultPolicy,
  clock: Clock = systemClock,
): Promise<SyncRun> {
  const window = {
    from: new Date(inputWindow.from).toISOString(),
    to: new Date(inputWindow.to).toISOString(),
  };
  const run: SyncRun = {
    id: randomUUID(), connection_id: connection.id, ...window, status: "running", attempts: 0,
    waited_ms: 0, received: 0, inserted: 0, started_at: clock.now().toISOString(), finished_at: null, error: null,
  };
  saveSync(db, run);
  let snapshots: PostSnapshot[] | undefined;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    run.attempts = attempt;
    saveSync(db, run);
    try {
      snapshots = await fetchWithTimeout(provider, connection, window, policy.timeoutMs);
      break;
    } catch (error) {
      const response = error instanceof ProviderError ? error : undefined;
      if (response && response.status !== 408 && response.status !== 429 && response.status < 500) {
        run.error = "provider_rejected";
        break;
      }
      if (attempt === policy.maxAttempts) {
        run.error = "attempts_exhausted";
        break;
      }
      const delay = (response?.status === 429 ? retryAfterMs(response.retryAfter, clock.now()) : undefined)
        ?? policy.backoffMs * 2 ** (attempt - 1);
      if (delay > policy.maxWaitMs - run.waited_ms) {
        run.error = "wait_budget_exceeded";
        break;
      }
      await clock.sleep(delay);
      run.waited_ms += delay;
    }
  }
  const finishedAt = clock.now().toISOString();
  run.finished_at = finishedAt;
  if (snapshots !== undefined) {
    const normalized = snapshots.map((snapshot) => ({
      ...snapshot,
      published_at: new Date(snapshot.published_at).toISOString(),
      captured_at: new Date(snapshot.captured_at).toISOString(),
    })).filter((snapshot) => snapshot.published_at >= window.from && snapshot.published_at < window.to);
    run.status = "succeeded";
    run.received = snapshots.length;
    transaction(db, () => {
      run.inserted = insertSnapshots(db, connection.id, normalized, finishedAt);
      saveSync(db, run);
    });
  } else {
    run.status = "failed";
    saveSync(db, run);
  }
  return run;
}
