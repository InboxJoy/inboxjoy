import { setTimeout } from "node:timers/promises";
import type { PoolClient } from "pg";

export async function applyMigration(client: Pick<PoolClient, "query">, file: string, sql: string): Promise<void> {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await client.query("begin");
    try {
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query(sql);
      await client.query("insert into inboxjoy_schema_migrations (name) values ($1)", [file]);
      await client.query("commit");
      return;
    } catch (error) {
      await client.query("rollback");
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "55P03") {
        throw error;
      }
      if (attempt === maxAttempts) {
        throw new Error(`Migration ${file} failed after ${maxAttempts} attempts: PostgreSQL lock_timeout (5s) exceeded (55P03). Release the blocking transaction and rerun migrations.`, { cause: error });
      }
      const backoffMs = attempt * 250;
      console.warn(`Migration ${file} hit PostgreSQL lock_timeout (55P03); retrying attempt ${attempt + 1}/${maxAttempts} in ${backoffMs}ms.`);
      await setTimeout(backoffMs);
    }
  }
}
