import { oauthDiscoveryDocument } from "@/lib/oauth";
import { webOrigin } from "@/lib/oauth-consent";

export const runtime = "nodejs";

// The issuer comes from WEB_BASE_URL only, never the request's Host header: a
// spoofed Host would otherwise be cached as the authorization server's identity.
export async function GET(): Promise<Response> {
  return Response.json(oauthDiscoveryDocument(webOrigin()), {
    headers: { "cache-control": "public, max-age=300" },
  });
}
