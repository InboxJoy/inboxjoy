import type { ComposioClient } from "@inboxjoy/composio";
import { MailboxCredentialsError, readMailboxCredentials, type MailClient, type MailboxProvider } from "@inboxjoy/core";
import { createSmtpMailClient, type SmtpMailClient } from "./client.js";
import { SmtpSendError } from "./errors.js";

export type MailClientResolverDependencies = {
  db: Parameters<typeof readMailboxCredentials>[0];
  keys?: Map<number, Buffer>;
  composio: ComposioClient;
  smtpFactory?: typeof createSmtpMailClient;
  now?: () => Date;
  ttlMs?: number;
  allowPrivateHosts?: boolean;
};

export type MailClientResolver = {
  getMailClientFor(mailbox: { provider: MailboxProvider; emailAccountId: string }): Promise<MailClient>;
  close(): void;
};

type CachedClient = { client: SmtpMailClient; expiresAt: number; timer: ReturnType<typeof setTimeout>; keyVersion: number; verifiedAt: number | null };

export function createMailClientResolver(deps: MailClientResolverDependencies): MailClientResolver {
  const now = deps.now ?? (() => new Date());
  const ttlMs = deps.ttlMs ?? 5 * 60_000;
  const smtpFactory = deps.smtpFactory ?? createSmtpMailClient;
  const cache = new Map<string, CachedClient>();
  const pending = new Map<string, Promise<SmtpMailClient>>();
  const composio = deps.composio as unknown as MailClient;
  let closed = false;

  // Graceful eviction for TTL expiry and credential invalidation: the entry already stopped
  // being reachable through the cache by the time this runs, but the client itself may still
  // have a send or IMAP lookup in flight, so it is retired (closes once idle) rather than
  // force-closed. Never used for resolver shutdown — see forceDispose.
  function retireEntry(entry: CachedClient): void {
    clearTimeout(entry.timer);
    void entry.client.retire().catch(() => {});
  }

  // Hard shutdown path used only by resolver.close(): closes every cached client immediately,
  // aborting any in-flight work, matching the pre-existing synchronous close() contract that
  // apps/worker's shutdown() relies on.
  function forceDispose(entry: CachedClient): void {
    clearTimeout(entry.timer);
    try { entry.client.close(); } catch {}
  }

  // Cheap, indexed-by-primary-key metadata check so a cached client never outlives the
  // credentials it was built from. Saving a mailbox (new password, host or username) and
  // re-verifying both stamp verified_at; a key rotation changes key_version. updated_at is
  // not used because every IMAP poll bumps it. This never decrypts secrets (it reuses the
  // no-secrets overload of readMailboxCredentials).
  async function credentialsChanged(emailAccountId: string, cached: CachedClient): Promise<boolean> {
    try {
      const row = await readMailboxCredentials(deps.db, emailAccountId);
      return row !== undefined && (row.keyVersion !== cached.keyVersion || (row.verifiedAt?.getTime() ?? null) !== cached.verifiedAt);
    } catch {
      return false;
    }
  }

  function unavailableCredentials(): SmtpSendError {
    return new SmtpSendError("SMTP mailbox credentials are unavailable.", { stage: "auth", code: "EAUTH" });
  }

  async function load(emailAccountId: string): Promise<SmtpMailClient> {
    const keys = deps.keys;
    if (!keys?.size) throw unavailableCredentials();
    let credentials;
    try {
      credentials = await readMailboxCredentials(deps.db, emailAccountId, { includeSecrets: true, keys });
    } catch (error) {
      if (error instanceof MailboxCredentialsError) throw unavailableCredentials();
      throw new SmtpSendError("SMTP mailbox credentials could not be read.", { stage: "connect", code: "ECONNECTION" });
    }
    if (!credentials || !keys.has(credentials.keyVersion) || !credentials.smtp.password || !credentials.imap.password) throw unavailableCredentials();
    if (closed) throw new SmtpSendError("Mail client resolver is closed.", { stage: "connect", code: "ECONNECTION" });
    let client: SmtpMailClient;
    try {
      client = smtpFactory({ smtp: { ...credentials.smtp, allowPrivateHosts: deps.allowPrivateHosts }, imap: { ...credentials.imap, allowPrivateHosts: deps.allowPrivateHosts }, now });
    } catch {
      throw new SmtpSendError("SMTP mail client could not be created.", { stage: "connect" });
    }
    const entry: CachedClient = {
      client,
      expiresAt: now().getTime() + ttlMs,
      keyVersion: credentials.keyVersion,
      verifiedAt: credentials.verifiedAt?.getTime() ?? null,
      timer: setTimeout(() => {
        if (cache.get(emailAccountId) !== entry) return;
        cache.delete(emailAccountId);
        retireEntry(entry);
      }, ttlMs),
    };
    entry.timer.unref();
    cache.set(emailAccountId, entry);
    return client;
  }

  return {
    async getMailClientFor(mailbox) {
      if (closed) throw new SmtpSendError("Mail client resolver is closed.", { stage: "connect", code: "ECONNECTION" });
      if (mailbox.provider !== "smtp") return composio;
      const cached = cache.get(mailbox.emailAccountId);
      if (cached) {
        const expired = cached.expiresAt <= now().getTime();
        const stale = !expired && await credentialsChanged(mailbox.emailAccountId, cached);
        if (expired || stale) {
          if (cache.get(mailbox.emailAccountId) === cached) cache.delete(mailbox.emailAccountId);
          retireEntry(cached);
        } else {
          return cached.client;
        }
      }
      const inFlight = pending.get(mailbox.emailAccountId);
      if (inFlight) return inFlight;
      const loading = load(mailbox.emailAccountId);
      pending.set(mailbox.emailAccountId, loading);
      try {
        return await loading;
      } finally {
        if (pending.get(mailbox.emailAccountId) === loading) pending.delete(mailbox.emailAccountId);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      for (const entry of cache.values()) forceDispose(entry);
      cache.clear();
      pending.clear();
    },
  };
}
