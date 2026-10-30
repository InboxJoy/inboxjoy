import { describe, expect, it } from "vitest";

import { MAILBOX_PROVIDERS, assertComposioProvider, isComposioProvider } from "../src/index.js";

describe("mailbox providers", () => {
  it("includes SMTP without widening managed providers", () => {
    expect(MAILBOX_PROVIDERS).toEqual(["gmail", "outlook", "smtp"]);
    expect(isComposioProvider("gmail")).toBe(true);
    expect(isComposioProvider("outlook")).toBe(true);
    expect(isComposioProvider("smtp")).toBe(false);
    expect(isComposioProvider("other")).toBe(false);
  });

  it("permits Gmail and Outlook calls", () => {
    expect(() => assertComposioProvider("gmail", "sendEmail")).not.toThrow();
    expect(() => assertComposioProvider("outlook", "sendEmail")).not.toThrow();
  });

  it("rejects unsupported providers with call-site context", () => {
    expect(() => assertComposioProvider("smtp", "send-message.sendEmail"))
      .toThrow('send-message.sendEmail: provider "smtp" is not supported by Composio (expected gmail or outlook)');
  });
});
