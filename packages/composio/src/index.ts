import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { campaignMime } from "@inboxjoy/email";

export type MailProvider = "gmail" | "outlook";
export type ComposioAccount = { id: string; provider: MailProvider; email: string | null; displayName?: string };
export type FetchedReply = {
  providerMessageId?: string;
  providerThreadId?: string;
  subject?: string;
  bodyText?: string;
  from?: string;
  receivedAt?: Date;
};

export class ComposioRequestError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly retryAfter?: Date;

  constructor(status: number, body: unknown, retryAfter?: Date) {
    super(`Composio request failed (${status})`);
    this.name = "ComposioRequestError";
    this.status = status;
    this.body = body;
    this.retryAfter = retryAfter;
  }
}

export type ComposioClient = {
  enabled: boolean;
  createConnectLink(input: { authConfigId: string; userId: string; callbackUrl: string }): Promise<{ url: string; expiresAt: Date } | null>;
  getConnectedAccount(id: string): Promise<ComposioAccount | null>;
  ensureInboundMessageTrigger(input: { connectedAccountId: string; provider: MailProvider; userId: string }): Promise<{ triggerId: string; triggerSlug: string }>;
  sendEmail(input: { connectedAccountId: string; userId: string; provider: MailProvider; to: string; subject: string; body: string; html?: string; threadId?: string; from?: string; unsubscribeUrl?: string; messageId?: string; inReplyTo?: string }): Promise<{ providerMessageId?: string; providerThreadId?: string; logId?: string }>;
  fetchReplies?(input: { connectedAccountId: string; userId?: string; provider: MailProvider; senderEmail: string; threadId?: string; after?: Date }): Promise<FetchedReply[]>;
  findReply?(input: { connectedAccountId: string; userId: string; provider: MailProvider; senderEmail: string; threadId?: string; after?: Date }): Promise<boolean>;
  findSentMessage(input: { connectedAccountId: string; provider: MailProvider; recipientEmail: string; subject: string; messageId?: string; after?: Date }): Promise<"sent" | "not_sent" | "unknown">;
};


