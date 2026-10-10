import { setTimeout as delay } from "node:timers/promises";
import { ProviderError } from "./provider.ts";
import type { Connection, PostSnapshot, Provider, SyncWindow } from "./provider.ts";

const posts: PostSnapshot[] = [
  {
    post_id: "post-1", published_at: "2026-10-01T12:00:00.000Z", captured_at: "2026-10-09T12:00:00.000Z",
    views: 100, likes: 10, comments: 2, shares: 1,
  },
  {
    post_id: "post-2", published_at: "2026-10-02T12:00:00.000Z", captured_at: "2026-10-09T12:00:00.000Z",
    views: 250, likes: 25, comments: 5, shares: 3,
  },
];

export class SimulatedProvider implements Provider {
  private calls = new Map<string, number>();

  async fetchPosts(connection: Connection, window: SyncWindow, signal: AbortSignal) {
    const key = `${connection.id}:${connection.access_token}`;
    const attempt = (this.calls.get(key) ?? 0) + 1;
    this.calls.set(key, attempt);
    switch (connection.access_token) {
      case "timeout-once":
        if (attempt === 1) await delay(60_000, undefined, { signal });
        break;
      case "rate-limit-once":
        if (attempt === 1) throw new ProviderError(429, "2");
        break;
      case "rate-limit-always":
        throw new ProviderError(429, "2");
      case "retry-after-too-long":
        throw new ProviderError(429, "6");
      case "unavailable-once":
        if (attempt === 1) throw new ProviderError(503);
        break;
      case "unauthorized":
        throw new ProviderError(401);
    }
    const snapshots = posts.filter((post) => post.published_at >= window.from && post.published_at < window.to);
    return connection.access_token === "duplicates" ? [...snapshots, ...snapshots] : snapshots;
  }
}
