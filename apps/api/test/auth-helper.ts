import type { FastifyInstance } from "fastify";
import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

export type AuthenticatedSession = {
  cookie: string;
  email: string;
  userId: string;
  workspaceId: string;
};

export async function createAuthenticatedSession(app: FastifyInstance, name = "API Test User"): Promise<AuthenticatedSession> {
  const email = `api-test-${randomUUID()}@example.com`;
  const signupResponse = await app.inject({
    method: "POST",
    url: "/v1/auth/sign-up/email",
    payload: {
      name,
      email,
      password: "test-password-at-least-eight-characters",
      acceptedTerms: true,
    },
  });

  if (signupResponse.statusCode !== 200) {
    throw new Error(`Could not create test user: ${signupResponse.statusCode} ${signupResponse.body}`);
  }

  const signup = signupResponse.json() as { user?: { id?: string } };
  const userId = signup.user?.id;
  if (!userId) throw new Error(`Authentication response did not include a user id: ${signupResponse.body}`);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required to verify test auth users.");
  const pool = createPgPool(databaseUrl);
  const db = createDb(pool);
  try {
    await db.update(schema.authUsers).set({ emailVerified: true }).where(eq(schema.authUsers.id, userId));
  } finally {
    await pool.end();
  }

  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/sign-in/email",
    payload: {
      email,
      password: "test-password-at-least-eight-characters",
    },
  });

  if (response.statusCode !== 200) {
    throw new Error(`Could not create test session: ${response.statusCode} ${response.body}`);
  }

  const setCookie = response.headers["set-cookie"];
  const cookies = (Array.isArray(setCookie) ? setCookie : [setCookie])
    .filter((cookie): cookie is string => typeof cookie === "string")
    .map((cookie) => cookie.split(";", 1)[0]);
  if (!cookies.length) throw new Error("Authentication response did not set a session cookie.");

  const cookie = cookies.join("; ");
  const workspaceResponse = await app.inject({ method: "GET", url: "/v1/workspace", headers: { cookie } });
  const workspace = workspaceResponse.json() as { workspace?: { id?: string } };
  if (!userId || workspaceResponse.statusCode !== 200 || !workspace.workspace?.id) {
    throw new Error(`Could not resolve authenticated workspace: ${workspaceResponse.statusCode} ${workspaceResponse.body}`);
  }

  return { cookie, email, userId, workspaceId: workspace.workspace.id };
}
