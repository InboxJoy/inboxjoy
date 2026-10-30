import { reconcileCampaignStatus } from "@inboxjoy/core";
import type { Pool, PoolClient } from "pg";
import { logger } from "../logger.js";

export const RECONCILE_CAMPAIGN_STATUSES_QUEUE_NAME = "campaigns.reconcile-statuses";
export const CAMPAIGN_STATUS_SWEEP_LIMIT = 200;

// Finish-only housekeeping. It never restarts a campaign (that would release
// long-overdue messages with no one asking) and it stays quiet, so the first run
// after a deploy tidies old rows without a burst of notifications.
export async function reconcileCampaignStatuses(deps: { pool: Pool }): Promise<void> {
  const candidates = await deps.pool.query<{ id: string; workspace_id: string }>(`
    SELECT c.id,c.workspace_id FROM campaigns c
    WHERE c.status='active' AND c.launched_at IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM enrollments e WHERE e.workspace_id=c.workspace_id AND e.campaign_id=c.id
        AND e.status IN ('scheduled','active','paused')
    ) ORDER BY c.updated_at,c.id LIMIT $1
  `, [CAMPAIGN_STATUS_SWEEP_LIMIT]);
  let changed = 0;
  for (const campaign of candidates.rows) {
    let client: PoolClient | undefined;
    try {
      client = await deps.pool.connect();
      await client.query("BEGIN");
      const result = await reconcileCampaignStatus(client, { workspaceId: campaign.workspace_id, campaignId: campaign.id, notify: false });
      await client.query("COMMIT");
      if (result?.change) changed += 1;
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      logger.error("Campaign status reconciliation failed", { campaignId: campaign.id, workspaceId: campaign.workspace_id, error: error instanceof Error ? error.message : String(error) });
    } finally {
      client?.release();
    }
  }
  logger.info("Reconciled campaign statuses", { job: RECONCILE_CAMPAIGN_STATUSES_QUEUE_NAME, candidates: candidates.rows.length, changed });
}
