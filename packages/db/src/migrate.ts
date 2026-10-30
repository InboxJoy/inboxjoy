import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createPgPool } from "./index.js";
import { applyMigration } from "./migration-runner.js";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const pool = createPgPool(connectionString, {
  max: 2,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  applicationName: "inboxjoy-migrate",
});
const client = await pool.connect();

try {
  await client.query("select pg_advisory_lock(hashtext('inboxjoy-schema-migrations'))");
  await client.query("SET lock_timeout = '5s'");
  await client.query(`
    create table if not exists inboxjoy_schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const files = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const existing = await client.query<{ name: string }>(
      "select name from inboxjoy_schema_migrations where name = $1",
      [file],
    );

    if (existing.rowCount) {
      continue;
    }

    const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");

    await applyMigration(client, file, sql);
    console.info(`Applied ${file}`);
  }
} finally {
  await client.query("select pg_advisory_unlock(hashtext('inboxjoy-schema-migrations'))").catch(() => undefined);
  client.release();
  await pool.end();
}
