import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { z } from "zod";
import { findConnection, getConnection, getMetrics, getSnapshots, getSync, saveConnection } from "./db.ts";
import { platforms } from "./provider.ts";
import type { Provider } from "./provider.ts";
import { defaultPolicy, syncMetrics, systemClock } from "./sync.ts";
import type { Clock, RetryPolicy } from "./sync.ts";

const connectionInput = z.object({
  platform: z.enum(platforms),
  account_id: z.string().trim().min(1),
  access_token: z.string().trim().min(1),
});

const windowInput = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
}).refine((window) => Date.parse(window.from) < Date.parse(window.to));

export function createApp(db: DatabaseSync, provider: Provider, policy: RetryPolicy = defaultPolicy, clock: Clock = systemClock) {
  const app = new Hono();

  app.post("/connections", async (c) => {
    const input = connectionInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "plataforma, conta e token são obrigatórios" }, 400);
    const exists = findConnection(db, input.data.platform, input.data.account_id);
    const connection = saveConnection(db, input.data, clock.now().toISOString());
    const { id, platform, account_id, created_at } = connection;
    return c.json({ id, platform, account_id, created_at }, exists ? 200 : 201);
  });

  app.post("/connections/:id/sync", async (c) => {
    const connection = getConnection(db, c.req.param("id"));
    if (!connection) return c.json({ error: "conexão não encontrada" }, 404);
    const input = windowInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "informe uma janela ISO com fuso e from anterior a to" }, 400);
    const run = await syncMetrics(db, provider, connection, input.data, policy, clock);
    return c.json(run, run.status === "succeeded" ? 200 : run.error === "provider_rejected" ? 502 : 503);
  });

  app.get("/connections/:id/metrics", (c) => {
    if (!getConnection(db, c.req.param("id"))) return c.json({ error: "conexão não encontrada" }, 404);
    return c.json(getMetrics(db, c.req.param("id")));
  });

  app.get("/connections/:id/posts/:postId/snapshots", (c) => {
    if (!getConnection(db, c.req.param("id"))) return c.json({ error: "conexão não encontrada" }, 404);
    return c.json({ snapshots: getSnapshots(db, c.req.param("id"), c.req.param("postId")) });
  });

  app.get("/syncs/:id", (c) => {
    const run = getSync(db, c.req.param("id"));
    if (!run) return c.json({ error: "sincronização não encontrada" }, 404);
    return c.json(run);
  });

  return app;
}