function providerTime(value: unknown): number {
  if (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))) {
    const n = Number(value);
    return n < 100_000_000_000 ? n * 1000 : n;
  }
  return typeof value === "string" ? new Date(value).getTime() : NaN;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function htmlToText(html: string): string {
  const decoded = html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:div|p|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_match, value: string) => String.fromCodePoint(Number(value)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, value: string) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'");
  return decoded
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** Thin REST client. Tokens never cross this boundary or enter application storage. */
export function createComposioClient(apiKey?: string, baseUrl = "https://backend.composio.dev/api", toolkitVersion = "20260826_00") : ComposioClient {
  const enabled = Boolean(apiKey);
  async function call(path: string, init?: RequestInit): Promise<any> {
    if (!apiKey) return null;
    const response = await fetch(`${baseUrl}${path}`, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000), headers: { "Content-Type": "application/json", "x-api-key": apiKey, ...(init?.headers ?? {}) } });
    const rawBody = await response.text();
    let body: unknown = rawBody;
    if (rawBody) {
      try { body = JSON.parse(rawBody); } catch { body = rawBody; }
    }
    if (!response.ok) {
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterSeconds = retryAfterHeader && /^\d+$/.test(retryAfterHeader) ? Number(retryAfterHeader) : undefined;
      const retryAfterDate = retryAfterHeader && retryAfterSeconds === undefined ? new Date(retryAfterHeader) : undefined;
      const retryAfter = retryAfterSeconds !== undefined
        ? new Date(Date.now() + retryAfterSeconds * 1000)
        : retryAfterDate && !Number.isNaN(retryAfterDate.getTime()) ? retryAfterDate : undefined;
      throw new ComposioRequestError(response.status, body, retryAfter);
    }
    return body;
  }
  const emailFrom = (...values: unknown[]) => values.flatMap((value) => typeof value === "string" ? [value] : []).map((value) => value.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+/i)?.[0]?.toLowerCase()).find(Boolean) ?? null;
  async function proxy(connectedAccountId: string, endpoint: string, method: "GET" | "POST", payload: Record<string, unknown> = {}): Promise<any> {
    const result = await call("/v3.1/tools/execute/proxy", { method: "POST", body: JSON.stringify({ connected_account_id: connectedAccountId, endpoint, method, ...payload }) });
    if (!result || typeof result.status !== "number") throw new Error("Unknown provider proxy result");
    if (result.status < 200 || result.status >= 300) {
      const delay = Number(result.headers?.["retry-after"]);
      throw new ComposioRequestError(result.status, result.data, Number.isFinite(delay) && delay > 0 ? new Date(Date.now() + delay * 1000) : undefined);
    }
    return result.data;
  }
  async function profileEmail(id: string, provider: MailProvider, userId?: string): Promise<string | null> {
    try {
      // Composio requires user_id alongside connected_account_id (error 1811 otherwise).
      const result = provider === "gmail"
        ? await call("/v3.1/tools/execute/GMAIL_GET_PROFILE", { method: "POST", body: JSON.stringify({ connected_account_id: id, user_id: userId, version: toolkitVersion, arguments: {} }) })
        : await call("/v3.1/tools/execute/proxy", { method: "POST", body: JSON.stringify({ connected_account_id: id, user_id: userId, endpoint: "https://graph.microsoft.com/v1.0/me", method: "GET" }) });
      if (result?.successful === false || result?.error) return null;
      const profile = result?.data ?? result;
      return emailFrom(profile?.emailAddress, profile?.mail, profile?.userPrincipalName, profile?.email, profile?.user?.email);
    } catch {
      return null;
    }
  }
  return {
    enabled,
    async createConnectLink(input) {
      if (!enabled) return null;
      const result = await call("/v3.1/connected_accounts/link", { method: "POST", body: JSON.stringify({ auth_config_id: input.authConfigId, user_id: input.userId, callback_url: input.callbackUrl }) });
      const url = result?.redirectUrl ?? result?.redirect_url ?? result?.url;
      const expiresAt = typeof result?.expires_at === "string" ? new Date(result.expires_at) : new Date(Date.now() + 10 * 60_000);
      return typeof url === "string" ? { url, expiresAt } : null;
    },
    async getConnectedAccount(id) {
      if (!enabled) return null;
      const result = await call(`/v3.1/connected_accounts/${encodeURIComponent(id)}`);
      const account = result?.connectedAccount ?? result;
      const toolkit = account?.toolkit?.slug ?? account?.appName;
      const provider = toolkit === "gmail" ? "gmail" : /outlook|office|microsoft/i.test(String(toolkit ?? "")) ? "outlook" : undefined;
      if (!provider) return null;
      const email = emailFrom(account?.email, account?.data?.email, account?.data?.emailAddress, account?.data?.mail, account?.data?.userPrincipalName, account?.params?.email)
        ?? await profileEmail(id, provider, account?.user_id ?? account?.userId);
      return { id, provider, email, displayName: account?.displayName };
    },
    async ensureInboundMessageTrigger(input) {
      if (!enabled) throw new Error("Composio is not configured");
      // Composio names these differently per toolkit: Gmail has GMAIL_NEW_GMAIL_MESSAGE,
      // Outlook's inbound trigger is OUTLOOK_MESSAGE_TRIGGER (SENT_MESSAGE is outbound).
      let triggerSlug = input.provider === "gmail" ? "GMAIL_NEW_GMAIL_MESSAGE" : "OUTLOOK_MESSAGE_TRIGGER";
      if (!triggerSlug) {
        const catalog = await call(`/v3.1/triggers_types?toolkit_slugs=${encodeURIComponent(input.provider)}&toolkit_versions=${encodeURIComponent(toolkitVersion)}&limit=100`);
        const triggers = Array.isArray(catalog?.items) ? catalog.items : [];
        const match = triggers.find((item: any) => { const slug = String(item?.slug ?? ""); return !/SENT/i.test(slug) && /NEW.*(MESSAGE|EMAIL)|MESSAGE.*RECEIVED|(?:^|_)MESSAGE_TRIGGER$/i.test(slug); });
        triggerSlug = typeof match?.slug === "string" ? match.slug : "";
      }
      if (!triggerSlug) throw new Error(`No inbound message trigger is available for ${input.provider}`);
      const result = await call(`/v3.1/trigger_instances/${encodeURIComponent(triggerSlug)}/upsert`, {
        method: "POST",
        body: JSON.stringify({ connected_account_id: input.connectedAccountId, user_id: input.userId, trigger_config: {}, toolkit_versions: { [input.provider]: toolkitVersion } }),
      });
      const triggerId = result?.trigger_id ?? result?.id;
      if (typeof triggerId !== "string") throw new Error("Composio did not return a trigger id");
      return { triggerId, triggerSlug };
    },
    async sendEmail(input) {
      if (!enabled) throw new Error("Composio is not configured");
      if (input.unsubscribeUrl) {
        const mime = campaignMime(input);
        if (input.provider === "gmail") {
          const data = await proxy(input.connectedAccountId, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", "POST", {
            body: { raw: Buffer.from(mime).toString("base64url"), ...(input.threadId ? { threadId: input.threadId } : {}) },
          });
          if (!data?.id) throw new Error("Unknown Gmail acceptance result");
          return { providerMessageId: data.id, providerThreadId: data.threadId };
        }
        // Graph's MIME sendMail expects the ASCII base64 MIME as its raw body.
        // binary_body avoids JSON quoting that string in the authentication proxy.
        const encodedMime = Buffer.from(mime).toString("base64");
        await proxy(input.connectedAccountId, "https://graph.microsoft.com/v1.0/me/sendMail", "POST", {
          binary_body: { base64: Buffer.from(encodedMime).toString("base64"), content_type: "text/plain" },
        });
        return {};
      }
      const action = input.provider === "gmail" ? "GMAIL_SEND_EMAIL" : "OUTLOOK_SEND_EMAIL";
      // These Composio actions expose one body plus is_html, not raw MIME/custom headers;
      // plaintext is retained by callers, while List-Unsubscribe remains in the body URL.
      const arguments_ = input.provider === "gmail"
        ? { recipient_email: input.to, subject: input.subject, body: input.html ?? input.body, is_html: Boolean(input.html), ...(input.threadId ? { thread_id: input.threadId } : {}) }
        : { to_email: input.to, subject: input.subject, body: input.html ?? input.body, is_html: Boolean(input.html), save_to_sent_items: true, user_id: "me" };
      const result = await call(`/v3.1/tools/execute/${action}`, { method: "POST", body: JSON.stringify({ connected_account_id: input.connectedAccountId, user_id: input.userId, version: toolkitVersion, arguments: arguments_ }) });
      if (result?.successful === false || result?.error) throw new ComposioRequestError(502, result);
      const data = result?.data ?? result;
      return { providerMessageId: data?.message_id ?? data?.id, providerThreadId: data?.thread_id ?? data?.threadId, logId: result?.log_id };
    },
    async fetchReplies(input) {
      if (!enabled) throw new Error("Composio is not configured");
      const action = input.provider === "gmail" ? "GMAIL_FETCH_EMAILS" : "OUTLOOK_LIST_MESSAGES";
      const after = input.after ? ` after:${Math.floor(input.after.getTime() / 1000)}` : "";
      const arguments_ = input.provider === "gmail"
        // max_results defaults to 1, so an unqualified call can only ever see one
        // message; bodies are omitted unless the payload is explicitly requested.
        ? { query: `from:${input.senderEmail}${after}`, max_results: 25, verbose: true, include_payload: true }
        : { search: input.senderEmail };
      const result = await call(`/v3.1/tools/execute/${action}`, { method: "POST", body: JSON.stringify({ connected_account_id: input.connectedAccountId, user_id: input.userId, version: toolkitVersion, arguments: arguments_ }) });
      if (result?.successful === false || result?.error) throw new ComposioRequestError(503, result);
      const data = result?.data ?? result;
      const messages = Array.isArray(data) ? data : Array.isArray(data?.messages) ? data.messages : Array.isArray(data?.items) ? data.items : Array.isArray(data?.value) ? data.value : Array.isArray(data?.emails) ? data.emails : undefined;
      if (!messages) throw new ComposioRequestError(503, { error: "Unrecognized reply-check response" });
      return messages.flatMap((message: any): FetchedReply[] => {
        const sender = emailFrom(
          message?.from,
          message?.sender,
          message?.from_email,
          message?.fromEmail,
          message?.sender_email,
          message?.senderEmail,
          message?.from?.emailAddress?.address,
          message?.sender?.emailAddress?.address,
        );
        const threadId = message?.thread_id ?? message?.threadId ?? message?.conversation_id ?? message?.conversationId;
        // GMAIL_FETCH_EMAILS returns messageTimestamp/messageText, which nothing
        // else in this list covers. Verified against a live response: the message
        // keys are messageId, messageText, messageTimestamp, sender, subject,
        // threadId, preview, payload.
        const receivedAt = message?.received_at ?? message?.receivedAt ?? message?.messageTimestamp ?? message?.internal_date ?? message?.internalDate ?? message?.receivedDateTime ?? message?.date;
        const isAfter = !input.after || !receivedAt || providerTime(receivedAt) >= input.after.getTime();
        const senderMatches = sender?.toLowerCase() === input.senderEmail.toLowerCase();
        const threadMatches = Boolean(input.threadId) && String(threadId ?? "") === input.threadId;
        if (!(senderMatches || threadMatches) || !isAfter) return [];

        const body = textValue(message?.message_text)
          ?? textValue(message?.messageText)
          ?? textValue(message?.preview?.body)
          ?? textValue(message?.body)
          ?? textValue(message?.text)
          ?? textValue(message?.snippet)
          ?? textValue(message?.bodyPreview)
          ?? textValue(message?.body?.content)
          ?? textValue(message?.html_body)
          ?? textValue(message?.html);
        const contentType = String(message?.body?.contentType ?? message?.body?.content_type ?? "");
        const bodyText = body && (/html/i.test(contentType) || /<\/?[a-z][\s\S]*>/i.test(body))
          ? htmlToText(body)
          : body;
        const receivedTime = providerTime(receivedAt);
        const providerMessageId = textValue(message?.message_id)
          ?? textValue(message?.messageId)
          ?? textValue(message?.id)
          ?? textValue(message?.internetMessageId);
        const providerThreadId = typeof threadId === "string" || typeof threadId === "number" ? String(threadId) : undefined;
        const subject = textValue(message?.subject) ?? textValue(message?.title);
        return [{
          ...(providerMessageId ? { providerMessageId } : {}),
          ...(providerThreadId ? { providerThreadId } : {}),
          ...(subject ? { subject } : {}),
          ...(bodyText ? { bodyText } : {}),
          ...(sender ? { from: sender } : {}),
          ...(Number.isFinite(receivedTime) ? { receivedAt: new Date(receivedTime) } : {}),
        }];
      });
    },
    async findReply(input) {
      const replies = await this.fetchReplies!(input);
      return replies.length > 0;
    },
    async findSentMessage(input) {
      // Legacy uncertain attempts have no unique Message-ID. Never infer delivery
      // from recipient/subject alone, and never automatically retry absent results.
      if (!enabled || !input.messageId || !input.after || !Number.isFinite(input.after.getTime())) return "unknown";
      try {
        if (input.provider === "gmail") {
          const q = `in:sent rfc822msgid:${input.messageId}`;
          const listed = await proxy(input.connectedAccountId, `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=10`, "GET");
          for (const item of listed?.messages ?? []) {
            const msg = await proxy(input.connectedAccountId, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=To`, "GET");
            const headers = msg?.payload?.headers ?? [];
            const header = (name: string) => headers.find((h: any) => String(h.name).toLowerCase() === name)?.value;
            if (msg.labelIds?.includes("SENT") && header("message-id") === input.messageId
              && emailFrom(header("to")) === input.recipientEmail.toLowerCase()
              && providerTime(msg.internalDate) >= input.after.getTime() - 60_000) return "sent";
          }
        } else {
          const filter = `internetMessageId eq '${input.messageId.replaceAll("'", "''")}'`;
          const data = await proxy(input.connectedAccountId, `https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages?$filter=${encodeURIComponent(filter)}&$select=internetMessageId,sentDateTime,toRecipients&$top=10`, "GET");
          if ((data?.value ?? []).some((msg: any) => msg.internetMessageId === input.messageId
            && providerTime(msg.sentDateTime) >= input.after!.getTime() - 60_000
            && msg.toRecipients?.some((r: any) => emailFrom(r.emailAddress?.address) === input.recipientEmail.toLowerCase()))) return "sent";
        }
      } catch { /* Uncertain evidence must keep the enrollment paused. */ }
      return "unknown";
    },
  };
}

export function webhookPayloadHash(raw: string): string { return createHash("sha256").update(raw).digest("hex"); }
export function signWebhook(raw: string, webhookId: string, timestamp: string, secret: string): string { return createHmac("sha256", secret).update(`${webhookId}.${timestamp}.${raw}`).digest("base64"); }
export function verifyWebhook(raw: string, signature: string | undefined, webhookId: string | undefined, timestamp: string | undefined, secret: string | undefined, maxAgeSeconds = 300): boolean {
  if (!signature || !webhookId || !timestamp || !secret || !/^\d+$/.test(timestamp)) return false;
  const age = Math.abs(Date.now() - Number(timestamp) * 1000);
  if (age > maxAgeSeconds * 1000) return false;
  const expected = signWebhook(raw, webhookId, timestamp, secret);
  const left = Buffer.from(signature.replace(/^v1,/, ""), "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
