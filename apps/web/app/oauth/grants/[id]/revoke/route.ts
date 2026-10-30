import { schema } from "@inboxjoy/db";
import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { rejectCrossSiteRequest } from "@/lib/oauth-consent";
import { getCurrentUser } from "@/lib/server-auth";

export const runtime = "nodejs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  // Cookie-driven endpoint: same cross-site rejection as the consent POST.
  const crossSite = rejectCrossSiteRequest(request);
  if (crossSite) return crossSite;

  const user = await getCurrentUser(request);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) return Response.json({ error: "not_found" }, { status: 404 });

  const db = getDb();
  const revokedAt = new Date();
  const revoked = await db.transaction(async (tx) => {
    const [grant] = await tx.update(schema.mcpGrants).set({ revokedAt }).where(and(
      eq(schema.mcpGrants.id, id),
      eq(schema.mcpGrants.userId, user.userId),
      isNull(schema.mcpGrants.revokedAt),
    )).returning({
      userId: schema.mcpGrants.userId,
      clientId: schema.mcpGrants.clientId,
      workspaceId: schema.mcpGrants.workspaceId,
    });

    if (!grant) return false;
    await tx.update(schema.mcpOauthTokens).set({ revokedAt }).where(and(
      eq(schema.mcpOauthTokens.userId, grant.userId),
      eq(schema.mcpOauthTokens.clientId, grant.clientId),
      eq(schema.mcpOauthTokens.workspaceId, grant.workspaceId),
      isNull(schema.mcpOauthTokens.revokedAt),
    ));
    return true;
  });

  if (!revoked) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ revoked: true });
}
