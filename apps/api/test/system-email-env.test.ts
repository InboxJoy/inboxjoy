import { loadAppEnv } from "@inboxjoy/config";
import type { SmtpTransactionalMessage } from "@inboxjoy/email";
import { describe, expect, it } from "vitest";

import { transactionalEmailFromEnv } from "../src/auth.js";

const smtpUrl = "smtps://mailer%40example.test:s3cr%3At-pass@smtp.example.test:465";
const acs = {
  AZURE_COMMUNICATION_EMAIL_ENDPOINT: "https://email.example.test",
  AZURE_COMMUNICATION_EMAIL_SENDER: "hello@example.test",
};
const smtp = { MAIL_SMTP_URL: smtpUrl, MAIL_FROM: "InboxJoy <hey@selfhost.example>" };

function parse(overrides: NodeJS.ProcessEnv = {}) {
  return loadAppEnv({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://localhost/inboxjoy_test",
    WEB_BASE_URL: "https://app.example.test",
    ...overrides,
  });
}

function parseError(overrides: NodeJS.ProcessEnv): string {
  try {
    parse(overrides);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected the environment to be rejected.");
}

describe("system email in production", () => {
  const production = { NODE_ENV: "production", INBOXJOY_EDITION: "selfhost" };

  it("refuses to boot the cloud edition with neither Azure Communication Services nor SMTP", () => {
    expect(parseError({ ...production, INBOXJOY_EDITION: "cloud" })).toContain("System email is required");
  });

  it("boots a self-hosted install without system email, with it switched off", () => {
    expect(transactionalEmailFromEnv(parse(production)).enabled).toBe(false);
  });

  it("boots with Azure Communication Services only, as our cloud does today", () => {
    const env = parse({ ...production, INBOXJOY_EDITION: "cloud", ...acs });
    expect(transactionalEmailFromEnv(env).provider).toBe("azure-communication-email");
  });

  it("boots with SMTP only, as a self-hosted install does", () => {
    const env = parse({ ...production, ...smtp, MAIL_REPLY_TO: "support@selfhost.example" });
    expect(env).toMatchObject({ MAIL_SMTP_URL: smtpUrl, MAIL_FROM: "InboxJoy <hey@selfhost.example>", MAIL_REPLY_TO: "support@selfhost.example" });
    expect(transactionalEmailFromEnv(env)).toMatchObject({ enabled: true, provider: "smtp", senderAddress: "hey@selfhost.example" });
  });

  it("prefers Azure Communication Services when both are configured", () => {
    expect(transactionalEmailFromEnv(parse({ ...production, ...acs, ...smtp })).provider).toBe("azure-communication-email");
  });

  it("stays disabled outside production when nothing is configured", () => {
    expect(transactionalEmailFromEnv(parse()).enabled).toBe(false);
  });
});

describe("SMTP system email settings", () => {
  it("accepts smtp and smtps URLs and a bare or named From address", () => {
    expect(parse({ MAIL_SMTP_URL: "smtp://relay.example.test:587", MAIL_FROM: "hey@selfhost.example" }).MAIL_SMTP_URL).toBe("smtp://relay.example.test:587");
    expect(parse(smtp).MAIL_FROM).toBe("InboxJoy <hey@selfhost.example>");
  });

  it("rejects malformed URLs without echoing the credential", () => {
    for (const invalid of ["https://user:s3cr%3At-pass@smtp.example.test", "smtps://", "not a url s3cr:t-pass"]) {
      const message = parseError({ MAIL_SMTP_URL: invalid, MAIL_FROM: "hey@selfhost.example" });
      expect(message).toContain("MAIL_SMTP_URL must look like");
      expect(message).not.toContain("s3cr");
    }
  });

  it("rejects a malformed From address or reply-to", () => {
    expect(parseError({ MAIL_SMTP_URL: smtpUrl, MAIL_FROM: "not-an-address" })).toContain("MAIL_FROM must be an email address");
    expect(parseError({ MAIL_SMTP_URL: smtpUrl, MAIL_FROM: "InboxJoy <hey@selfhost.example>\r\nBcc: x@example.test" })).toContain("MAIL_FROM must be an email address");
    expect(() => parse({ ...smtp, MAIL_REPLY_TO: "nope" })).toThrow();
  });

  it("requires MAIL_SMTP_URL and MAIL_FROM together", () => {
    expect(parseError({ MAIL_SMTP_URL: smtpUrl })).toContain("MAIL_SMTP_URL and MAIL_FROM must be configured together");
    expect(parseError({ MAIL_FROM: "hey@selfhost.example" })).toContain("MAIL_SMTP_URL and MAIL_FROM must be configured together");
  });
});

describe("cloud-only email branding", () => {
  async function welcomeText(overrides: NodeJS.ProcessEnv): Promise<{ text: string; html: string }> {
    const sent: SmtpTransactionalMessage[] = [];
    const email = transactionalEmailFromEnv(parse({ ...smtp, ...overrides }), {
      transport: { async sendMail(message) { sent.push(message); } },
    });
    await email.sendWelcome({ recipient: { email: "new@example.test" } });
    return { text: sent[0]!.text, html: sent[0]!.html };
  }

  it("adds the Dubai postal line only for the cloud edition", async () => {
    const cloud = await welcomeText({ INBOXJOY_EDITION: "cloud" });
    expect(cloud.text).toContain("Dubai Founder HQ");
    expect(cloud.html).toContain("Dubai Founder HQ");

    for (const selfhost of [await welcomeText({ INBOXJOY_EDITION: "selfhost" }), await welcomeText({})]) {
      expect(selfhost.text).not.toContain("Dubai");
      expect(selfhost.html).not.toContain("Dubai");
    }
  });

  it("serves the logo from WEB_BASE_URL", async () => {
    const { html } = await welcomeText({ WEB_BASE_URL: "https://mail.selfhost.example" });
    expect(html).toContain(`src="https://mail.selfhost.example/brand/icon-64x64.png"`);
    expect(html).not.toContain("inboxjoy.online");
  });
});

describe("off-by-default operator settings", () => {
  it("leaves founder alerts and the PostHog host unset unless configured", () => {
    const env = parse();
    expect(env.FOUNDER_ALERT_EMAIL).toBeUndefined();
    expect(env.POSTHOG_HOST).toBeUndefined();
    expect(parse({ FOUNDER_ALERT_EMAIL: "founder@example.test", POSTHOG_HOST: "https://j.example.test" })).toMatchObject({
      FOUNDER_ALERT_EMAIL: "founder@example.test",
      POSTHOG_HOST: "https://j.example.test",
    });
  });
});

describe("OpenAI-compatible AI settings", () => {
  it("accepts a key and model with an optional base URL", () => {
    const openai = parse({ AI_API_KEY: "sk-test", AI_MODEL: "gpt-4.1-mini" });
    expect(openai).toMatchObject({ AI_API_KEY: "sk-test", AI_MODEL: "gpt-4.1-mini" });
    expect(openai.AI_BASE_URL).toBeUndefined();
    expect(parse({ AI_API_KEY: "ollama", AI_MODEL: "llama3.1", AI_BASE_URL: "http://ollama:11434/v1" }).AI_BASE_URL).toBe("http://ollama:11434/v1");
  });

  it("requires the key and model together and a valid http(s) base URL", () => {
    expect(parseError({ AI_API_KEY: "sk-test" })).toContain("AI_API_KEY and AI_MODEL must be configured together");
    expect(parseError({ AI_MODEL: "gpt-4.1-mini" })).toContain("AI_API_KEY and AI_MODEL must be configured together");
    expect(parseError({ AI_BASE_URL: "https://openrouter.ai/api/v1" })).toContain("AI_API_KEY and AI_MODEL must be configured together");
    expect(parseError({ AI_API_KEY: "sk-test", AI_MODEL: "gpt-4.1-mini", AI_BASE_URL: "ftp://example.test" })).toContain("Must be an http or https URL");
  });
});
