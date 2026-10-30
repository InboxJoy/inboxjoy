import type { SmtpTransactionalMessage } from "@inboxjoy/email";
import { describe, expect, it } from "vitest";

import { loadEnv } from "../src/env.js";
import { transactionalEmailFromEnv } from "../src/transactional-email.js";

const smtpUrl = "smtps://mailer%40example.test:s3cr%3At-pass@smtp.example.test:465";
const smtp = { MAIL_SMTP_URL: smtpUrl, MAIL_FROM: "InboxJoy <hey@selfhost.example>" };

function workerEnv(overrides: NodeJS.ProcessEnv = {}) {
  return loadEnv({
    DATABASE_URL: "postgresql://localhost/inboxjoy_test",
    API_BASE_URL: "https://api.example.test",
    WEB_BASE_URL: "https://app.example.test",
    AUTH_SECRET: "worker-env-test-secret-at-least-32-characters",
    ...overrides,
  });
}

function rejection(overrides: NodeJS.ProcessEnv): string {
  try {
    workerEnv(overrides);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected the worker environment to be rejected.");
}

describe("worker system email", () => {
  it("uses Azure Communication Services when configured, even alongside SMTP", () => {
    const env = workerEnv({ AZURE_COMMUNICATION_EMAIL_ENDPOINT: "https://email.example.test", AZURE_COMMUNICATION_EMAIL_SENDER: "hello@example.test", ...smtp });
    expect(transactionalEmailFromEnv(env).provider).toBe("azure-communication-email");
  });

  it("falls back to SMTP, then to disabled", () => {
    expect(transactionalEmailFromEnv(workerEnv(smtp))).toMatchObject({ enabled: true, provider: "smtp", senderAddress: "hey@selfhost.example" });
    expect(transactionalEmailFromEnv(workerEnv()).enabled).toBe(false);
  });

  it("adds the Dubai postal line only in the cloud edition", async () => {
    async function alertText(edition?: string): Promise<string> {
      const sent: SmtpTransactionalMessage[] = [];
      const email = transactionalEmailFromEnv(workerEnv({ ...smtp, ...(edition ? { INBOXJOY_EDITION: edition } : {}) }), {
        transport: { async sendMail(message) { sent.push(message); } },
      });
      await email.sendMailboxAlert({ recipient: { email: "owner@example.test" }, mailboxEmail: "sales@example.test", reasonSentence: "The connection expired." });
      return sent[0]!.text;
    }
    expect(await alertText("cloud")).toContain("Dubai Founder HQ");
    expect(await alertText("selfhost")).not.toContain("Dubai");
    expect(await alertText()).not.toContain("Dubai");
  });

  it("validates the SMTP settings without echoing the credential", () => {
    expect(rejection({ MAIL_SMTP_URL: "https://user:s3cr%3At-pass@smtp.example.test", MAIL_FROM: "hey@selfhost.example" })).not.toContain("s3cr");
    expect(rejection({ MAIL_SMTP_URL: "https://user:s3cr%3At-pass@smtp.example.test", MAIL_FROM: "hey@selfhost.example" })).toContain("MAIL_SMTP_URL must look like");
    expect(rejection({ MAIL_SMTP_URL: smtpUrl, MAIL_FROM: "nope" })).toContain("MAIL_FROM must be an email address");
    expect(rejection({ MAIL_SMTP_URL: smtpUrl })).toContain("MAIL_SMTP_URL and MAIL_FROM must be configured together");
  });

  it("leaves founder alerts and the PostHog host off by default", () => {
    const env = workerEnv();
    expect(env.FOUNDER_ALERT_EMAIL).toBeUndefined();
    expect(env.POSTHOG_HOST).toBeUndefined();
  });
});
