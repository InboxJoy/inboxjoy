export type MailboxProvider = "gmail" | "outlook" | "smtp";

export const mailboxProviderLabels: Record<MailboxProvider, string> = {
  gmail: "Gmail",
  outlook: "Outlook",
  smtp: "SMTP/IMAP",
};

export type SmtpConnectionInfo = {
  host: string;
  port: number;
  secure: boolean;
  username: string;
};

export type SmtpMailboxInfo = {
  id: string;
  email: string | null;
  displayName?: string;
  smtp?: SmtpConnectionInfo;
  imap?: SmtpConnectionInfo;
};

type ConnectionForm = {
  host: string;
  port: string;
  secure: boolean;
  username: string;
  password: string;
};

export type SmtpFormInput = {
  email: string;
  displayName: string;
  smtp: ConnectionForm;
  imap: ConnectionForm;
  useSamePassword: boolean;
  replaceSmtpPassword: boolean;
  replaceImapPassword: boolean;
};

export type SmtpFormField = "email" | "displayName" | `${"smtp" | "imap"}.${keyof ConnectionForm}`;
export type SmtpFormErrors = Partial<Record<SmtpFormField, string>>;
export type SmtpMailboxPayload = {
  email: string;
  displayName?: string;
  smtp: SmtpConnectionInfo & { password?: string };
  imap: SmtpConnectionInfo & { password?: string };
};

export function createSmtpForm(mailbox?: SmtpMailboxInfo): SmtpFormInput {
  const email = mailbox?.email ?? "";
  const connection = (kind: "smtp" | "imap"): ConnectionForm => ({
    host: mailbox?.[kind]?.host ?? "",
    port: String(mailbox?.[kind]?.port ?? (kind === "smtp" ? 587 : 993)),
    secure: mailbox?.[kind]?.secure ?? kind === "imap",
    username: mailbox?.[kind]?.username ?? email,
    password: "",
  });
  return {
    email,
    displayName: mailbox?.displayName ?? "",
    smtp: connection("smtp"),
    imap: connection("imap"),
    useSamePassword: true,
    replaceSmtpPassword: !mailbox,
    replaceImapPassword: !mailbox,
  };
}

export function validateSmtpForm(input: SmtpFormInput, editMode = false, loaded?: SmtpMailboxInfo): { errors: SmtpFormErrors; payload: SmtpMailboxPayload | null } {
  const errors: SmtpFormErrors = {};
  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) errors.email = "Enter a valid email address.";
  if (displayName.length > 160) errors.displayName = "Use 160 characters or fewer.";

  // A changed host/port/username must not silently reuse the stored password against a
  // different server — mirror the API's parseConnection re-entry requirement here so the
  // user sees the same message before submitting, not only after a round trip.
  const connectionChanged = (kind: "smtp" | "imap"): boolean => {
    const original = loaded?.[kind];
    if (!original) return false;
    const connection = input[kind];
    const port = Number(connection.port.trim());
    return connection.host.trim().toLowerCase() !== original.host || port !== original.port || connection.username.trim() !== original.username;
  };
  const smtpChanged = connectionChanged("smtp");
  const imapChanged = connectionChanged("imap");
  const smtpPasswordNeeded = !editMode || input.replaceSmtpPassword || smtpChanged || (input.useSamePassword && imapChanged);
  const imapPasswordNeeded = input.useSamePassword ? smtpPasswordNeeded : !editMode || input.replaceImapPassword || imapChanged;
  for (const kind of ["smtp", "imap"] as const) {
    const connection = input[kind];
    const port = Number(connection.port.trim());
    if (!connection.host.trim() || connection.host.trim().length > 253) errors[`${kind}.host`] = "Enter a valid mail host.";
    if (!/^\d+$/.test(connection.port.trim()) || !Number.isInteger(port) || !(kind === "smtp" ? [587, 465, 25, 2525] : [993, 143]).includes(port)) {
      errors[`${kind}.port`] = kind === "smtp" ? "Use port 587, 465, 25, or 2525." : "Use port 993 or 143.";
    }
    if (!connection.username.trim() || connection.username.trim().length > 320) errors[`${kind}.username`] = "Enter a mail username.";
    const passwordNeeded = kind === "smtp" ? smtpPasswordNeeded : imapPasswordNeeded;
    const passwordField = kind === "imap" && input.useSamePassword ? "smtp.password" : `${kind}.password` as const;
    const password = kind === "imap" && input.useSamePassword ? input.smtp.password : connection.password;
    // Both connections can write the same `smtp.password` field (shared-password mode), so the
    // "changed" reason must be keyed off the field being written, not the current loop's kind —
    // otherwise an unrelated unchanged connection overwrites the message with the generic one.
    const changedWithoutReplace = editMode && (passwordField === "smtp.password" ? smtpChanged || (input.useSamePassword && imapChanged) : imapChanged);
    if (passwordNeeded && !password.trim()) errors[passwordField] = changedWithoutReplace ? "Re-enter the password to change the server or username." : "Enter an app password (up to 4096 characters).";
    else if (passwordNeeded && password.length > 4096) errors[passwordField] = "Enter an app password (up to 4096 characters).";
  }
  if (Object.keys(errors).length) return { errors, payload: null };

  const connectionPayload = (kind: "smtp" | "imap"): SmtpConnectionInfo & { password?: string } => ({
    host: input[kind].host.trim().toLowerCase(),
    port: Number(input[kind].port.trim()),
    secure: input[kind].secure,
    username: input[kind].username.trim(),
    ...((kind === "smtp" ? smtpPasswordNeeded : imapPasswordNeeded)
      ? { password: kind === "imap" && input.useSamePassword ? input.smtp.password : input[kind].password }
      : {}),
  });
  return {
    errors,
    payload: { email, ...(displayName ? { displayName } : {}), smtp: connectionPayload("smtp"), imap: connectionPayload("imap") },
  };
}

export function smtpFormErrorField(field: string | undefined, useSamePassword: boolean): SmtpFormField | null {
  if (field === "email" || field === "displayName") return field;
  for (const kind of ["smtp", "imap"] as const) {
    if (field === kind) return `${kind}.host`;
    if (field === `${kind}.auth`) return `${kind}.username`;
    if (field === `${kind}.tls`) return `${kind}.secure`;
    for (const name of ["host", "port", "secure", "username", "password"] as const) {
      if (field === `${kind}.${name}`) return field === "imap.password" && useSamePassword ? "smtp.password" : `${kind}.${name}`;
    }
  }
  return null;
}
