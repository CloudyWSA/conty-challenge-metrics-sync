import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { openDatabase } from "./db.ts";
import { SimulatedProvider } from "./simulated-provider.ts";

const db = openDatabase(process.env.DB_PATH ?? "data/metrics.sqlite");
const port = Number(process.env.PORT ?? 3004);

serve({ fetch: createApp(db, new SimulatedProvider()).fetch, port }, (info) => {
  console.log(`métricas em http://127.0.0.1:${info.port}`);
});
