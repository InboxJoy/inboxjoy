import * as React from "react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { createSmtpForm, type SmtpFormInput, type SmtpMailboxInfo } from "../lib/smtp-mailbox-form";
import { AddSmtpMailboxModal } from "../app/app/(product)/inboxes/add-smtp-mailbox-modal";

const hooks = vi.hoisted(() => ({ stateIndex: 0, refIndex: 0, states: [] as unknown[], refs: [] as { current: unknown }[] }));
const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), track: vi.fn() }));

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = hooks.stateIndex++;
    if (index >= hooks.states.length) hooks.states[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [hooks.states[index], (value: unknown) => { hooks.states[index] = value; }];
  },
  useRef: (initial: unknown) => {
    const index = hooks.refIndex++;
    hooks.refs[index] ??= { current: initial };
    return hooks.refs[index];
  },
}));
vi.mock("../lib/api", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/api")>(), apiFetch: mocks.apiFetch }));
vi.mock("../lib/analytics", () => ({ track: mocks.track }));
vi.mock("next/link", () => ({ default: "a" }));

type ElementProps = {
  children?: React.ReactNode;
  actions?: React.ReactNode;
  name?: string;
  value?: unknown;
  type?: string;
  disabled?: boolean;
  dismissible?: boolean;
  role?: string;
  "aria-invalid"?: boolean;
  autoComplete?: string;
  onChange?: (event: { target: { value: string; checked?: boolean } }) => void;
  onSubmit?: (event: { preventDefault: () => void }) => Promise<void>;
  onClose?: () => void;
  onClick?: () => void;
};

function findElement(node: React.ReactNode, matches: (element: React.ReactElement<ElementProps>) => boolean): React.ReactElement<ElementProps> | undefined {
  for (const child of React.Children.toArray(node)) {
    if (!React.isValidElement<ElementProps>(child)) continue;
    if (matches(child)) return child;
    const nested = findElement(child.props.children, matches) ?? findElement(child.props.actions, matches);
    if (nested) return nested;
  }
  return undefined;
}

function control(node: React.ReactNode, name: string): ElementProps {
  const element = findElement(node, (element) => element.props.name === name);
  expect(element, `Missing control ${name}`).toBeDefined();
  return element!.props;
}

function validForm(): SmtpFormInput {
  return { ...createSmtpForm(), email: "sender@example.com", smtp: { host: "smtp.example.com", port: "587", secure: false, username: "sender@example.com", password: "new-secret" }, imap: { host: "imap.example.com", port: "993", secure: true, username: "sender@example.com", password: "" } };
}

describe("SMTP mailbox modal interactions", () => {
  const onClose = vi.fn();
  const onConnected = vi.fn();
  const focus = vi.fn();

  function render(mailbox?: SmtpMailboxInfo) {
    hooks.stateIndex = 0;
    hooks.refIndex = 0;
    const tree = AddSmtpMailboxModal({ mailbox, onClose, onConnected });
    hooks.refs[0]!.current = { elements: { namedItem: (name: string) => new FakeControl(name) } };
    return tree;
  }

  class FakeControl {
    constructor(private readonly name: string) {}
    focus() { focus(this.name); }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    hooks.states = [];
    hooks.refs = [];
    mocks.apiFetch.mockResolvedValue({ inbox: { id: "smtp-1" } });
    vi.stubGlobal("React", React);
    vi.stubGlobal("HTMLElement", FakeControl);
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => { callback(); return 1; });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("defaults usernames to the email while preserving a custom username", () => {
    let tree = render();
    control(tree, "email").onChange!({ target: { value: "sender@example.com" } });
    tree = render();
    expect(control(tree, "smtp.username").value).toBe("sender@example.com");
    expect(control(tree, "imap.username").value).toBe("sender@example.com");
    control(tree, "smtp.username").onChange!({ target: { value: "custom-user" } });
    tree = render();
    control(tree, "email").onChange!({ target: { value: "other@example.com" } });
    tree = render();
    expect(control(tree, "smtp.username").value).toBe("custom-user");
    expect(control(tree, "imap.username").value).toBe("other@example.com");
  });

  it("focuses the first invalid field without making a request", async () => {
    const tree = render();
    await tree.props.onSubmit({ preventDefault: vi.fn() });
    expect(focus).toHaveBeenCalledWith("email");
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(control(render(), "email")["aria-invalid"]).toBe(true);
  });

  it("posts the validated payload and emits provider-only success analytics", async () => {
    let tree = render();
    hooks.states[0] = validForm();
    tree = render();
    await tree.props.onSubmit({ preventDefault: vi.fn() });
    expect(mocks.apiFetch).toHaveBeenCalledWith("/v1/inboxes/smtp", expect.objectContaining({ method: "POST" }), expect.any(String));
    const payload = JSON.parse(mocks.apiFetch.mock.calls[0]![1].body);
    expect(payload.imap.password).toBe("new-secret");
    expect(mocks.track.mock.calls).toEqual([["mailbox_connect_started", { provider: "smtp" }], ["mailbox_connect_succeeded", { provider: "smtp" }]]);
    expect(onConnected).toHaveBeenCalledOnce();
  });

  it("does not prefill saved passwords and PATCHes unchanged credentials without secrets", async () => {
    const mailbox = { id: "smtp-1", email: "sender@example.com", smtp: { host: "smtp.example.com", port: 587, secure: false, username: "sender@example.com", password: "never-render-smtp" }, imap: { host: "imap.example.com", port: 993, secure: true, username: "sender@example.com", password: "never-render-imap" } };
    const tree = render(mailbox);
    expect(control(tree, "smtp.password").value).toBeUndefined();
    expect(findElement(tree, (element) => element.props.type === "password")).toBeUndefined();
    await tree.props.onSubmit({ preventDefault: vi.fn() });
    expect(mocks.apiFetch.mock.calls[0]![0]).toBe("/v1/inboxes/smtp-1/smtp");
    expect(mocks.apiFetch.mock.calls[0]![1].method).toBe("PATCH");
    const payload = JSON.parse(mocks.apiFetch.mock.calls[0]![1].body);
    expect(payload.smtp).not.toHaveProperty("password");
    expect(payload.imap).not.toHaveProperty("password");
    expect(JSON.stringify(payload)).not.toContain("never-render");
  });

  it("opens a blank password replacement field with autocomplete off", () => {
    const mailbox = { id: "smtp-1", email: "sender@example.com" };
    const tree = render(mailbox);
    control(tree, "smtp.password").onClick!();
    const password = control(render(mailbox), "smtp.password");
    expect(password).toMatchObject({ value: "", type: "password", autoComplete: "off" });
    expect(focus).toHaveBeenCalledWith("smtp.password");
  });

  it("shows password field errors even when the replacement input is still hidden", async () => {
    const mailbox = { id: "smtp-1", email: "sender@example.com", smtp: { host: "smtp.example.com", port: 587, secure: false, username: "sender@example.com" }, imap: { host: "imap.example.com", port: 993, secure: true, username: "sender@example.com" } };
    mocks.apiFetch.mockRejectedValue(new ApiError("Replace the SMTP password.", 400, undefined, "smtp.password"));
    await render(mailbox).props.onSubmit({ preventDefault: vi.fn() });
    const tree = render(mailbox);
    expect(control(tree, "smtp.password")["aria-invalid"]).toBe(true);
    expect(findElement(tree, (element) => element.props.role === "alert")?.props.children).toBe("Replace the SMTP password.");
    expect(focus).toHaveBeenCalledWith("smtp.password");
    expect(findElement(tree, (element) => element.props.type === "password")).toBeUndefined();
  });

  it("locks controls/dismissal and prevents duplicate requests while verifying", async () => {
    let resolveRequest!: (value: unknown) => void;
    mocks.apiFetch.mockImplementation(() => new Promise((resolve) => { resolveRequest = resolve; }));
    render();
    hooks.states[0] = validForm();
    let tree = render();
    const submission = tree.props.onSubmit({ preventDefault: vi.fn() });
    tree = render();
    expect(control(tree, "email").disabled).toBe(true);
    const dialog = findElement(tree, (element) => element.props.dismissible === false)!;
    expect(dialog.props.actions).toBeDefined();
    expect(findElement(dialog.props.actions, (element) => element.props.type === "submit")?.props).toMatchObject({ disabled: true, children: "Testing connection…" });
    dialog.props.onClose!();
    expect(onClose).not.toHaveBeenCalled();
    await tree.props.onSubmit({ preventDefault: vi.fn() });
    expect(mocks.apiFetch).toHaveBeenCalledOnce();
    resolveRequest({ inbox: { id: "smtp-1" } });
    await submission;
    expect(onConnected).toHaveBeenCalledOnce();
  });

  it("surfaces API authentication errors next to the mapped field and focuses it", async () => {
    mocks.apiFetch.mockRejectedValue(new ApiError("Check the SMTP username and password.", 400, undefined, "smtp.auth"));
    render();
    hooks.states[0] = validForm();
    await render().props.onSubmit({ preventDefault: vi.fn() });
    expect(control(render(), "smtp.username")["aria-invalid"]).toBe(true);
    expect(focus).toHaveBeenCalledWith("smtp.username");
    expect(mocks.track).toHaveBeenLastCalledWith("mailbox_connect_failed", { provider: "smtp" });
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("keeps generic request failures in an alert and allows retry", async () => {
    mocks.apiFetch.mockRejectedValue(new ApiError("Please try again later.", 429));
    render();
    hooks.states[0] = validForm();
    await render().props.onSubmit({ preventDefault: vi.fn() });
    const tree = render();
    expect(findElement(tree, (element) => element.props.role === "alert")?.props.children).toBe("Please try again later.");
    expect(control(tree, "email").disabled).toBe(false);
    expect(onConnected).not.toHaveBeenCalled();
  });
});

describe("SMTP web entrypoint contracts", () => {
  const inboxPage = readFileSync(new URL("../app/app/(product)/inboxes/page.tsx", import.meta.url), "utf8");
  const wizard = readFileSync(new URL("../app/app/(product)/sequences/campaign-wizard.tsx", import.meta.url), "utf8");

  it("gates SMTP connection controls and uses the credentials editor for reconnect", () => {
    expect(inboxPage).toContain("setSmtpEnabled(data.features?.smtp === true)");
    expect(inboxPage).toContain("{smtpEnabled ? <button");
    expect(inboxPage).toContain('if (action === "reconnect" && inbox.provider === "smtp")');
    expect(inboxPage).toContain("setSmtpEditor({ mailbox: inbox })");
    expect(inboxPage).toContain('runInboxAction(event, inbox, "verify")');
    expect(inboxPage).toContain('setNotice("Mailbox connected")');
  });

  it("keeps SMTP out of wizard OAuth requests without changing OAuth success banners", () => {
    const connectBranch = wizard.slice(wizard.indexOf("const connectInbox = async"), wizard.indexOf("const advance = async"));
    expect(connectBranch).toMatch(/provider === "smtp"[\s\S]*router\.push\("\/app\/inboxes"\);\s*return;/);
    expect(wizard).toContain("setSmtpEnabled(inboxData.features?.smtp === true)");
    expect(inboxPage).toContain('connectionResult === "gmail" || connectionResult === "outlook"');
    expect(inboxPage).not.toContain('connectionResult === "smtp"');
  });
});
