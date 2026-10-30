import { loadAppEnv } from "@inboxjoy/config";
import { createDb, createPgPool, schema, type InboxJoyDb } from "@inboxjoy/db";
import { disabledTransactionalEmailService, type SequenceTestEmailInput, type TransactionalEmailService } from "@inboxjoy/email";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { claimFirstAccount, SETUP_TOKEN_REQUIRED_CODE, SIGNUP_CLOSED_CODE } from "../src/auth.js";

const databaseUrl = process.env.DATABASE_URL;
const password = "test-password-at-least-eight-characters";
const setupToken = "signup-mode-setup-token-0123456789";

// "First account on the instance" needs an instance with no accounts, which the
// shared test database never is. Each test gets a private schema holding empty
// copies of every public table, and its own pool whose search_path points there
// first, so the real sign-up path runs against a fresh install.
async function createIsolatedDatabase(url: string): Promise<{ db: InboxJoyDb; drop: () => Promise<void> }> {
  const schemaName = `signup_mode_${randomUUID().replaceAll("-", "")}`;
  const admin = createPgPool(url, { max: 1 });
  await admin.query(`CREATE SCHEMA "${schemaName}"`);
  await admin.query(`
    DO $$
    DECLARE t record;
    BEGIN
      FOR t IN
        SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      LOOP
        EXECUTE format('CREATE TABLE %I.%I (LIKE public.%I INCLUDING ALL)', '${schemaName}', t.relname, t.relname);
      END LOOP;
    END $$;
  `);
  const pool = createPgPool(url, { max: 6 });
  pool.on("connect", (client) => {
    void client.query(`SET search_path TO "${schemaName}", public`);
  });
  return {
    db: createDb(pool),
    drop: async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schemaName}" CASCADE`);
      await admin.end();
    },
  };
}

function recordingEmail(): TransactionalEmailService & { sent: SequenceTestEmailInput[] } {
  const sent: SequenceTestEmailInput[] = [];
  return {
    ...disabledTransactionalEmailService,
    enabled: true,
    sent,
    async sendSequenceTest(input) { sent.push(input); },
  };
}

function testEnv(overrides: NodeJS.ProcessEnv) {
  return loadAppEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl ?? "postgresql://localhost/inboxjoy_test",
    API_BASE_URL: "https://api.example.test",
    WEB_BASE_URL: "https://app.example.test",
    CORS_ORIGINS: "https://app.example.test",
    LOG_LEVEL: "silent",
    AUTH_SECRET: "signup-mode-test-auth-secret-at-least-32-characters",
    FOUNDER_ALERT_EMAIL: "founder@example.test",
    ...overrides,
  });
}

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const setCookie = response.headers["set-cookie"];
  return (Array.isArray(setCookie) ? setCookie : [setCookie])
    .filter((cookie): cookie is string => typeof cookie === "string")
    .map((cookie) => cookie.split(";", 1)[0])
    .join("; ");
}

