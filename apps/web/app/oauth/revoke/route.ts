import { schema } from "@inboxjoy/db";
import { and, eq, isNull, or } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { hashOpaqueToken } from "@/lib/oauth";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const params = new URLSearchParams(await request.text());
  const token = params.get("token");
  const clientId = params.get("client_id");

  if (token && clientId) {
    const tokenHash = hashOpaqueToken(token);
    await getDb().update(schema.mcpOauthTokens).set({ revokedAt: new Date() }).where(and(
      eq(schema.mcpOauthTokens.clientId, clientId),
      isNull(schema.mcpOauthTokens.revokedAt),
      or(
        eq(schema.mcpOauthTokens.tokenHash, tokenHash),
        eq(schema.mcpOauthTokens.refreshTokenHash, tokenHash),
      ),
    ));
  }

  return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
}
