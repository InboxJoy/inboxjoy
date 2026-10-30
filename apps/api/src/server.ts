import { loadAppEnv } from "@inboxjoy/config";
import { createDb, createPgPool } from "@inboxjoy/db";
import { buildApp } from "./app.js";

const env = loadAppEnv();
const pool = createPgPool(env.DATABASE_URL, {
  max: env.DATABASE_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  applicationName: "inboxjoy-api",
});
const db = createDb(pool);

const app = await buildApp({
  env,
  db,
  readyCheck: async () => {
    const client = await pool.connect();
    try {
      await client.query("select 1");
      const heartbeat = await client.query("select 1 from worker_heartbeats where last_seen_at >= now() - interval '5 minutes' limit 1");
      if (!heartbeat.rowCount) {
        return { ready: false as const, reason: "no_worker_heartbeat" };
      }
    } finally {
      client.release();
    }
  },
});

let isClosing = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (isClosing) {
    return;
  }

  isClosing = true;
  app.log.info({ signal }, "shutting down");

  await app.close();
  await pool.end();
}

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

await app.listen({ host: env.API_HOST, port: env.API_PORT });
