import { schema } from "@inboxjoy/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { randomUUID } from "node:crypto";

import { getDb } from "@/lib/db";

type ServerAuth = ReturnType<typeof createServerAuth>;

declare global {
  var inboxJoyWebAuth: ServerAuth | undefined;
}

// The public origin this Next.js app is served from. better-auth silently rejects a valid
// session cookie over a real HTTP request when it cannot establish a trusted origin for the
// incoming request (baseURL/trustedOrigins unset) -- it only appears to work when the route
// handler is invoked directly (as in tests), because that path never carries a Host header.
const WEB_ORIGIN = process.env.WEB_BASE_URL ?? process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

function createServerAuth() {
  // The web and API services must receive the same BETTER_AUTH_SECRET (or AUTH_SECRET)
  // so this read-only session reader can verify the cookies issued by apps/api.
  return betterAuth({
    baseURL: WEB_ORIGIN,
    trustedOrigins: [WEB_ORIGIN],
    secret: process.env.BETTER_AUTH_SECRET ?? process.env.AUTH_SECRET,
    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema: {
        authUser: schema.authUsers,
        authSession: schema.authSessions,
        authAccount: schema.authAccounts,
        authVerification: schema.authVerifications,
      },
    }),
    user: { modelName: "authUser" },
    session: { modelName: "authSession" },
    account: { modelName: "authAccount" },
    verification: { modelName: "authVerification" },
    emailAndPassword: { enabled: true },
    advanced: { database: { generateId: () => randomUUID() } },
  });
}

export function getServerAuth(): ServerAuth {
  globalThis.inboxJoyWebAuth ??= createServerAuth();
  return globalThis.inboxJoyWebAuth;
}

export async function getCurrentUser(request: Request): Promise<{ userId: string; email: string } | null> {
  const session = await getServerAuth().api.getSession({ headers: request.headers });
  if (!session?.user) return null;
  return { userId: session.user.id, email: session.user.email };
}
