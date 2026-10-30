import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSmtpMailClient } from "../src/index.js";

describe.skipIf(!process.env.SMTP_TEST_HOST)("live SMTP sending and IMAP Sent reconciliation", () => {
  it("sends a campaign with pinned MIME headers and finds its Sent copy", async () => {
    const host = process.env.SMTP_TEST_HOST!;
    const username = process.env.SMTP_TEST_USERNAME;
    const password = process.env.SMTP_TEST_PASSWORD;
    const to = process.env.SMTP_TEST_TO;
    if (!username || !password || !to) throw new Error("Live SMTP tests require SMTP_TEST_USERNAME, SMTP_TEST_PASSWORD and SMTP_TEST_TO.");
    const from = process.env.SMTP_TEST_FROM ?? username;
    const messageId = `<${randomUUID()}@${from.split("@")[1]}>`;
    const client = createSmtpMailClient({
      smtp: { host, port: Number(process.env.SMTP_TEST_PORT ?? 587), secure: process.env.SMTP_TEST_SECURE === "true", username, password },
      imap: {
        host: process.env.IMAP_TEST_HOST ?? host, port: Number(process.env.IMAP_TEST_PORT ?? 993),
        secure: process.env.IMAP_TEST_SECURE !== "false",
        username: process.env.IMAP_TEST_USERNAME ?? username, password: process.env.IMAP_TEST_PASSWORD ?? password,
      },
    });
    try {
      await expect(client.sendEmail({
        connectedAccountId: "smtp-live", userId: "smtp-live", provider: "smtp", from, to,
        subject: "InboxJoy SMTP phase 4 live test", body: "Opt-in campaign delivery test.",
        html: "<p>Opt-in campaign delivery test.</p>", messageId,
        unsubscribeUrl: "https://app.example.com/unsubscribe?smtp-live-test=1",
      })).resolves.toEqual({ providerMessageId: messageId, providerThreadId: messageId });
      await expect(client.findSentMessage({
        connectedAccountId: "smtp-live", provider: "smtp", recipientEmail: to,
        subject: "InboxJoy SMTP phase 4 live test", messageId,
      })).resolves.toBe("sent");
    } finally {
      client.close();
    }
  }, 90_000);
});
