import { describe, expect, it } from "vitest";

import { appendUnsubscribeFooter, createUnsubscribeToken, renderEmailHtml, SENT_VIA_INBOXJOY_URL, verifyUnsubscribeToken } from "../src/index.js";

const secret = "s".repeat(32);

describe("unsubscribe tokens", () => {
  it("round trips signed claims", () => {
    const token = createUnsubscribeToken({ workspaceId: "workspace", contactId: "contact", normalizedEmail: "lead@example.com", expiresAt: 2_000 }, secret);
    expect(verifyUnsubscribeToken(token, secret, 1_000)).toEqual({ workspaceId: "workspace", contactId: "contact", normalizedEmail: "lead@example.com", expiresAt: 2_000 });
  });

  it("rejects tampering and expiry", () => {
    const token = createUnsubscribeToken({ workspaceId: "workspace", contactId: "contact", normalizedEmail: "lead@example.com", expiresAt: 2_000 }, secret);
    expect(verifyUnsubscribeToken(`${token}x`, secret, 1_000)).toBeNull();
    expect(verifyUnsubscribeToken(token, secret, 2_001)).toBeNull();
  });

  it("adds a plain-text unsubscribe link", () => {
    expect(appendUnsubscribeFooter("Hello\n", "https://app.test/unsubscribe")).toContain("Unsubscribe: https://app.test/unsubscribe");
  });

  it("adds the sender postal address and replaces an existing footer", () => {
    const first = appendUnsubscribeFooter("Hello", "https://app.test/unsubscribe");
    const updated = appendUnsubscribeFooter(first, "https://app.test/unsubscribe", "123 Main St\nAustin, TX 78701");
    expect(updated).toContain("123 Main St\nAustin, TX 78701");
    expect(updated.match(/Prefer not to receive these emails/g)).toHaveLength(1);
  });
});

describe("renderEmailHtml", () => {
  it("renders the unsubscribe footer as a small grey linked word instead of the raw URL", () => {
    const url = "https://inboxjoy.online/api/v1/unsubscribe?token=abc.def";
    const body = appendUnsubscribeFooter("Hi Sam,\n\nQuick question.", url, "506 Example Tower\nDubai");
    const html = renderEmailHtml(body, url, undefined, "506 Example Tower\nDubai");
    expect(html).toContain(`<a href="${url}" style="color:#666">Unsubscribe</a>`);
    expect(html).toContain("font-size:12px");
    expect(html.split(url)).toHaveLength(2);
    expect(html).not.toContain("Unsubscribe:");
    expect(html).not.toContain("<img");
  });
});

describe("Sent via InboxJoy footer", () => {
  const url = "https://inboxjoy.online/api/v1/unsubscribe?token=abc.def";

  it("is added to plain text and HTML only for free-plan sends", () => {
    const free = appendUnsubscribeFooter("Hi Sam,\n\nQuick question.", url, null, { sentVia: true });
    expect(free).toContain(`Sent via InboxJoy: ${SENT_VIA_INBOXJOY_URL}`);
    const html = renderEmailHtml(free, url, undefined, null, { sentVia: true });
    expect(html).toContain(">InboxJoy</a>");
    expect(html).not.toContain("Sent via InboxJoy:");

    const paid = appendUnsubscribeFooter("Hi Sam,\n\nQuick question.", url);
    expect(paid).not.toContain("Sent via InboxJoy");
    expect(renderEmailHtml(paid, url)).not.toContain("Sent via");
  });

  it("is replaced, not duplicated, when the footer is re-applied and dropped after an upgrade", () => {
    const stored = appendUnsubscribeFooter("Hello", url, null, { sentVia: true });
    const again = appendUnsubscribeFooter(stored, url, null, { sentVia: true });
    expect(again.match(/Sent via InboxJoy/g)).toHaveLength(1);
    expect(appendUnsubscribeFooter(stored, url)).not.toContain("Sent via InboxJoy");
  });
});
