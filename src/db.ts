import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Connection, Platform, PostSnapshot } from "./provider.ts";

export type StoredSnapshot = PostSnapshot & { fetched_at: string };

export type SyncRun = {
  id: string;
  connection_id: string;
  from: string;
  to: string;
  status: "running" | "succeeded" | "failed";
  attempts: number;
  waited_ms: number;
  received: number;
  inserted: number;
  started_at: string;
  finished_at: string | null;
  error: string | null;
};

export function openDatabase(path = ":memory:") {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      account_id TEXT NOT NULL,
      access_token TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (platform, account_id)
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      connection_id TEXT NOT NULL REFERENCES connections(id),
      post_id TEXT NOT NULL,
      published_at TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      views INTEGER NOT NULL,
      likes INTEGER NOT NULL,
      comments INTEGER NOT NULL,
      shares INTEGER NOT NULL,
      PRIMARY KEY (connection_id, post_id, captured_at)
    );
    CREATE TABLE IF NOT EXISTS syncs (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL REFERENCES connections(id),
      window_from TEXT NOT NULL,
      window_to TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      waited_ms INTEGER NOT NULL,
      received INTEGER NOT NULL,
      inserted INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error TEXT
    );
  `);
  return db;
}

export function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getConnection(db: DatabaseSync, id: string) {
  return db.prepare("SELECT * FROM connections WHERE id = ?").get(id) as Connection | undefined;
}

export function findConnection(db: DatabaseSync, platform: Platform, accountId: string) {
  return db.prepare("SELECT * FROM connections WHERE platform = ? AND account_id = ?").get(
    platform, accountId,
  ) as Connection | undefined;
}

export function saveConnection(
  db: DatabaseSync,
  input: Pick<Connection, "platform" | "account_id" | "access_token">,
  timestamp: string,
) {
  return db.prepare(`
    INSERT INTO connections (id, platform, account_id, access_token, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (platform, account_id) DO UPDATE SET access_token = excluded.access_token
    RETURNING *
  `).get(randomUUID(), input.platform, input.account_id, input.access_token, timestamp) as Connection;
}

export function saveSync(db: DatabaseSync, run: SyncRun) {
  db.prepare(`
    INSERT INTO syncs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      status = excluded.status, attempts = excluded.attempts, waited_ms = excluded.waited_ms,
      received = excluded.received, inserted = excluded.inserted,
      finished_at = excluded.finished_at, error = excluded.error
  `).run(run.id, run.connection_id, run.from, run.to, run.status, run.attempts, run.waited_ms,
    run.received, run.inserted, run.started_at, run.finished_at, run.error);
}

export function getSync(db: DatabaseSync, id: string) {
  return db.prepare(`
    SELECT id, connection_id, window_from AS "from", window_to AS "to", status,
      attempts, waited_ms, received, inserted, started_at, finished_at, error
    FROM syncs WHERE id = ?
  `).get(id) as SyncRun | undefined;
}

export function insertSnapshots(db: DatabaseSync, connectionId: string, snapshots: PostSnapshot[], fetchedAt: string) {
  const insert = db.prepare(`
    INSERT INTO snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (connection_id, post_id, captured_at) DO NOTHING
  `);
  let inserted = 0;
  for (const snapshot of snapshots) {
    inserted += Number(insert.run(connectionId, snapshot.post_id, snapshot.published_at,
      snapshot.captured_at, fetchedAt, snapshot.views, snapshot.likes, snapshot.comments,
      snapshot.shares).changes);
  }
  return inserted;
}

export function getSnapshots(db: DatabaseSync, connectionId: string, postId: string) {
  return db.prepare(`
    SELECT post_id, published_at, captured_at, fetched_at, views, likes, comments, shares
    FROM snapshots WHERE connection_id = ? AND post_id = ? ORDER BY captured_at
  `).all(connectionId, postId) as StoredSnapshot[];
}

export function getMetrics(db: DatabaseSync, connectionId: string) {
  const posts = db.prepare(`
    SELECT post_id, published_at, captured_at, fetched_at, views, likes, comments, shares
    FROM snapshots AS snapshot
    WHERE connection_id = ? AND captured_at = (
      SELECT MAX(captured_at) FROM snapshots
      WHERE connection_id = snapshot.connection_id AND post_id = snapshot.post_id
    ) ORDER BY post_id
  `).all(connectionId) as StoredSnapshot[];
  const totals = posts.reduce((total, post) => ({
    views: total.views + post.views,
    likes: total.likes + post.likes,
    comments: total.comments + post.comments,
    shares: total.shares + post.shares,
  }), { views: 0, likes: 0, comments: 0, shares: 0 });
  return { posts, totals };
}
