import { loadAppEnv } from "@inboxjoy/config";
import { describe, expect, it } from "vitest";

describe("SMTP API environment", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const parse = (overrides: NodeJS.ProcessEnv = {}) => loadAppEnv({ DATABASE_URL: "postgresql://localhost/inboxjoy_test", ...overrides });

  it("defaults flags off and parses true/false correctly", () => {
    expect(parse()).toMatchObject({ SMTP_MAILBOXES_ENABLED: false, SMTP_ALLOW_PRIVATE_HOSTS: false });
    expect(parse({ SMTP_MAILBOXES_ENABLED: "false", SMTP_ALLOW_PRIVATE_HOSTS: "false" })).toMatchObject({ SMTP_MAILBOXES_ENABLED: false, SMTP_ALLOW_PRIVATE_HOSTS: false });
    expect(parse({ SMTP_MAILBOXES_ENABLED: "true", SMTP_ALLOW_PRIVATE_HOSTS: "true", MAILBOX_CREDENTIALS_KEY: key })).toMatchObject({ SMTP_MAILBOXES_ENABLED: true, SMTP_ALLOW_PRIVATE_HOSTS: true, MAILBOX_CREDENTIALS_KEY: key });
    expect(() => parse({ SMTP_MAILBOXES_ENABLED: "invalid" })).toThrow();
  });

  it("requires a current key when enabled and validates both keys", () => {
    expect(() => parse({ SMTP_MAILBOXES_ENABLED: "true" })).toThrow();
    expect(() => parse({ SMTP_MAILBOXES_ENABLED: "true", MAILBOX_CREDENTIALS_KEY_PREVIOUS: key })).toThrow();
    for (const name of ["MAILBOX_CREDENTIALS_KEY", "MAILBOX_CREDENTIALS_KEY_PREVIOUS"] as const) {
      for (const invalid of ["not-base64", Buffer.alloc(16).toString("base64"), `${key}!`]) {
        expect(() => parse({ [name]: invalid })).toThrow();
      }
      expect(parse({ [name]: key })[name]).toBe(key);
    }
  });
});
