import { createDb, createPgPool, type InboxJoyDb } from "@inboxjoy/db";

type WebDatabaseState = {
  db: InboxJoyDb;
  pool: ReturnType<typeof createPgPool>;
};

// Next.js caches this on globalThis so there is one pool per server process;
// the global also preserves that pool across development hot reloads.
declare global {
  var inboxJoyWebDatabase: WebDatabaseState | undefined;
}

function databasePoolMax(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 5;
}

export function getDb(): InboxJoyDb {
  if (!globalThis.inboxJoyWebDatabase) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL is required by the InboxJoy web OAuth server");

    const pool = createPgPool(databaseUrl, {
      max: databasePoolMax(process.env.DATABASE_POOL_MAX),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      applicationName: "inboxjoy-web",
    });
    globalThis.inboxJoyWebDatabase = { pool, db: createDb(pool) };
  }

  return globalThis.inboxJoyWebDatabase.db;
}

export async function closeDbForTests(): Promise<void> {
  if (!globalThis.inboxJoyWebDatabase) return;
  await globalThis.inboxJoyWebDatabase.pool.end();
  globalThis.inboxJoyWebDatabase = undefined;
}
