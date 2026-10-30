import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

export { schema };
export * from "./schema.js";

export type PgPoolOptions = {
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  applicationName?: string;
};

export function createPgPool(connectionString: string, options: PgPoolOptions = {}): Pool {
  const sslMode = new URL(connectionString).searchParams.get("sslmode");

  return new Pool({
    connectionString,
    ssl: sslMode === "require" || sslMode === "verify-full" ? { rejectUnauthorized: true } : false,
    max: options.max ?? 10,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
    application_name: options.applicationName ?? "inboxjoy",
  });
}

export function createDb(pool: Pool) {
  return drizzle(pool, { schema });
}

export type InboxJoyDb = ReturnType<typeof createDb>;
