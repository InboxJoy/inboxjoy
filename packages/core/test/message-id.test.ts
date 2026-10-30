import { describe, expect, it } from "vitest";

import { CLOUD_MESSAGE_ID_DOMAIN, messageIdDomain, rfcMessageId } from "../src/index.js";

describe("outbound Message-ID domain", () => {
  it("keeps the managed service's own domain in cloud, whatever the mailbox", () => {
    expect(CLOUD_MESSAGE_ID_DOMAIN).toBe("messages.inboxjoy.online");
    expect(messageIdDomain("cloud", "Founder@Acme.example")).toBe("messages.inboxjoy.online");
    expect(rfcMessageId("abc", "cloud", null)).toBe("<abc@messages.inboxjoy.online>");
  });

  it("uses the sending mailbox's domain in self-host", () => {
    expect(messageIdDomain("selfhost", "Founder@Mail.Acme.example")).toBe("mail.acme.example");
    expect(rfcMessageId("abc", "selfhost", "sales@acme.example")).toBe("<abc@acme.example>");
  });

  it.each([null, undefined, "", "no-at-sign", "user@localhost", "user@bad_domain.example", "user@-acme.example", "user@acmé.example"])(
    "falls back to a reserved domain for an unusable mailbox email (%s)",
    (email) => {
      expect(messageIdDomain("selfhost", email)).toBe("inboxjoy.invalid");
    },
  );

  it("produces ids the MIME builders accept", () => {
    const shape = /^<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+>$/;
    expect(rfcMessageId("4b0d6c1e-0000-4000-8000-000000000001", "selfhost", "a@b.example")).toMatch(shape);
    expect(rfcMessageId("4b0d6c1e-0000-4000-8000-000000000001", "selfhost", null)).toMatch(shape);
  });
});
