import { createPgPool } from "@inboxjoy/db";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

import { applyMigration } from "../../../packages/db/src/migration-runner.js";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("migration lock timeout against PostgreSQL", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test", { max: 3 });
  afterAll(async () => { await pool.end(); });

  it("times out behind a live table lock, rolls back, and retries successfully", async () => {
    const schemaName = `migration_lock_${randomUUID().replaceAll("-", "")}`;
    const client = await pool.connect();
    const blocker = await pool.connect();
    const warning = vi.spyOn(console, "warn");
    try {
      await client.query(`create schema "${schemaName}"`);
      await client.query(`set search_path to "${schemaName}"`);
      await client.query("create table inboxjoy_schema_migrations (name text primary key, applied_at timestamptz not null default now())");
      await client.query("create table hot_table (id integer primary key)");
      await blocker.query("begin");
      await blocker.query(`lock table "${schemaName}".hot_table in access share mode`);
      const retryObserved = new Promise<void>((resolve) => {
        warning.mockImplementation(() => resolve());
      });
      const query = vi.spyOn(client, "query");
      const startedAt = Date.now();
      const applying = applyMigration(client, "blocked.sql", "alter table hot_table add column added text");
      try {
        await Promise.race([retryObserved, applying.then(() => { throw new Error("Migration unexpectedly completed without a lock timeout."); })]);
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4_500);
        expect(warning).toHaveBeenCalledWith(expect.stringContaining("55P03"));
        await blocker.query("rollback");
        await applying;
        expect(query.mock.calls.filter(([statement]) => statement === "begin")).toHaveLength(2);
        expect(query.mock.calls.filter(([statement]) => statement === "rollback")).toHaveLength(1);
        expect(query.mock.calls.filter(([statement]) => statement === "commit")).toHaveLength(1);
        expect((await client.query("select name from inboxjoy_schema_migrations")).rows).toEqual([{ name: "blocked.sql" }]);
        expect((await client.query("select added from hot_table")).rows).toEqual([]);
      } finally {
        await blocker.query("rollback").catch(() => undefined);
        await applying.catch(() => undefined);
        query.mockRestore();
      }
    } finally {
      warning.mockRestore();
      await blocker.query("rollback").catch(() => undefined);
      await client.query("rollback").catch(() => undefined);
      await client.query("reset search_path");
      await client.query(`drop schema if exists "${schemaName}" cascade`);
      blocker.release();
      client.release();
    }
  }, 20_000);
});