describe.skipIf(!databaseUrl)("sign-up mode", () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedDatabase>>;
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

  beforeEach(async () => {
    isolated = await createIsolatedDatabase(databaseUrl!);
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await isolated.drop();
  });

  async function startApp(overrides: NodeJS.ProcessEnv, transactionalEmail: TransactionalEmailService = disabledTransactionalEmailService) {
    const app = await buildApp({ env: testEnv(overrides), db: isolated.db, transactionalEmail });
    apps.push(app);
    return app;
  }

  // Each attempt comes from its own client address: the per-address sign-up
  // limit (5 an hour) is not what these tests exercise.
  let signupAttempts = 0;
  function signUp(app: Awaited<ReturnType<typeof buildApp>>, email: string, extra: Record<string, unknown> = {}) {
    signupAttempts += 1;
    const remoteAddress = `10.${(signupAttempts >> 16) & 255}.${(signupAttempts >> 8) & 255}.${signupAttempts & 255}`;
    return app.inject({ method: "POST", url: "/v1/auth/sign-up/email", remoteAddress, payload: { name: "Signup Mode", email, password, ...extra } });
  }

  async function status(app: Awaited<ReturnType<typeof buildApp>>) {
    const response = await app.inject({ method: "GET", url: "/v1/public/status" });
    expect(response.statusCode).toBe(200);
    return response.json() as { edition: string; signupMode: string; signupOpen: boolean; needsSetup: boolean; setupTokenRequired: boolean };
  }

  async function authUser(email: string) {
    const [row] = await isolated.db.select().from(schema.authUsers).where(eq(schema.authUsers.email, email));
    return row;
  }

  async function invite(app: Awaited<ReturnType<typeof buildApp>>, ownerCookie: string, email: string, workspaceId?: string) {
    const headers = { cookie: ownerCookie, ...(workspaceId ? { "x-workspace-id": workspaceId } : {}) };
    const response = await app.inject({ method: "POST", url: "/v1/team/invitations", headers, payload: { email, role: "member" } });
    expect(response.statusCode).toBe(201);
    return response.json().token as string;
  }

  async function acceptInvitation(app: Awaited<ReturnType<typeof buildApp>>, cookie: string, token: string) {
    return app.inject({ method: "POST", url: "/v1/team/invitations/accept", headers: { cookie }, payload: { token } });
  }

  async function currentWorkspaceId(app: Awaited<ReturnType<typeof buildApp>>, cookie: string) {
    const response = await app.inject({ method: "GET", url: "/v1/workspace", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    return response.json().workspace.id as string;
  }

  it("self-host invite mode: the first account becomes a verified owner, then sign-up closes", async () => {
    const email = recordingEmail();
    const app = await startApp({ INBOXJOY_EDITION: "selfhost", SIGNUP_MODE: "invite" }, email);
    expect(await status(app)).toEqual({ edition: "selfhost", signupMode: "invite", signupOpen: true, needsSetup: true, setupTokenRequired: false });

    const owner = await signUp(app, "owner@example.test");
    expect(owner.statusCode).toBe(200);
    expect(owner.json()).toMatchObject({ user: { email: "owner@example.test", emailVerified: true } });
    expect((await authUser("owner@example.test"))?.emailVerified).toBe(true);

    // Owner of their own workspace.
    const workspace = await app.inject({ method: "GET", url: "/v1/workspace", headers: { cookie: cookieFrom(owner) } });
    expect(workspace.statusCode).toBe(200);
    const [membership] = await isolated.db.select().from(schema.memberships).where(eq(schema.memberships.userId, owner.json().user.id));
    expect(membership).toMatchObject({ role: "owner", status: "active" });

    // No Terms requirement on a self-hosted server, so no consent is recorded.
    const [profile] = await isolated.db.select().from(schema.users).where(eq(schema.users.id, owner.json().user.id));
    expect(profile).toMatchObject({ termsAcceptedAt: null, termsVersion: null });

    expect(await status(app)).toEqual({ edition: "selfhost", signupMode: "invite", signupOpen: false, needsSetup: false, setupTokenRequired: false });

    const stranger = await signUp(app, "stranger@example.test");
    expect(stranger.statusCode).toBe(403);
    expect(stranger.json()).toMatchObject({ code: SIGNUP_CLOSED_CODE, message: "Sign-ups are closed on this server. Ask your admin for an invite." });
    expect(await authUser("stranger@example.test")).toBeUndefined();

    // Closing the app waits for background sends: no verification email for an
    // already-verified owner and no founder alert from a self-hosted server.
    apps.splice(apps.indexOf(app), 1);
    await app.close();
    expect(email.sent).toEqual([]);
  });

  it("self-host invite mode admits an invitee only with their invitation's token, verified", async () => {
    const email = recordingEmail();
    const app = await startApp({ INBOXJOY_EDITION: "selfhost", SIGNUP_MODE: "invite" }, email);
    const owner = await signUp(app, "owner@example.test");
    expect(owner.statusCode).toBe(200);
    const ownerCookie = cookieFrom(owner);
    const ownerWorkspace = await app.inject({ method: "GET", url: "/v1/workspace", headers: { cookie: ownerCookie } });
    const ownerWorkspaceId = ownerWorkspace.json().workspace.id as string;

    const token = await invite(app, ownerCookie, "Invitee@Example.test");
    const otherToken = await invite(app, ownerCookie, "other@example.test");

    // A matching address alone proves nothing: typing an invited address, or
    // presenting another invitation's link, or a made-up one, admits nobody.
    for (const extra of [{}, { inviteToken: otherToken }, { inviteToken: `${ownerWorkspaceId}.${"x".repeat(43)}` }, { inviteToken: 42 }]) {
      const refused = await signUp(app, "invitee@example.test", extra);
      expect(refused.statusCode, JSON.stringify(extra)).toBe(403);
      expect(refused.json()).toMatchObject({ code: SIGNUP_CLOSED_CODE });
    }
    // The link is bound to the invited address.
    const wrongAddress = await signUp(app, "someone-else@example.test", { inviteToken: token });
    expect(wrongAddress.statusCode).toBe(403);
    expect(await authUser("someone-else@example.test")).toBeUndefined();
    expect(await authUser("invitee@example.test")).toBeUndefined();

    // With the link the owner handed over, the invitee starts verified (a
    // fresh server may have no system email) and can accept at once.
    const invitee = await signUp(app, "invitee@example.test", { inviteToken: token });
    expect(invitee.statusCode).toBe(200);
    expect(invitee.json()).toMatchObject({ user: { emailVerified: true } });
    const accepted = await app.inject({ method: "POST", url: "/v1/team/invitations/accept", headers: { cookie: cookieFrom(invitee) }, payload: { token } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ accepted: true, workspaceId: ownerWorkspaceId });

    // An accepted or expired invitation admits nobody.
    const acceptedToken = await invite(app, ownerCookie, "accepted@example.test");
    await isolated.db.update(schema.invitations).set({ acceptedAt: new Date() }).where(eq(schema.invitations.normalizedEmail, "accepted@example.test"));
    expect((await signUp(app, "accepted@example.test", { inviteToken: acceptedToken })).json()).toMatchObject({ code: SIGNUP_CLOSED_CODE });
    const lateToken = await invite(app, ownerCookie, "late@example.test");
    await isolated.db.update(schema.invitations).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(schema.invitations.normalizedEmail, "late@example.test"));
    const lateSignup = await signUp(app, "late@example.test", { inviteToken: lateToken });
    expect(lateSignup.statusCode).toBe(403);
    expect(lateSignup.json()).toMatchObject({ code: SIGNUP_CLOSED_CODE });

    // No verification email for accounts verified at creation.
    apps.splice(apps.indexOf(app), 1);
    await app.close();
    expect(email.sent).toEqual([]);
  });

  it("self-host invite mode: only invitations into a workspace the instance owner belongs to admit new accounts", async () => {
    const app = await startApp({ INBOXJOY_EDITION: "selfhost", SIGNUP_MODE: "invite" });
    const owner = await signUp(app, "owner@example.test");
    const ownerCookie = cookieFrom(owner);
    const ownerWorkspaceId = await currentWorkspaceId(app, ownerCookie);

    // The owner's invitee gets in, verified, and owns a personal workspace.
    const invitee = await signUp(app, "invitee@example.test", { inviteToken: await invite(app, ownerCookie, "invitee@example.test") });
    expect(invitee.statusCode).toBe(200);
    const inviteeCookie = cookieFrom(invitee);
    const personalWorkspaceId = await currentWorkspaceId(app, inviteeCookie);
    expect(personalWorkspaceId).not.toBe(ownerWorkspaceId);
    const colleague = await signUp(app, "colleague@example.test", { inviteToken: await invite(app, ownerCookie, "colleague@example.test") });
    expect(colleague.statusCode).toBe(200);

    // The invitee's own invitation cannot admit a stranger: invite-only is not transitive.
    const strangerToken = await invite(app, inviteeCookie, "stranger@example.test", personalWorkspaceId);
    const stranger = await signUp(app, "stranger@example.test", { inviteToken: strangerToken });
    expect(stranger.statusCode).toBe(403);
    expect(stranger.json()).toMatchObject({ code: SIGNUP_CLOSED_CODE });
    expect(await authUser("stranger@example.test")).toBeUndefined();

    // It still brings in someone who already has an account.
    const colleagueToken = await invite(app, inviteeCookie, "colleague@example.test", personalWorkspaceId);
    const joined = await acceptInvitation(app, cookieFrom(colleague), colleagueToken);
    expect(joined.statusCode).toBe(200);
    expect(joined.json()).toMatchObject({ accepted: true, workspaceId: personalWorkspaceId });

    // Once the instance owner is a member there (any role), its invitations admit new accounts.
    const ownerJoined = await acceptInvitation(app, ownerCookie, await invite(app, inviteeCookie, "owner@example.test", personalWorkspaceId));
    expect(ownerJoined.statusCode).toBe(200);
    const admitted = await signUp(app, "stranger@example.test", { inviteToken: strangerToken });
    expect(admitted.statusCode).toBe(200);
  });

  it("cloud invite mode: only a verified owner invites, and the invitee needs the token and still verifies", async () => {
    const app = await startApp({ INBOXJOY_EDITION: "cloud", SIGNUP_MODE: "invite" });
    const owner = await signUp(app, "owner@example.test", { acceptedTerms: true });
    expect(owner.statusCode).toBe(200);
    const ownerCookie = cookieFrom(owner);

    // An unverified owner cannot hand out links that admit new accounts.
    const unverified = await app.inject({ method: "POST", url: "/v1/team/invitations", headers: { cookie: ownerCookie }, payload: { email: "invitee@example.test" } });
    expect(unverified.statusCode).toBe(403);
    expect(unverified.json()).toMatchObject({ code: "email_unverified" });
    expect(await isolated.db.select({ id: schema.invitations.id }).from(schema.invitations)).toHaveLength(0);

    await isolated.db.update(schema.authUsers).set({ emailVerified: true }).where(eq(schema.authUsers.email, "owner@example.test"));
    const token = await invite(app, ownerCookie, "invitee@example.test");

    const withoutToken = await signUp(app, "invitee@example.test", { acceptedTerms: true });
    expect(withoutToken.statusCode).toBe(403);
    expect(withoutToken.json()).toMatchObject({ code: SIGNUP_CLOSED_CODE });

    const invitee = await signUp(app, "invitee@example.test", { acceptedTerms: true, inviteToken: token });
    expect(invitee.statusCode).toBe(200);
    expect(invitee.json()).toMatchObject({ user: { emailVerified: false } });

    // Guardrail 14: on the managed service the invitee proves the address by email.
    const refused = await app.inject({ method: "POST", url: "/v1/team/invitations/accept", headers: { cookie: cookieFrom(invitee) }, payload: { token } });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: "verify_email" });
  });

  it("admits exactly one of two concurrent first sign-ups", async () => {
    const app = await startApp({ INBOXJOY_EDITION: "selfhost", SIGNUP_MODE: "invite" });

    const responses = await Promise.all([signUp(app, "first-a@example.test"), signUp(app, "first-b@example.test")]);
    const codes = responses.map((response) => response.statusCode).sort();
    expect(codes).toEqual([200, 403]);
    expect(await isolated.db.select({ id: schema.authUsers.id }).from(schema.authUsers)).toHaveLength(1);
  });

  it("an abandoned setup claim expires; a live one for another address holds", async () => {
    expect(await claimFirstAccount(isolated.db, "first@example.test")).toBe(true);
    // Same address again (a double submit) is still the claimer.
    expect(await claimFirstAccount(isolated.db, "first@example.test")).toBe(true);
    expect(await claimFirstAccount(isolated.db, "other@example.test")).toBe(false);

    await isolated.db.update(schema.authVerifications).set({ expiresAt: new Date(Date.now() - 1_000) });
    expect(await claimFirstAccount(isolated.db, "other@example.test")).toBe(true);

    await isolated.db.insert(schema.authUsers).values({ id: randomUUID(), name: "Existing", email: "existing@example.test" });
    await isolated.db.update(schema.authVerifications).set({ expiresAt: new Date(Date.now() - 1_000) });
    expect(await claimFirstAccount(isolated.db, "other@example.test")).toBe(false);
  });

  it("cloud invite mode admits the first account without marking it verified", async () => {
    const app = await startApp({ INBOXJOY_EDITION: "cloud", SIGNUP_MODE: "invite" });
    const owner = await signUp(app, "owner@example.test", { acceptedTerms: true });
    expect(owner.statusCode).toBe(200);
    expect(owner.json()).toMatchObject({ user: { emailVerified: false } });

    const stranger = await signUp(app, "stranger@example.test", { acceptedTerms: true });
    expect(stranger.statusCode).toBe(403);
    expect(stranger.json()).toMatchObject({ code: SIGNUP_CLOSED_CODE });
  });

  it("self-host open mode admits everyone and verifies only the first owner", async () => {
    const app = await startApp({ INBOXJOY_EDITION: "selfhost", SIGNUP_MODE: "open" });
    expect(await status(app)).toEqual({ edition: "selfhost", signupMode: "open", signupOpen: true, needsSetup: true, setupTokenRequired: false });

    const first = await signUp(app, "first@example.test");
    const second = await signUp(app, "second@example.test");
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ user: { emailVerified: true } });
    expect((await authUser("first@example.test"))?.emailVerified).toBe(true);
    expect((await authUser("second@example.test"))?.emailVerified).toBe(false);
    expect(await status(app)).toEqual({ edition: "selfhost", signupMode: "open", signupOpen: true, needsSetup: false, setupTokenRequired: false });
  });

  it("cloud open mode admits everyone unverified, first account included", async () => {
    const app = await startApp({ INBOXJOY_EDITION: "cloud", SIGNUP_MODE: "open", SETUP_TOKEN: setupToken });
    expect(await status(app)).toMatchObject({ signupOpen: true, needsSetup: true, setupTokenRequired: false });
    const first = await signUp(app, "first@example.test", { acceptedTerms: true });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ user: { emailVerified: false } });
  });

  it.each(["invite", "open"] as const)("self-host %s mode: SETUP_TOKEN guards the first account only", async (mode) => {
    const app = await startApp({ INBOXJOY_EDITION: "selfhost", SIGNUP_MODE: mode, SETUP_TOKEN: setupToken });
    expect(await status(app)).toEqual({ edition: "selfhost", signupMode: mode, signupOpen: true, needsSetup: true, setupTokenRequired: true });

    for (const extra of [{}, { setupToken: "wrong-token-0123456789abcdefghij" }, { setupToken: setupToken.slice(0, -1) }]) {
      const refused = await signUp(app, "squatter@example.test", extra);
      expect(refused.statusCode, JSON.stringify(extra)).toBe(403);
      expect(refused.json()).toMatchObject({ code: SETUP_TOKEN_REQUIRED_CODE, message: "Open the setup link printed by the installer." });
    }
    expect(await authUser("squatter@example.test")).toBeUndefined();

    // A refused attempt never holds the first-account claim, so the real owner
    // (another address) gets in straight away.
    const owner = await signUp(app, "owner@example.test", { setupToken });
    expect(owner.statusCode).toBe(200);
    expect(owner.json()).toMatchObject({ user: { emailVerified: true } });
    expect(await status(app)).toMatchObject({ needsSetup: false, setupTokenRequired: false });

    // After setup the token plays no part: the sign-up mode decides.
    const later = await signUp(app, "later@example.test");
    if (mode === "invite") {
      expect(later.statusCode).toBe(403);
      expect(later.json()).toMatchObject({ code: SIGNUP_CLOSED_CODE });
      expect((await signUp(app, "later2@example.test", { setupToken })).json()).toMatchObject({ code: SIGNUP_CLOSED_CODE });
    } else {
      expect(later.statusCode).toBe(200);
      expect(later.json()).toMatchObject({ user: { emailVerified: false } });
    }
  });

  it("cloud ignores SETUP_TOKEN", async () => {
    const app = await startApp({ INBOXJOY_EDITION: "cloud", SIGNUP_MODE: "invite", SETUP_TOKEN: setupToken });
    expect(await status(app)).toMatchObject({ needsSetup: true, setupTokenRequired: false });
    expect((await signUp(app, "owner@example.test", { acceptedTerms: true })).statusCode).toBe(200);
  });

  it("ignores the 0002 placeholder profile when deciding whether setup is needed", async () => {
    await isolated.db.insert(schema.users).values({ id: "00000000-0000-4000-8000-000000000002", email: "hey@replyless.ai", normalizedEmail: "hey@replyless.ai" });
    const app = await startApp({ INBOXJOY_EDITION: "selfhost", SIGNUP_MODE: "invite" });
    expect(await status(app)).toMatchObject({ needsSetup: true, signupOpen: true });
    expect((await signUp(app, "owner@example.test")).statusCode).toBe(200);
  });
});
