import { loadAppEnv } from "@inboxjoy/config";
import { createDb, createPgPool, schema } from "@inboxjoy/db";
import { disabledTransactionalEmailService, type PasswordResetEmailInput, type SequenceTestEmailInput, type TransactionalEmailService, type WelcomeEmailInput } from "@inboxjoy/email";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { createAuthEmailCallbacks, currentTermsVersion, provisionWorkspace, transactionalEmailFromEnv } from "../src/auth.js";
import { createAuthenticatedSession, type AuthenticatedSession } from "./auth-helper.js";

function recordingTransactionalEmail(): TransactionalEmailService & {
  welcomes: WelcomeEmailInput[];
  resets: PasswordResetEmailInput[];
  sequenceTests: SequenceTestEmailInput[];
} {
  const welcomes: WelcomeEmailInput[] = [];
  const resets: PasswordResetEmailInput[] = [];
  const sequenceTests: SequenceTestEmailInput[] = [];
  return {
    ...disabledTransactionalEmailService,
    enabled: true,
    welcomes,
    resets,
    sequenceTests,
    async sendWelcome(input) {
      welcomes.push(input);
    },
    async sendPasswordReset(input) {
      resets.push(input);
    },
    async sendSequenceTest(input) {
      sequenceTests.push(input);
    },
  };
}

function baseEnv(overrides: NodeJS.ProcessEnv = {}) {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://localhost/inboxjoy_test",
    API_BASE_URL: "https://api.example.test",
    WEB_BASE_URL: "https://app.example.test",
    LOG_LEVEL: "silent",
    AUTH_SECRET: "auth-email-test-secret-at-least-32-characters",
    ...overrides,
  };
}

describe("auth transactional email env", () => {
  it("enables Azure Communication Services email with the standardized env names", () => {
    const env = loadAppEnv(baseEnv({
      AZURE_COMMUNICATION_EMAIL_ENDPOINT: "https://email.example.test",
      AZURE_COMMUNICATION_EMAIL_SENDER: "hello@example.test",
      AZURE_COMMUNICATION_EMAIL_REPLY_TO_ADDRESS: "support@example.test",
      AZURE_COMMUNICATION_EMAIL_MANAGED_IDENTITY_CLIENT_ID: "11111111-1111-4111-8111-111111111111",
    }));

    expect(env.AZURE_COMMUNICATION_EMAIL_ENDPOINT).toBe("https://email.example.test");
    expect(env.AZURE_COMMUNICATION_EMAIL_SENDER).toBe("hello@example.test");
    expect(env.AZURE_COMMUNICATION_EMAIL_REPLY_TO_ADDRESS).toBe("support@example.test");
    expect(env.AZURE_COMMUNICATION_EMAIL_MANAGED_IDENTITY_CLIENT_ID).toBe("11111111-1111-4111-8111-111111111111");
    expect(transactionalEmailFromEnv(env).enabled).toBe(true);
  });

  it("does not treat legacy Azure aliases as production configuration", () => {
    const legacyEndpoint = ["AZURE", "EMAIL", "ENDPOINT"].join("_");
    const legacySender = ["AZURE", "EMAIL", "SENDER", "ADDRESS"].join("_");
    expect(() => loadAppEnv(baseEnv({
      NODE_ENV: "production",
      INBOXJOY_EDITION: "cloud",
      [legacyEndpoint]: "https://email.example.test",
      [legacySender]: "hello@example.test",
    }))).toThrow("System email is required");
  });

  it("requires the standardized endpoint and sender together", () => {
    expect(() => loadAppEnv(baseEnv({
      AZURE_COMMUNICATION_EMAIL_ENDPOINT: "https://email.example.test",
    }))).toThrow("AZURE_COMMUNICATION_EMAIL_ENDPOINT and AZURE_COMMUNICATION_EMAIL_SENDER must be configured together");
  });
});

describe("auth email callbacks", () => {
  it("forwards welcome and password-reset messages", async () => {
    const email = recordingTransactionalEmail();
    const callbacks = createAuthEmailCallbacks(email);

    await callbacks.sendWelcome({ email: "member@example.test", name: "Member" });
    await callbacks.sendPasswordReset({ email: "member@example.test", name: "Member" }, "https://api.example.test/reset/private-token");
    await callbacks.sendVerificationEmail({ email: "member@example.test", name: "Member" }, "https://api.example.test/v1/auth/verify-email?token=private-token");

    expect(email.welcomes).toEqual([{ recipient: { email: "member@example.test", name: "Member" } }]);
    expect(email.resets).toEqual([{
      recipient: { email: "member@example.test", name: "Member" },
      resetUrl: "https://api.example.test/reset/private-token",
      expiresInMinutes: 60,
    }]);
    expect(email.sequenceTests).toHaveLength(1);
    expect(email.sequenceTests[0]).toMatchObject({
      recipient: { email: "member@example.test", name: "Member" },
      subject: "Verify your InboxJoy email",
    });
    expect(email.sequenceTests[0]?.plainText).toContain("https://api.example.test/v1/auth/verify-email?token=private-token");
  });

  it("swallows delivery failures and reports only safe metadata", async () => {
    const failures: unknown[] = [];
    const email: TransactionalEmailService = {
      ...disabledTransactionalEmailService,
      enabled: true,
      async sendWelcome() {
        throw Object.assign(new Error("request body contained private-token"), { code: "EmailSendFailed", statusCode: 503 });
      },
      async sendPasswordReset() {},
      async sendSequenceTest() {},
    };
    const callbacks = createAuthEmailCallbacks(email, (failure) => failures.push(failure));

    await expect(callbacks.sendWelcome({ email: "member@example.test" })).resolves.toBeUndefined();
    expect(failures).toEqual([{
      kind: "welcome",
      errorName: "Error",
      errorCode: "EmailSendFailed",
      statusCode: 503,
    }]);
    expect(JSON.stringify(failures)).not.toContain("private-token");
    expect(JSON.stringify(failures)).not.toContain("member@example.test");
  });
});

