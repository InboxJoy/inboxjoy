import { createComposioClient } from "@inboxjoy/composio";
import { assertComposioProvider, type MailClient, type MailboxProvider } from "@inboxjoy/core";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";

import { logger } from "../logger.js";
import type { MailClientFor } from "../mail-client.js";

export const BACKFILL_REPLIES_QUEUE_NAME = "inbox.backfill-replies";
export const BACKFILL_REPLIES_BATCH_SIZE = 50;

const backfillRepliesJobSchema = z.object({
  workspaceId: z.string().uuid().optional(),
  limit: z.number().int().positive().max(BACKFILL_REPLIES_BATCH_SIZE).optional(),
});

export type BackfillRepliesJob = z.infer<typeof backfillRepliesJobSchema>;

type Dependencies = {
  pool: Pool;
  composioApiKey?: string;
  toolkitVersion?: string;
  sleep?: (milliseconds: number) => Promise<void>;
  mailClientFor?: MailClientFor;
};

type BackfillCandidate = {
  workspace_id: string;
  contact_id: string;
  contact_email: string;
  enrollment_id: string;
  sequence_id: string;
  email_account_id: string;
  mailbox_user_id: string;
  provider: MailboxProvider;
  composio_connected_account_id: string;
  first_message_id: string;
  first_accepted_at: Date;
};

export function parseBackfillRepliesJob(payload: unknown): BackfillRepliesJob {
  return backfillRepliesJobSchema.parse(payload);
}

function snippetFrom(bodyText: string | undefined): string | null {
  const snippet = bodyText?.replace(/\s+/g, " ").trim();
  return snippet ? snippet.slice(0, 320) : null;
}

export async function backfillReplies(payload: BackfillRepliesJob, deps?: Dependencies): Promise<void> {
  if (!deps || (!deps.composioApiKey && !deps.mailClientFor)) {
    logger.warn("Skipping reply backfill because Composio is not configured", { job: BACKFILL_REPLIES_QUEUE_NAME });
    return;
  }
  const composio = createComposioClient(deps.composioApiKey, undefined, deps.toolkitVersion);
  if (!deps.mailClientFor && (!composio.enabled || !composio.fetchReplies)) {
    logger.warn("Skipping reply backfill because Composio reply lookup is unavailable", { job: BACKFILL_REPLIES_QUEUE_NAME });
    return;
  }

  const limit = Math.min(payload.limit ?? BACKFILL_REPLIES_BATCH_SIZE, BACKFILL_REPLIES_BATCH_SIZE);
  const candidates = await deps.pool.query<BackfillCandidate>(`
    SELECT c.workspace_id,c.id AS contact_id,c.email AS contact_email,
      e.id AS enrollment_id,e.sequence_id,e.email_account_id,
      ea.user_id AS mailbox_user_id,ea.provider,ea.composio_connected_account_id,
      first_message.id AS first_message_id,first_message.accepted_at AS first_accepted_at
    FROM contacts c
    LEFT JOIN replies r ON r.workspace_id=c.workspace_id AND r.contact_id=c.id
    JOIN LATERAL (
      SELECT candidate.id,candidate.sequence_id,candidate.email_account_id
      FROM enrollments candidate
      WHERE candidate.workspace_id=c.workspace_id
        AND candidate.contact_id=c.id
        AND candidate.email_account_id IS NOT NULL
        AND (candidate.status='replied' OR candidate.stop_reason='reply_detected')
        AND EXISTS (
          SELECT 1 FROM messages sent
          WHERE sent.enrollment_id=candidate.id AND sent.status='accepted' AND sent.accepted_at IS NOT NULL
        )
      ORDER BY candidate.stopped_at DESC NULLS LAST,candidate.updated_at DESC
      LIMIT 1
    ) e ON true
    JOIN email_accounts ea ON ea.id=e.email_account_id AND ea.workspace_id=c.workspace_id
    JOIN LATERAL (
      SELECT sent.id,sent.accepted_at
      FROM messages sent
      WHERE sent.enrollment_id=e.id AND sent.status='accepted' AND sent.accepted_at IS NOT NULL
      ORDER BY sent.accepted_at ASC
      LIMIT 1
    ) first_message ON true
    WHERE c.replied_at IS NOT NULL
      AND r.id IS NULL
      AND COALESCE(c.reply_backfill_checked_at,'-infinity'::timestamptz) < now()-interval '7 days'
      AND ($1::uuid IS NULL OR c.workspace_id=$1)
    ORDER BY c.replied_at ASC,c.id ASC
    LIMIT $2
  `, [payload.workspaceId ?? null, limit]);

  const pause = deps.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let inserted = 0;
  for (const [index, candidate] of candidates.rows.entries()) {
    try {
      const firstAcceptedAt = new Date(candidate.first_accepted_at);
      if (candidate.provider === "smtp" && !deps.mailClientFor) continue;
      const mailClient: MailClient = deps.mailClientFor
        ? await deps.mailClientFor({ provider: candidate.provider, emailAccountId: candidate.email_account_id })
        : composio as unknown as MailClient;
      if (!mailClient.enabled || !mailClient.fetchReplies) continue;
      if (candidate.provider !== "smtp") assertComposioProvider(candidate.provider, "backfill-replies.fetchReplies");
      const replies = await mailClient.fetchReplies({
        connectedAccountId: candidate.composio_connected_account_id,
        userId: candidate.mailbox_user_id,
        provider: candidate.provider,
        senderEmail: candidate.contact_email,
        after: new Date(firstAcceptedAt.getTime() - 24 * 60 * 60 * 1000),
      });
      const reply = replies
        .filter((item) => item.receivedAt && item.receivedAt.getTime() >= firstAcceptedAt.getTime())
        .sort((left, right) => left.receivedAt!.getTime() - right.receivedAt!.getTime())[0];
      if (!reply?.receivedAt) {
        await deps.pool.query("UPDATE contacts SET reply_backfill_checked_at=now() WHERE id=$1", [candidate.contact_id]);
        continue;
      }

      const result = await deps.pool.query(`
        INSERT INTO replies (
          id,workspace_id,contact_id,enrollment_id,sequence_id,email_account_id,
          in_reply_to_message_id,provider_message_id,provider_thread_id,subject,
          body_text,snippet,from_email,received_at,source,metadata
        )
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'backfill',$15::jsonb
        WHERE NOT EXISTS (
          SELECT 1 FROM replies existing
          WHERE existing.workspace_id=$2 AND existing.contact_id=$3
        )
        ON CONFLICT DO NOTHING
      `, [
        randomUUID(),
        candidate.workspace_id,
        candidate.contact_id,
        candidate.enrollment_id,
        candidate.sequence_id,
        candidate.email_account_id,
        candidate.first_message_id,
        reply.providerMessageId ?? null,
        reply.providerThreadId ?? null,
        reply.subject ?? null,
        reply.bodyText ?? null,
        snippetFrom(reply.bodyText),
        reply.from ?? candidate.contact_email,
        reply.receivedAt,
        JSON.stringify({ provider: candidate.provider }),
      ]);
      if (result.rowCount) inserted += 1;
    } catch (error) {
      logger.warn("Failed to backfill contact reply", {
        job: BACKFILL_REPLIES_QUEUE_NAME,
        workspaceId: candidate.workspace_id,
        contactId: candidate.contact_id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (index < candidates.rows.length - 1) await pause(200);
    }
  }

  logger.info("Backfilled campaign replies", {
    job: BACKFILL_REPLIES_QUEUE_NAME,
    workspaceId: payload.workspaceId,
    candidates: candidates.rowCount,
    inserted,
  });
}
