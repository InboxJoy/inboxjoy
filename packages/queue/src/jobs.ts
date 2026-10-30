import { z } from "zod";

export const queueNames = {
  scheduleDueMessages: "email.schedule-due-messages",
  sendMessage: "email.send-message",
  reconcileInbox: "inbox.reconcile",
  processImport: "leads.process-import",
  refreshHealth: "mailbox.refresh-health",
  pollImap: "inbox.poll-imap",
  heartbeat: "system.worker-heartbeat"
} as const;

export type QueueName = (typeof queueNames)[keyof typeof queueNames];

export const scheduleDueMessagesJobSchema = z.object({
  workspaceId: z.string().uuid().optional(),
  now: z.string().datetime().optional()
});

export const sendMessageJobSchema = z.object({
  workspaceId: z.string().uuid(),
  enrollmentId: z.string().uuid(),
  sequenceStepId: z.string().uuid(),
  idempotencyKey: z.string().min(8)
});

export const reconcileInboxJobSchema = z.object({
  workspaceId: z.string().uuid().optional(),
  mailboxId: z.string().uuid().optional(),
  since: z.string().datetime().optional()
});

export const processImportJobSchema = z.object({
  workspaceId: z.string().uuid(),
  importId: z.string().uuid()
});

export const refreshHealthJobSchema = z.object({
  workspaceId: z.string().uuid().optional(),
  mailboxId: z.string().uuid().optional()
});

export const heartbeatJobSchema = z.object({
  workerId: z.string().min(1),
  startedAt: z.string().datetime(),
  beatAt: z.string().datetime()
});

export const pollImapJobSchema = z.object({});

export const jobSchemas = {
  [queueNames.scheduleDueMessages]: scheduleDueMessagesJobSchema,
  [queueNames.sendMessage]: sendMessageJobSchema,
  [queueNames.reconcileInbox]: reconcileInboxJobSchema,
  [queueNames.processImport]: processImportJobSchema,
  [queueNames.refreshHealth]: refreshHealthJobSchema,
  [queueNames.pollImap]: pollImapJobSchema,
  [queueNames.heartbeat]: heartbeatJobSchema
} as const;

export type ScheduleDueMessagesJob = z.infer<typeof scheduleDueMessagesJobSchema>;
export type SendMessageJob = z.infer<typeof sendMessageJobSchema>;
export type ReconcileInboxJob = z.infer<typeof reconcileInboxJobSchema>;
export type ProcessImportJob = z.infer<typeof processImportJobSchema>;
export type RefreshHealthJob = z.infer<typeof refreshHealthJobSchema>;
export type HeartbeatJob = z.infer<typeof heartbeatJobSchema>;
export type PollImapJob = z.infer<typeof pollImapJobSchema>;

export type JobPayloads = {
  [queueNames.scheduleDueMessages]: ScheduleDueMessagesJob;
  [queueNames.sendMessage]: SendMessageJob;
  [queueNames.reconcileInbox]: ReconcileInboxJob;
  [queueNames.processImport]: ProcessImportJob;
  [queueNames.refreshHealth]: RefreshHealthJob;
  [queueNames.pollImap]: PollImapJob;
  [queueNames.heartbeat]: HeartbeatJob;
};

export function validateJobPayload<Name extends QueueName>(
  name: Name,
  payload: unknown
): JobPayloads[Name] {
  return jobSchemas[name].parse(payload) as JobPayloads[Name];
}
