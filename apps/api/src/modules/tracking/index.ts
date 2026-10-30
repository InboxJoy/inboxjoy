import { schema, type InboxJoyDb } from "@inboxjoy/db";
import { and, eq, gte, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createHash, randomUUID } from "node:crypto";

export const trackingPathPattern = /^\/t\/[0-9a-f]{32}\.gif$/;
export const trackingGif = Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");

const userAgentLimit = 300;
const prefetchWindowMs = 10_000;
const fallbackIpHashSalt = "inboxjoy-tracking-ip-hash-v1";
const knownProxyOrScannerTokens = [
  "googleimageproxy",
  "yahoomailproxy",
  "google-read-aloud",
  "officescan",
  "proofpoint",
  "mimecast",
  "barracuda",
  "symantec",
  "cisco ironport",
  "curl",
  "python-requests",
  "go-http-client",
  "guzzlehttp",
  "facebookexternalhit",
  "slackbot",
  "telegrambot",
  "whatsapp",
  "bingbot",
  "ahrefsbot",
];

type OpenClassification = {
  bot: boolean;
  botReason?: "known_proxy_or_scanner" | "no_user_agent" | "prefetch";
};

function classifyOpen(userAgent: string, acceptedAt: Date | null, occurredAt: Date): OpenClassification {
  if (!userAgent) return { bot: true, botReason: "no_user_agent" };

  const normalizedUserAgent = userAgent.toLowerCase();
  if (knownProxyOrScannerTokens.some((token) => normalizedUserAgent.includes(token))) {
    return { bot: true, botReason: "known_proxy_or_scanner" };
  }

  if (acceptedAt && occurredAt.getTime() - acceptedAt.getTime() < prefetchWindowMs) {
    return { bot: true, botReason: "prefetch" };
  }

  // AppleWebKit plus a missing Referer is too common among interactive clients to
  // identify Apple Mail Privacy Protection reliably, so it intentionally remains human.
  return { bot: false };
}

function hashClientIp(ip: string): string {
  // AUTH_SECRET is expected in normal deployments; the fixed module salt is only a
  // fallback so a raw client IP is never persisted when neither app secret is set.
  const salt = process.env.AUTH_SECRET || process.env.BETTER_AUTH_SECRET || fallbackIpHashSalt;
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex");
}

export function registerTrackingRoutes(app: FastifyInstance, db?: InboxJoyDb): void {
  app.get<{ Params: { token: string } }>("/t/:token.gif", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (request, reply) => {
    const token = request.params.token.toLowerCase();
    if (db && /^[0-9a-f]{32}$/.test(token)) {
      try {
        await db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${token}))`);
          const [message] = await tx.select({ id: schema.messages.id, workspaceId: schema.messages.workspaceId, acceptedAt: schema.messages.acceptedAt }).from(schema.messages).where(eq(schema.messages.trackingToken, token)).limit(1);
          if (!message) return;
          const occurredAt = new Date();
          const cutoff = new Date(occurredAt.getTime() - 10 * 60_000);
          const [recent] = await tx.select({ id: schema.messageEvents.id }).from(schema.messageEvents).where(and(eq(schema.messageEvents.messageId, message.id), eq(schema.messageEvents.eventType, "opened"), gte(schema.messageEvents.occurredAt, cutoff))).limit(1);
          if (!recent) {
            const userAgent = request.headers["user-agent"] ?? "";
            const classification = classifyOpen(userAgent, message.acceptedAt, occurredAt);
            await tx.insert(schema.messageEvents).values({
              id: randomUUID(),
              workspaceId: message.workspaceId,
              messageId: message.id,
              eventType: "opened",
              occurredAt,
              metadata: {
                source: "tracking_pixel",
                userAgent: userAgent.slice(0, userAgentLimit),
                ipHash: hashClientIp(request.ip),
                bot: classification.bot,
                ...(classification.botReason ? { botReason: classification.botReason } : {}),
              },
            });
          }
        });
      } catch (error) {
        request.log.warn({ err: error }, "failed to record open tracking event");
      }
    }
    return reply.header("content-type", "image/gif").header("cache-control", "no-store, no-cache, must-revalidate").send(trackingGif);
  });
}
