export class SmtpSendError extends Error {
  readonly code?: string;
  readonly responseCode?: number;
  readonly command?: string;
  readonly stage: "connect" | "auth" | "mail" | "data";
  readonly field: string;

  constructor(message: string, opts: { stage: SmtpSendError["stage"]; field?: string; code?: string; responseCode?: number; command?: string }) {
    super(message);
    this.name = "SmtpSendError";
    this.stage = opts.stage;
    this.field = opts.field ?? `smtp.${opts.stage === "auth" ? "auth" : "host"}`;
    this.code = opts.code;
    this.responseCode = opts.responseCode;
    this.command = opts.command;
  }
}

export class ImapError extends Error {
  readonly stage: string;
  readonly field: string;

  constructor(message: string, opts: { stage: string; field?: string }) {
    super(message);
    this.name = "ImapError";
    this.stage = opts.stage;
    this.field = opts.field ?? `imap.${opts.stage === "auth" ? "auth" : "host"}`;
  }
}