const databaseUrl = process.env.DATABASE_URL;
// The founder alert and the Terms requirement belong to the managed service.
// FOUNDER_ALERT_EMAIL has no default, so set it as production's api service does.
const env = loadAppEnv(baseEnv({
  DATABASE_URL: databaseUrl ?? "postgresql://localhost/inboxjoy_test",
  INBOXJOY_EDITION: "cloud",
  FOUNDER_ALERT_EMAIL: "founder@example.test",
}));

describe.skipIf(!databaseUrl)("auth email integration", () => {
  const pool = createPgPool(databaseUrl ?? "postgresql://localhost/inboxjoy_test");
  const db = createDb(pool);
  const email = recordingTransactionalEmail();
  let app: Awaited<ReturnType<typeof buildApp>>;
  let session: AuthenticatedSession;

  beforeAll(async () => {
    app = await buildApp({ env, db, transactionalEmail: email });
    session = await createAuthenticatedSession(app, "Transactional Email Test");
  });

  afterAll(async () => {
    await app?.close();
    if (session?.workspaceId) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, session.workspaceId));
    if (session?.userId) {
      await db.delete(schema.users).where(eq(schema.users.id, session.userId));
      await db.delete(schema.authUsers).where(eq(schema.authUsers.id, session.userId));
    }
    await pool.end();
  });

  it("sends verification and a founder signup alert after a successful email signup", async () => {
    // Signup produces two sequenceTest-channel emails: the verification email
    // to the user, and the founder signup alert (FOUNDER_ALERT_EMAIL).
    await vi.waitFor(() => {
      expect(email.sequenceTests).toHaveLength(2);
    });
    const verification = email.sequenceTests.find((sent) => sent.recipient.email === session.email);
    expect(verification).toMatchObject({
      recipient: { email: session.email, name: "Transactional Email Test" },
      subject: "Verify your InboxJoy email",
    });
    const founderAlert = email.sequenceTests.find((sent) => sent.recipient.email !== session.email);
    expect(founderAlert?.subject).toContain("New InboxJoy signup");
  });

  it("rejects email signup without explicit terms acceptance before creating an auth user", async () => {
    const candidateEmail = `missing-consent-${randomUUID()}@example.test`;
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/sign-up/email",
      payload: {
        name: "Missing Consent",
        email: candidateEmail,
        password: "test-password-at-least-eight-characters",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ message: "You must accept the Terms and Privacy Policy to create an account." });
    expect(await db.select().from(schema.authUsers).where(eq(schema.authUsers.email, candidateEmail))).toHaveLength(0);
  });

  it("records accepted terms once with the current version", async () => {
    const [before] = await db.select().from(schema.users).where(eq(schema.users.id, session.userId));
    expect(before?.termsAcceptedAt).toBeInstanceOf(Date);
    expect(before?.termsVersion).toBe(currentTermsVersion);

    const duplicate = await app.inject({
      method: "POST",
      url: "/v1/auth/sign-up/email",
      payload: {
        name: "Transactional Email Test",
        email: session.email,
        password: "test-password-at-least-eight-characters",
        acceptedTerms: true,
      },
    });
    expect(duplicate.statusCode).toBe(422);

    const [after] = await db.select().from(schema.users).where(eq(schema.users.id, session.userId));
    expect(after?.termsAcceptedAt?.getTime()).toBe(before?.termsAcceptedAt?.getTime());
    expect(after?.termsVersion).toBe(currentTermsVersion);
  });

  it("signs in an unverified user immediately after email signup", async () => {
    const userEmail = `immediate-signin-${randomUUID()}@example.test`;
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/sign-up/email",
      payload: {
        name: "Immediate Signin",
        email: userEmail,
        password: "test-password-at-least-eight-characters",
        acceptedTerms: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ token: expect.any(String), user: { email: userEmail, emailVerified: false } });
    expect(response.headers["set-cookie"]).toBeDefined();

    const [authUser] = await db.select({ id: schema.authUsers.id }).from(schema.authUsers).where(eq(schema.authUsers.email, userEmail));
    if (authUser) {
      await db.delete(schema.workspaces).where(eq(schema.workspaces.createdByUserId, authUser.id));
      await db.delete(schema.users).where(eq(schema.users.id, authUser.id));
      await db.delete(schema.authUsers).where(eq(schema.authUsers.id, authUser.id));
    }
  });

  it("provisions one workspace and one membership across concurrent calls", async () => {
    const userId = randomUUID();
    const emailAddress = `provision-race-${randomUUID()}@example.test`;

    const workspaceIds = await Promise.all([
      provisionWorkspace(db, { id: userId, name: "Provision Race", email: emailAddress }),
      provisionWorkspace(db, { id: userId, name: "Provision Race", email: emailAddress }),
    ]);

    expect(workspaceIds[0]).toBe(workspaceIds[1]);
    expect(await db.select({ id: schema.workspaces.id }).from(schema.workspaces).where(eq(schema.workspaces.createdByUserId, userId))).toHaveLength(1);
    expect(await db.select({ id: schema.memberships.id }).from(schema.memberships).where(eq(schema.memberships.userId, userId))).toHaveLength(1);

    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceIds[0]!));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });

  it("releases an email held by a profile with no sign-in account so the real account can be provisioned", async () => {
    const placeholderId = randomUUID();
    const userId = randomUUID();
    const emailAddress = `placeholder-${randomUUID()}@example.test`;
    await db.insert(schema.users).values({ id: placeholderId, email: emailAddress, normalizedEmail: emailAddress, displayName: "Placeholder" });
    await db.insert(schema.authUsers).values({ id: userId, name: "Real Owner", email: emailAddress, emailVerified: true });

    const workspaceId = await provisionWorkspace(db, { id: userId, name: "Real Owner", email: emailAddress });
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(user).toMatchObject({ normalizedEmail: emailAddress });
    expect(await db.select({ id: schema.memberships.id }).from(schema.memberships).where(eq(schema.memberships.userId, userId))).toHaveLength(1);
    const [placeholder] = await db.select().from(schema.users).where(eq(schema.users.id, placeholderId));
    expect(placeholder!.normalizedEmail).toBe(`${emailAddress}#unclaimed-${placeholderId}`);

    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await db.delete(schema.users).where(inArray(schema.users.id, [userId, placeholderId]));
    await db.delete(schema.authUsers).where(eq(schema.authUsers.id, userId));
  });

  it("keeps an email that belongs to another real account", async () => {
    const otherId = randomUUID();
    const emailAddress = `taken-${randomUUID()}@example.test`;
    await db.insert(schema.authUsers).values({ id: otherId, name: "Other", email: emailAddress, emailVerified: true });
    const otherWorkspaceId = await provisionWorkspace(db, { id: otherId, name: "Other", email: emailAddress });

    await expect(provisionWorkspace(db, { id: randomUUID(), name: "Intruder", email: emailAddress })).rejects.toThrow();
    const [other] = await db.select().from(schema.users).where(eq(schema.users.id, otherId));
    expect(other!.normalizedEmail).toBe(emailAddress);

    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, otherWorkspaceId));
    await db.delete(schema.users).where(eq(schema.users.id, otherId));
    await db.delete(schema.authUsers).where(eq(schema.authUsers.id, otherId));
  });

  it("does not stamp consent while self-healing workspace data", async () => {
    const userId = randomUUID();
    const emailAddress = `self-heal-${randomUUID()}@example.test`;
    await db.insert(schema.authUsers).values({ id: userId, name: "Self Heal", email: emailAddress, emailVerified: true });

    const workspaceId = await provisionWorkspace(db, { id: userId, name: "Self Heal", email: emailAddress });
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(user).toMatchObject({ termsAcceptedAt: null, termsVersion: null });

    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.delete(schema.authUsers).where(eq(schema.authUsers.id, userId));
  });

  it("keeps reset responses generic and emails only an existing account", async () => {
    const existing = await app.inject({
      method: "POST",
      url: "/v1/auth/request-password-reset",
      payload: { email: session.email, redirectTo: "https://app.example.test/app/reset-password" },
    });
    const unknown = await app.inject({
      method: "POST",
      url: "/v1/auth/request-password-reset",
      payload: { email: "unknown@example.test", redirectTo: "https://app.example.test/app/reset-password" },
    });

    expect(existing.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(200);
    expect(existing.json()).toEqual(unknown.json());
    await vi.waitFor(() => expect(email.resets).toHaveLength(1));
    expect(email.resets[0]?.recipient.email).toBe(session.email);
    expect(email.resets[0]?.resetUrl).toContain("/v1/auth/reset-password/");
    expect(email.resets[0]?.resetUrl).toContain("callbackURL=https%3A%2F%2Fapp.example.test%2Fapp%2Freset-password");
  });
});
