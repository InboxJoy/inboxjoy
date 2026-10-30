import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../lib/api";
import { createSmtpForm, mailboxProviderLabels, smtpFormErrorField, validateSmtpForm, type SmtpFormInput } from "../lib/smtp-mailbox-form";

function validInput(): SmtpFormInput {
  return {
    ...createSmtpForm(),
    email: " Sender@Example.com ",
    displayName: " Sender Name ",
    smtp: { host: " SMTP.Example.com ", port: "587", secure: false, username: " sender@example.com ", password: " smtp-password " },
    imap: { host: " IMAP.Example.com ", port: "993", secure: true, username: " sender@example.com ", password: "" },
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("SMTP mailbox form", () => {
  it("uses secure connection defaults and the shared provider labels", () => {
    expect(createSmtpForm()).toMatchObject({ smtp: { port: "587", secure: false, password: "" }, imap: { port: "993", secure: true, password: "" }, useSamePassword: true });
    expect(mailboxProviderLabels).toEqual({ gmail: "Gmail", outlook: "Outlook", smtp: "SMTP/IMAP" });
  });

  it("normalizes non-secret values without trimming a password", () => {
    expect(validateSmtpForm(validInput())).toEqual({ errors: {}, payload: {
      email: "sender@example.com", displayName: "Sender Name",
      smtp: { host: "smtp.example.com", port: 587, secure: false, username: "sender@example.com", password: " smtp-password " },
      imap: { host: "imap.example.com", port: 993, secure: true, username: "sender@example.com", password: " smtp-password " },
    } });
  });

  it("omits an optional blank display name", () => {
    const input = validInput();
    input.displayName = "  ";
    expect(validateSmtpForm(input).payload).not.toHaveProperty("displayName");
  });

  it("orders required errors by the visible fields for first-invalid focus", () => {
    const result = validateSmtpForm(createSmtpForm());
    expect(result.payload).toBeNull();
    expect(Object.keys(result.errors)).toEqual(["email", "smtp.host", "smtp.username", "smtp.password", "imap.host", "imap.username"]);
  });

  it.each(["no-at", "sender@host", "sender @example.com", `${"a".repeat(310)}@example.com`])("rejects invalid email %s", (email) => {
    expect(validateSmtpForm({ ...validInput(), email }).errors.email).toBeDefined();
  });

  it.each(["", "abc", "587.5", "0", "65536", "1e3", "0588", "588"])("rejects an invalid SMTP port %s", (port) => {
    const input = validInput();
    input.smtp.port = port;
    expect(validateSmtpForm(input).errors["smtp.port"]).toBeDefined();
  });

  it.each([587, 465, 25, 2525])("accepts allowed SMTP port %s", (port) => {
    const input = validInput();
    input.smtp.port = ` ${port} `;
    expect(validateSmtpForm(input).payload?.smtp.port).toBe(port);
  });

  it.each([993, 143])("accepts allowed IMAP port %s", (port) => {
    const input = validInput();
    input.imap.port = String(port);
    expect(validateSmtpForm(input).payload?.imap.port).toBe(port);
  });

  it("rejects SMTP ports for IMAP", () => {
    const input = validInput();
    input.imap.port = "587";
    expect(validateSmtpForm(input).errors["imap.port"]).toBeDefined();
  });

  it("validates API boundary lengths without including supplied values in errors", () => {
    const input = validInput();
    input.displayName = "a".repeat(161);
    input.smtp.host = "a".repeat(254);
    input.smtp.username = "a".repeat(321);
    input.smtp.password = "secret".repeat(700);
    const { errors, payload } = validateSmtpForm(input);
    expect(payload).toBeNull();
    expect(Object.keys(errors)).toEqual(["displayName", "smtp.host", "smtp.username", "smtp.password"]);
    expect(JSON.stringify(errors)).not.toContain("secret");
  });

  it("requires a separate IMAP password only when not sharing the SMTP password", () => {
    const input = { ...validInput(), useSamePassword: false };
    expect(validateSmtpForm(input).errors["imap.password"]).toBeDefined();
    input.imap.password = "imap-password";
    expect(validateSmtpForm(input).payload?.imap.password).toBe("imap-password");
  });

  it("prefills only explicit non-secret fields even if the response unexpectedly has passwords", () => {
    const mailbox = {
      id: "smtp-1", email: "sender@example.com", displayName: "Sender",
      smtp: { host: "smtp.example.com", port: 465, secure: true, username: "smtp-user", password: "never-render-smtp-secret" },
      imap: { host: "imap.example.com", port: 143, secure: false, username: "imap-user", password: "never-render-imap-secret" },
    };
    const form = createSmtpForm(mailbox);
    expect(form).toMatchObject({ smtp: { host: "smtp.example.com", port: "465", secure: true, username: "smtp-user", password: "" }, imap: { host: "imap.example.com", port: "143", secure: false, username: "imap-user", password: "" }, replaceSmtpPassword: false, replaceImapPassword: false });
    expect(JSON.stringify(form)).not.toContain("never-render");
  });

  it("defaults missing edit usernames to the From address", () => {
    expect(createSmtpForm({ id: "smtp-1", email: "sender@example.com" })).toMatchObject({ smtp: { username: "sender@example.com" }, imap: { username: "sender@example.com" } });
  });

  it.each([true, false])("omits both unchanged passwords in edit mode with sharing %s", (useSamePassword) => {
    const input = { ...validInput(), useSamePassword, replaceSmtpPassword: false, replaceImapPassword: false };
    const result = validateSmtpForm(input, true);
    expect(result.errors).toEqual({});
    expect(result.payload?.smtp).not.toHaveProperty("password");
    expect(result.payload?.imap).not.toHaveProperty("password");
  });

  it("requires a replacement password once the edit affordance is selected", () => {
    const input = { ...validInput(), replaceSmtpPassword: true, replaceImapPassword: false };
    input.smtp.password = "";
    expect(validateSmtpForm(input, true).errors["smtp.password"]).toBeDefined();
  });

  it("replaces both passwords when the shared SMTP password is changed", () => {
    const result = validateSmtpForm({ ...validInput(), replaceSmtpPassword: true, replaceImapPassword: false }, true);
    expect(result.payload?.smtp.password).toBe(" smtp-password ");
    expect(result.payload?.imap.password).toBe(" smtp-password ");
  });

  it("requires the password when the host differs from the loaded mailbox, even without opting into replacement", () => {
    const loaded = { id: "smtp-1", email: "sender@example.com", smtp: { host: "smtp.example.com", port: 587, secure: false, username: "sender@example.com" }, imap: { host: "imap.example.com", port: 993, secure: true, username: "sender@example.com" } };
    const input = { ...validInput(), replaceSmtpPassword: false, replaceImapPassword: false, smtp: { ...validInput().smtp, host: "changed.example.com", password: "" } };
    const result = validateSmtpForm(input, true, loaded);
    expect(result.errors["smtp.password"]).toBe("Re-enter the password to change the server or username.");
    expect(result.payload).toBeNull();
  });

  it("requires the password when only the port or username changes from the loaded mailbox", () => {
    const loaded = { id: "smtp-1", email: "sender@example.com", smtp: { host: "smtp.example.com", port: 587, secure: false, username: "sender@example.com" } };
    const portChanged = { ...validInput(), replaceSmtpPassword: false, smtp: { ...validInput().smtp, port: "465", secure: true, password: "" } };
    expect(validateSmtpForm(portChanged, true, loaded).errors["smtp.password"]).toBe("Re-enter the password to change the server or username.");
    const usernameChanged = { ...validInput(), replaceSmtpPassword: false, smtp: { ...validInput().smtp, username: "someone-else@example.com", password: "" } };
    expect(validateSmtpForm(usernameChanged, true, loaded).errors["smtp.password"]).toBe("Re-enter the password to change the server or username.");
  });

  it("does not require a password when only `secure` changes from the loaded mailbox", () => {
    const loaded = { id: "smtp-1", email: "sender@example.com", smtp: { host: "smtp.example.com", port: 587, secure: false, username: "sender@example.com" }, imap: { host: "imap.example.com", port: 993, secure: true, username: "sender@example.com" } };
    const input = { ...validInput(), replaceSmtpPassword: false, replaceImapPassword: false, smtp: { ...validInput().smtp, secure: true, password: "" } };
    const result = validateSmtpForm(input, true, loaded);
    expect(result.errors).toEqual({});
    expect(result.payload?.smtp).not.toHaveProperty("password");
  });

  it("includes the typed password once the host changes and the replacement password is supplied", () => {
    const loaded = { id: "smtp-1", email: "sender@example.com", smtp: { host: "smtp.example.com", port: 587, secure: false, username: "sender@example.com" }, imap: { host: "imap.example.com", port: 993, secure: true, username: "sender@example.com" } };
    const input = { ...validInput(), replaceSmtpPassword: false, replaceImapPassword: false, smtp: { ...validInput().smtp, host: "changed.example.com", password: "fresh-password" } };
    const result = validateSmtpForm(input, true, loaded);
    expect(result.errors).toEqual({});
    expect(result.payload?.smtp).toMatchObject({ host: "changed.example.com", password: "fresh-password" });
  });

  it("requires the shared password when only IMAP's host changes while sharing the SMTP password", () => {
    const loaded = { id: "smtp-1", email: "sender@example.com", smtp: { host: "smtp.example.com", port: 587, secure: false, username: "sender@example.com" }, imap: { host: "imap.example.com", port: 993, secure: true, username: "sender@example.com" } };
    const input = { ...validInput(), useSamePassword: true, replaceSmtpPassword: false, replaceImapPassword: false, smtp: { ...validInput().smtp, password: "" }, imap: { ...validInput().imap, host: "changed-imap.example.com" } };
    const result = validateSmtpForm(input, true, loaded);
    expect(result.errors["smtp.password"]).toBe("Re-enter the password to change the server or username.");
    input.smtp.password = "shared-fresh-password";
    const retried = validateSmtpForm(input, true, loaded);
    expect(retried.errors).toEqual({});
    expect(retried.payload?.smtp.password).toBe("shared-fresh-password");
    expect(retried.payload?.imap.password).toBe("shared-fresh-password");
  });

  it("treats an unchanged host/port/username as not requiring a password even in edit mode", () => {
    const loaded = { id: "smtp-1", email: "sender@example.com", smtp: { host: "smtp.example.com", port: 587, secure: false, username: "sender@example.com" }, imap: { host: "imap.example.com", port: 993, secure: true, username: "sender@example.com" } };
    const input = { ...validInput(), replaceSmtpPassword: false, replaceImapPassword: false, smtp: { ...validInput().smtp, password: "" }, imap: { ...validInput().imap, password: "" } };
    const result = validateSmtpForm(input, true, loaded);
    expect(result.errors).toEqual({});
  });

  it("can replace IMAP independently while retaining the stored SMTP password", () => {
    const input = { ...validInput(), useSamePassword: false, replaceSmtpPassword: false, replaceImapPassword: true };
    input.imap.password = "new-imap-password";
    const result = validateSmtpForm(input, true);
    expect(result.payload?.smtp).not.toHaveProperty("password");
    expect(result.payload?.imap.password).toBe("new-imap-password");
  });

  it.each([
    ["email", "email"], ["displayName", "displayName"], ["smtp", "smtp.host"], ["imap", "imap.host"],
    ["smtp.auth", "smtp.username"], ["imap.auth", "imap.username"], ["smtp.tls", "smtp.secure"], ["imap.tls", "imap.secure"],
    ["smtp.port", "smtp.port"], ["imap.password", "smtp.password"], ["unknown", null],
  ])("maps API field %s to visible control %s", (field, expected) => {
    expect(smtpFormErrorField(field, true)).toBe(expected);
  });

  it("keeps a separate IMAP password error on its own control", () => {
    expect(smtpFormErrorField("imap.password", false)).toBe("imap.password");
    expect(smtpFormErrorField(undefined, true)).toBeNull();
  });

  it("preserves API 400 field errors and workspace-pinned requests", async () => {
    vi.stubGlobal("window", { sessionStorage: { getItem: () => "workspace-1" } });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "SMTP authentication failed.", field: "smtp.auth" }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(apiFetch("/v1/inboxes/smtp", { method: "POST", body: "{}" })).rejects.toMatchObject({ status: 400, field: "smtp.auth", message: "SMTP authentication failed." });
    expect((fetchMock.mock.calls[0]![1].headers as Headers).get("x-workspace-id")).toBe("workspace-1");
    expect(fetchMock.mock.calls[0]![1].credentials).toBe("include");
  });

  it.each([429, 503])("keeps non-validation errors generic at status %s", async (status) => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Try again later.", field: "smtp.password" }), { status })));
    await expect(apiFetch("/v1/inboxes/smtp")).rejects.toMatchObject({ status, field: undefined });
  });
});
