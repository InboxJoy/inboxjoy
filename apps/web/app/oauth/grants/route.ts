import { schema } from "@inboxjoy/db";
import { desc, eq } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { getCurrentUser } from "@/lib/server-auth";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const user = await getCurrentUser(request);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const grants = await getDb().select({
    id: schema.mcpGrants.id,
    clientId: schema.mcpGrants.clientId,
    clientName: schema.oauthClients.clientName,
    workspaceId: schema.mcpGrants.workspaceId,
    scopes: schema.mcpGrants.scopes,
    createdAt: schema.mcpGrants.createdAt,
    revokedAt: schema.mcpGrants.revokedAt,
  }).from(schema.mcpGrants).leftJoin(
    schema.oauthClients,
    eq(schema.oauthClients.id, schema.mcpGrants.clientId),
  ).where(eq(schema.mcpGrants.userId, user.userId)).orderBy(desc(schema.mcpGrants.createdAt));

  return Response.json({
    grants: grants.map((grant) => ({ ...grant, clientName: grant.clientName ?? grant.clientId })),
  }, { headers: { "cache-control": "no-store" } });
}
