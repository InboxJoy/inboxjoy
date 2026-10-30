import { setTimeout } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyMigration } from "../../../packages/db/src/migration-runner.js";

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => undefined) }));

describe("migration lock retries", () => {
  const file = "test_hot_table.sql";
  const sql = "alter table hot_table add column added text";
  const lockError = Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });

  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

  function migrationClient(failures: number, error: unknown = lockError) {
    const query = vi.fn(async (statement: string) => {
      if (statement === sql && failures-- > 0) throw error;
      return { rows: [], rowCount: 0 };
    });
    return { client: { query } as unknown as Parameters<typeof applyMigration>[0], query };
  }

  it("sets a five-second lock timeout and retries the whole rolled-back migration", async () => {
    const { client, query } = migrationClient(1);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await applyMigration(client, file, sql);
    expect(query.mock.calls.map(([statement]) => statement)).toEqual([
      "begin", "SET LOCAL lock_timeout = '5s'", sql, "rollback",
      "begin", "SET LOCAL lock_timeout = '5s'", sql,
      "insert into inboxjoy_schema_migrations (name) values ($1)", "commit",
    ]);
    expect(setTimeout).toHaveBeenCalledWith(250);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("retrying attempt 2/5"));
    expect(query).toHaveBeenCalledWith("insert into inboxjoy_schema_migrations (name) values ($1)", [file]);
    expect(query.mock.calls.some(([statement]) => statement.includes("statement_timeout"))).toBe(false);
  });

  it("succeeds on the fifth attempt without duplicating the migration record", async () => {
    const { client, query } = migrationClient(4);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(applyMigration(client, file, sql)).resolves.toBeUndefined();
    expect(query.mock.calls.filter(([statement]) => statement === sql)).toHaveLength(5);
    expect(query.mock.calls.filter(([statement]) => statement === "rollback")).toHaveLength(4);
    expect(query.mock.calls.filter(([statement]) => statement.startsWith("insert into"))).toHaveLength(1);
    expect(vi.mocked(setTimeout).mock.calls.map(([delay]) => delay)).toEqual([250, 500, 750, 1_000]);
  });

  it("fails loudly after five lock timeouts and leaves no applied record", async () => {
    const { client, query } = migrationClient(5);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(applyMigration(client, file, sql)).rejects.toMatchObject({
      message: expect.stringContaining(`Migration ${file} failed after 5 attempts`),
      cause: lockError,
    });
    expect(query.mock.calls.filter(([statement]) => statement === "rollback")).toHaveLength(5);
    expect(setTimeout).toHaveBeenCalledTimes(4);
    expect(query.mock.calls.some(([statement]) => statement.startsWith("insert into") || statement === "commit")).toBe(false);
  });

  it("rolls back without retrying non-lock failures", async () => {
    const syntaxError = Object.assign(new Error("syntax error"), { code: "42601" });
    const { client, query } = migrationClient(1, syntaxError);
    await expect(applyMigration(client, file, sql)).rejects.toBe(syntaxError);
    expect(query.mock.calls.filter(([statement]) => statement === sql)).toHaveLength(1);
    expect(query).toHaveBeenCalledWith("rollback");
    expect(setTimeout).not.toHaveBeenCalled();
  });
});
