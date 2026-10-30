import { describe, expect, it } from "vitest";

import { loadEnv, resolveWorkerEdition } from "../src/env.js";

function workerEnv(overrides: NodeJS.ProcessEnv = {}) {
  return loadEnv({
    DATABASE_URL: "postgresql://localhost/inboxjoy_test",
    API_BASE_URL: "https://api.example.test",
    AUTH_SECRET: "worker-env-test-secret-at-least-32-characters",
    ...overrides,
  });
}

describe("worker database pool configuration", () => {
  it("defaults to the per-replica application and queue pool budgets", () => {
    expect(workerEnv().DATABASE_POOL_MAX).toBe(4);
    expect(workerEnv().QUEUE_POOL_MAX).toBe(5);
  });

  it("coerces positive overrides and rejects invalid ceilings", () => {
    expect(workerEnv({ DATABASE_POOL_MAX: "3" }).DATABASE_POOL_MAX).toBe(3);
    expect(workerEnv({ QUEUE_POOL_MAX: "6" }).QUEUE_POOL_MAX).toBe(6);
    expect(() => workerEnv({ DATABASE_POOL_MAX: "0" })).toThrow();
    expect(() => workerEnv({ QUEUE_POOL_MAX: "0" })).toThrow();
  });
});

describe("SMTP worker environment", () => {
  const parse = workerEnv;
  const key = Buffer.alloc(32, 7).toString("base64");
  it("defaults flags off and coerces true/false correctly", () => {
    expect(parse().SMTP_MAILBOXES_ENABLED).toBe(false);
    expect(parse().SMTP_ALLOW_PRIVATE_HOSTS).toBe(false);
    expect(parse({ SMTP_MAILBOXES_ENABLED: "false", SMTP_ALLOW_PRIVATE_HOSTS: "false" }).SMTP_MAILBOXES_ENABLED).toBe(false);
    expect(parse({ SMTP_MAILBOXES_ENABLED: "true", SMTP_ALLOW_PRIVATE_HOSTS: "true", MAILBOX_CREDENTIALS_KEY: key })).toMatchObject({ SMTP_MAILBOXES_ENABLED: true, SMTP_ALLOW_PRIVATE_HOSTS: true, MAILBOX_CREDENTIALS_KEY: key });
    expect(() => parse({ SMTP_MAILBOXES_ENABLED: "not-a-boolean" })).toThrow();
  });

  it("requires a current key when enabled and validates both key lengths and encoding", () => {
    expect(() => parse({ SMTP_MAILBOXES_ENABLED: "true" })).toThrow();
    expect(() => parse({ SMTP_MAILBOXES_ENABLED: "true", MAILBOX_CREDENTIALS_KEY_PREVIOUS: key })).toThrow();
    for (const name of ["MAILBOX_CREDENTIALS_KEY", "MAILBOX_CREDENTIALS_KEY_PREVIOUS"]) {
      expect(() => parse({ [name]: "not-base64" })).toThrow();
      expect(() => parse({ [name]: Buffer.alloc(16).toString("base64") })).toThrow();
      expect(() => parse({ [name]: `${key}!` })).toThrow();
      expect(parse({ [name]: key })[name as "MAILBOX_CREDENTIALS_KEY"]).toBe(key);
    }
  });
});

describe("worker edition", () => {
  it("defaults to self-host outside production and reads an explicit edition", () => {
    expect(resolveWorkerEdition(workerEnv())).toBe("selfhost");
    expect(resolveWorkerEdition(workerEnv({ INBOXJOY_EDITION: "" }))).toBe("selfhost");
    expect(resolveWorkerEdition(workerEnv({ INBOXJOY_EDITION: "cloud" }))).toBe("cloud");
  });

  it("refuses to boot in production without one", () => {
    expect(() => workerEnv({ NODE_ENV: "production" })).toThrow(/INBOXJOY_EDITION/);
    expect(resolveWorkerEdition(workerEnv({ NODE_ENV: "production", INBOXJOY_EDITION: "cloud" }))).toBe("cloud");
  });
});
