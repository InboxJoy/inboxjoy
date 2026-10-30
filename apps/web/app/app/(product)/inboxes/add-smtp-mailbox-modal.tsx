"use client";

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { Button } from "@inboxjoy/ui";
import { AppDialog } from "@/components/app-dialog";
import { ApiError, apiErrorMessage, apiFetch } from "@/lib/api";
import { track } from "@/lib/analytics";
import { createSmtpForm, smtpFormErrorField, validateSmtpForm, type SmtpFormErrors, type SmtpFormField, type SmtpMailboxInfo } from "@/lib/smtp-mailbox-form";

export function AddSmtpMailboxModal({ mailbox, onClose, onConnected }: {
  mailbox?: SmtpMailboxInfo;
  onClose: () => void;
  onConnected: () => void;
}) {
  const [input, setInput] = useState(() => createSmtpForm(mailbox));
  const [errors, setErrors] = useState<SmtpFormErrors>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement | null>(null);
  const submitting = useRef(false);

  function focusField(field: SmtpFormField) {
    const control = formRef.current?.elements.namedItem(field);
    if (control instanceof HTMLElement) control.focus();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const validated = validateSmtpForm(input, Boolean(mailbox), mailbox);
    setErrors(validated.errors);
    setError("");
    if (!validated.payload) {
      focusField(Object.keys(validated.errors)[0] as SmtpFormField);
      return;
    }
    submitting.current = true;
    setBusy(true);
    track("mailbox_connect_started", { provider: "smtp" });
    let connected = false;
    let invalidField: SmtpFormField | null = null;
    try {
      await apiFetch(mailbox ? `/v1/inboxes/${mailbox.id}/smtp` : "/v1/inboxes/smtp", {
        method: mailbox ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validated.payload),
      }, "Could not connect this mailbox.");
      track("mailbox_connect_succeeded", { provider: "smtp" });
      connected = true;
    } catch (reason) {
      track("mailbox_connect_failed", { provider: "smtp" });
      const message = apiErrorMessage(reason, "Could not connect this mailbox.");
      invalidField = smtpFormErrorField(reason instanceof ApiError ? reason.field : undefined, input.useSamePassword);
      if (invalidField) setErrors({ [invalidField]: message });
      else setError(message);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
    if (connected) onConnected();
    else if (invalidField) requestAnimationFrame(() => focusField(invalidField!));
  }

  function field(label: string, name: SmtpFormField, control: ReactNode) {
    return <label className="leads-field" key={name}>
      <span>{label}</span>
      {control}
      {errors[name] ? <small id={`${name}-error`} role="alert">{errors[name]}</small> : null}
    </label>;
  }

  function connectionFields(kind: "smtp" | "imap") {
    const connection = input[kind];
    const replacePassword = !mailbox || (kind === "smtp" ? input.replaceSmtpPassword : input.replaceImapPassword);
    const common = (name: "host" | "port" | "secure" | "username" | "password") => ({
      name: `${kind}.${name}`,
      disabled: busy,
      "aria-invalid": Boolean(errors[`${kind}.${name}`]),
      "aria-describedby": errors[`${kind}.${name}`] ? `${kind}.${name}-error` : undefined,
    });
    return <>
      <h3>{kind.toUpperCase()}{kind === "smtp" ? " · Sending" : " · Reply detection"}</h3>
      <div className="inbox-field-grid leads-individual-form">
        {field("Host", `${kind}.host`, <input {...common("host")} autoCapitalize="none" autoComplete="off" spellCheck={false} value={connection.host} onChange={(event) => setInput({ ...input, [kind]: { ...connection, host: event.target.value } })} />)}
        {field("Port", `${kind}.port`, <input {...common("port")} inputMode="numeric" type="number" value={connection.port} onChange={(event) => setInput({ ...input, [kind]: { ...connection, port: event.target.value } })} />)}
        {field("Security", `${kind}.secure`, <select {...common("secure")} value={String(connection.secure)} onChange={(event) => {
          const secure = event.target.value === "true";
          setInput({ ...input, [kind]: { ...connection, secure, port: String(kind === "smtp" ? secure ? 465 : 587 : secure ? 993 : 143) } });
        }}><option value="false">STARTTLS ({kind === "smtp" ? "587" : "143"})</option><option value="true">SSL/TLS ({kind === "smtp" ? "465" : "993"})</option></select>)}
        {field("Username", `${kind}.username`, <input {...common("username")} autoCapitalize="none" autoComplete="off" spellCheck={false} value={connection.username} onChange={(event) => setInput({ ...input, [kind]: { ...connection, username: event.target.value } })} />)}
      </div>
      {kind === "imap" ? <label className="inbox-warmup-toggle">
        <input checked={input.useSamePassword} disabled={busy} type="checkbox" onChange={(event) => setInput({ ...input, useSamePassword: event.target.checked, imap: { ...input.imap, password: "" } })} />
        <span><strong>Use same password as SMTP</strong>{mailbox ? <small>Only applies when replacing the SMTP password. Otherwise, stored passwords stay unchanged.</small> : null}</span>
      </label> : null}
      {kind !== "imap" || !input.useSamePassword ? replacePassword
        ? field(mailbox ? "Replacement password" : "Password", `${kind}.password`, <input {...common("password")} autoComplete="off" type="password" value={connection.password} onChange={(event) => setInput({ ...input, [kind]: { ...connection, password: event.target.value } })} />)
        : <div><button aria-describedby={errors[`${kind}.password`] ? `${kind}.password-error` : undefined} aria-invalid={Boolean(errors[`${kind}.password`])} className="ij-button ij-button--secondary" disabled={busy} name={`${kind}.password`} type="button" onClick={() => {
          setInput({ ...input, ...(kind === "smtp" ? { replaceSmtpPassword: true } : { replaceImapPassword: true }) });
          requestAnimationFrame(() => focusField(`${kind}.password`));
        }}>Replace password</button>{errors[`${kind}.password`] ? <p><small id={`${kind}.password-error`} role="alert">{errors[`${kind}.password`]}</small></p> : null}<p><small>Leave unchanged to keep the stored {kind.toUpperCase()} password.</small></p></div>
        : null}
    </>;
  }

  return <form aria-busy={busy} className="inbox-editor-form ph-mask" noValidate onSubmit={submit} ref={formRef}>
    <AppDialog
      actions={<Button disabled={busy} type="submit">{busy ? "Testing connection…" : mailbox ? "Reconnect mailbox" : "Connect mailbox"}</Button>}
      dismissible={!busy}
      onClose={() => { if (!submitting.current) onClose(); }}
      title={mailbox ? "Reconnect SMTP/IMAP mailbox" : "Connect SMTP/IMAP mailbox"}
    >
      {error ? <p role="alert">{error}</p> : null}
      <div className="inbox-field-grid leads-individual-form">
        {field("Email address (From)", "email", <input aria-describedby={errors.email ? "email-error" : undefined} aria-invalid={Boolean(errors.email)} autoCapitalize="none" autoComplete="off" disabled={busy} name="email" type="email" value={input.email} onChange={(event) => {
          const email = event.target.value;
          setInput({ ...input, email, smtp: { ...input.smtp, username: !input.smtp.username || input.smtp.username === input.email ? email : input.smtp.username }, imap: { ...input.imap, username: !input.imap.username || input.imap.username === input.email ? email : input.imap.username } });
        }} />)}
        {field("Display name (optional)", "displayName", <input aria-describedby={errors.displayName ? "displayName-error" : undefined} aria-invalid={Boolean(errors.displayName)} autoComplete="off" disabled={busy} name="displayName" value={input.displayName} onChange={(event) => setInput({ ...input, displayName: event.target.value })} />)}
      </div>
      {connectionFields("smtp")}
      {connectionFields("imap")}
      <p><small>Use an app password if your provider requires one. <Link href="/docs/connect-inbox">Find setup instructions</Link>.</small></p>
      {busy ? <p role="status">Testing SMTP and IMAP access. This can take about 10 seconds.</p> : null}
    </AppDialog>
  </form>;
}
