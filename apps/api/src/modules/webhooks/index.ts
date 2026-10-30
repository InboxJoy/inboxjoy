import { verifyWebhook, webhookPayloadHash } from "@inboxjoy/composio";
import type { AppEnv } from "@inboxjoy/config";
import { ingestInboundEvent, type InboundEvent, type IngestOptions } from "@inboxjoy/core";
import type { InboxJoyDb } from "@inboxjoy/db";
import type { FastifyInstance } from "fastify";

export {
  bounceClassifications,
  classifyBounceWebhook,
  classifyReplyIntent,
  extractMailboxCandidateEmails,
  extractReplyContent,
  extractSenderEmail,
  extractSuppressibleRecipientEmails,
  isAutoReply,
  isBounceWebhook,
  isComplaintWebhook,
  isPermanentBounce,
  stripQuotedReply,
} from "@inboxjoy/core";
export type { BounceClassification, ExtractedReplyContent, ReplyIntent } from "@inboxjoy/core";
export { writeInboundReply, writeWebhookSuppressions } from "@inboxjoy/core";

type WebhookOptions = Pick<IngestOptions, "onAccountExpired" | "applySuppression"> & {
  db?: InboxJoyDb;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function registerWebhookRoutes(app: FastifyInstance, env: AppEnv, options: WebhookOptions = {}): void {
  const memorySeen = new Set<string>();

  app.post<{ Headers: { "webhook-signature"?: string; "webhook-timestamp"?: string; "webhook-id"?: string }; Body: unknown }>("/v1/webhooks/composio", { config: { rawBody: true } }, async (request, reply) => {
    if (!env.COMPOSIO_WEBHOOK_SECRET) return reply.code(503).send({ error: "Webhook integration is disabled." });
    const raw = typeof request.rawBody === "string" ? request.rawBody : request.rawBody?.toString("utf8");
    const signature = request.headers["webhook-signature"];
    const timestamp = request.headers["webhook-timestamp"];
    const webhookId = request.headers["webhook-id"];
    if (!raw || !verifyWebhook(raw, signature, webhookId, timestamp, env.COMPOSIO_WEBHOOK_SECRET)) return reply.code(401).send({ error: "Invalid webhook signature." });

    const payload = record(request.body);
    const eventId = webhookId ?? stringValue(payload.id);
    if (!eventId) return reply.code(400).send({ error: "Webhook event id is required." });
    const data = record(payload.data);
    const metadata = record(payload.metadata);
    const logId = stringValue(metadata.log_id);
    const accountId = stringValue(metadata.connected_account_id) ?? stringValue(data.id);
    const eventType = stringValue(payload.type) ?? stringValue(payload.event) ?? "unknown";
    const triggerSlug = stringValue(metadata.trigger_slug) ?? "";

    if (!options.db) {
      if (memorySeen.has(eventId)) return { received: true, duplicate: true };
      memorySeen.add(eventId);
      if (accountId && /expir|revok|disconnect/i.test(eventType)) await options.onAccountExpired?.(accountId);
      return { received: true, duplicate: false };
    }

    const event: InboundEvent = {
      provider: "composio",
      eventId,
      logId,
      payloadHash: webhookPayloadHash(raw),
      payload,
      data,
      eventType,
      triggerSlug,
      accountId,
      timestamp,
    };
    return ingestInboundEvent(options.db, event, {
      onAccountExpired: options.onAccountExpired,
      applySuppression: options.applySuppression,
      logger: request.log,
    });
  });
}
