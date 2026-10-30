import { APIError, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { and, eq, gt, ne, or, sql } from "drizzle-orm";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { resolveEdition, resolveSetupToken, resolveSignupMode, type AppEnv, type Edition, type SignupMode } from "@inboxjoy/config";
import { AFFILIATE_COOKIE_NAME, attributeReferral, findInvitationByToken, normalizeAffiliateCode } from "@inboxjoy/core";
import { schema, type InboxJoyDb } from "@inboxjoy/db";
import {
  createTransactionalEmailService,
  POSTAL_ADDRESS_LINE,
  type TransactionalEmailService,
} from "@inboxjoy/email";

const passwordResetExpiresInSeconds = 60 * 60;
const emailVerificationExpiresInSeconds = 60 * 60;
export const currentTermsVersion = "2026-09-16";
const termsAcceptanceMessage = "You must accept the Terms and Privacy Policy to create an account.";
export const SIGNUP_CLOSED_CODE = "signup_closed";
export const signupClosedMessage = "Sign-ups are closed on this server. Ask your admin for an invite.";
export const SETUP_TOKEN_REQUIRED_CODE = "setup_token_required";
export const setupTokenRequiredMessage = "Open the setup link printed by the installer.";
const firstAccountClaimIdentifier = "inboxjoy:first-account-claim";
const firstAccountClaimTtlMs = 2 * 60 * 1000;

type AuthEmailKind = "email-verification" | "password-reset" | "welcome";

export type AuthEmailFailure = {
  kind: AuthEmailKind;
  errorName: string;
  errorCode?: string;
  statusCode?: number;
};

export type AuthAffiliateAttributionFailure = {
  errorName: string;
  errorCode?: string;
};

export type CreateAuthOptions = {
  transactionalEmail?: TransactionalEmailService;
  onEmailFailure?: (failure: AuthEmailFailure) => void;
  onAffiliateAttributionFailure?: (failure: AuthAffiliateAttributionFailure) => void;
  runInBackground?: (task: Promise<unknown>) => void;
};

type AuthEmailUser = {
  email: string;
  name?: string | null;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function verificationEmailContent(user: AuthEmailUser, verificationUrl: string): { subject: string; plainText: string; html: string } {
  const name = user.name?.trim() || "there";
  const expiration = `${emailVerificationExpiresInSeconds / 60} minutes`;
  return {
    subject: "Verify your InboxJoy email",
    plainText: `Hi ${name},\n\nVerify your email address to finish setting up InboxJoy. Use the secure link below within ${expiration}:\n\n${verificationUrl}\n\nIf you did not create an InboxJoy account, you can ignore this email.\n\nInboxJoy`,
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Verify your InboxJoy email</title></head><body style="margin:0;background:#f3f4f6;font-family:Arial,sans-serif;color:#111827"><div style="display:none;max-height:0;overflow:hidden;opacity:0">Verify your email address to finish setting up InboxJoy.</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f6;padding:32px 16px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border-radius:12px;padding:32px"><tr><td><p style="margin:0 0 24px;font-size:20px;font-weight:700">InboxJoy</p><h1 style="margin:0 0 16px;font-size:26px;line-height:1.3">Verify your email</h1><p style="margin:0 0 16px;color:#374151;font-size:16px;line-height:1.6">Hi ${escapeHtml(name)},</p><p style="margin:0;color:#374151;font-size:16px;line-height:1.6">Verify your email address to finish setting up InboxJoy. This link expires in ${escapeHtml(expiration)}.</p><p style="margin:28px 0"><a href="${escapeHtml(verificationUrl)}" style="background:#111827;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block;font-weight:600">Verify email</a></p><p style="margin:20px 0 0;color:#6b7280;font-size:14px;line-height:1.5">If you did not create an InboxJoy account, you can ignore this email.</p><p style="margin:28px 0 0;color:#6b7280;font-size:13px;line-height:1.5">InboxJoy transactional email</p></td></tr></table></td></tr></table></body></html>`,
  };
}

function errorMetadata(kind: AuthEmailKind, error: unknown): AuthEmailFailure {
  if (!error || typeof error !== "object") {
    return { kind, errorName: "UnknownError" };
  }
  const value = error as { name?: unknown; code?: unknown; statusCode?: unknown };
  return {
    kind,
    errorName: typeof value.name === "string" ? value.name : "Error",
    ...(typeof value.code === "string" ? { errorCode: value.code } : {}),
    ...(typeof value.statusCode === "number" ? { statusCode: value.statusCode } : {}),
  };
}

export function createAuthEmailCallbacks(
  transactionalEmail: TransactionalEmailService,
  onFailure: (failure: AuthEmailFailure) => void = () => {},
) {
  async function safelySend(kind: AuthEmailKind, send: () => Promise<void>): Promise<void> {
    if (!transactionalEmail.enabled) return;
    try {
      await send();
    } catch (error) {
      try {
        onFailure(errorMetadata(kind, error));
      } catch {
        // Reporting must never turn an email delivery failure into an auth failure.
      }
    }
  }

  return {
    async sendWelcome(user: AuthEmailUser): Promise<void> {
      await safelySend("welcome", () => transactionalEmail.sendWelcome({ recipient: user }));
    },
    async sendPasswordReset(user: AuthEmailUser, resetUrl: string): Promise<void> {
      await safelySend("password-reset", () => transactionalEmail.sendPasswordReset({
        recipient: user,
        resetUrl,
        expiresInMinutes: passwordResetExpiresInSeconds / 60,
      }));
    },
    async sendVerificationEmail(user: AuthEmailUser, verificationUrl: string): Promise<void> {
      await safelySend("email-verification", () => transactionalEmail.sendSequenceTest({
        recipient: user,
        ...verificationEmailContent(user, verificationUrl),
      }));
    },
  };
}

// Azure Communication Services wins when configured (our cloud), then SMTP
// (MAIL_SMTP_URL + MAIL_FROM), else disabled. The Dubai postal line belongs to
// the managed cloud edition only.
export function transactionalEmailFromEnv(
  env: AppEnv,
  dependencies: Parameters<typeof createTransactionalEmailService>[1] = {},
): TransactionalEmailService {
  return createTransactionalEmailService({
    appBaseUrl: env.WEB_BASE_URL,
    postalAddressLine: resolveEdition(env) === "cloud" ? POSTAL_ADDRESS_LINE : undefined,
    azure: {
      endpoint: env.AZURE_COMMUNICATION_EMAIL_ENDPOINT,
      senderAddress: env.AZURE_COMMUNICATION_EMAIL_SENDER,
      managedIdentityClientId: env.AZURE_COMMUNICATION_EMAIL_MANAGED_IDENTITY_CLIENT_ID,
      replyToAddress: env.AZURE_COMMUNICATION_EMAIL_REPLY_TO_ADDRESS,
    },
    smtp: {
      url: env.MAIL_SMTP_URL,
      from: env.MAIL_FROM,
      replyToAddress: env.MAIL_REPLY_TO,
    },
  }, dependencies);
}

function genericErrorInfo(error: unknown): AuthAffiliateAttributionFailure {
  if (!error || typeof error !== "object") {
    return { errorName: "UnknownError" };
  }
  const value = error as { name?: unknown; code?: unknown };
  return {
    errorName: typeof value.name === "string" ? value.name : "Error",
    ...(typeof value.code === "string" ? { errorCode: value.code } : {}),
  };
}

function workspaceSlug(name: string, userId: string): string {
  const base = name.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "workspace";
  return `${base}-${userId.replaceAll("-", "").slice(0, 12)}`;
}

function workspaceIdForUser(userId: string): string {
  const bytes = createHash("sha256").update(`inboxjoy-workspace:${userId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Creates the user's workspace + owner membership. Used by the signup hook and, as a
// self-heal, by the request hook when an auth user exists without any membership
// (e.g. the signup-time provisioning transaction failed after the auth row committed).
export async function provisionWorkspace(
  db: InboxJoyDb,
  user: { id: string; email: string; name?: string | null; image?: string | null },
  consent?: { acceptedAt: Date; termsVersion: string },
  options: { onEmailReleased?: (placeholderUserIds: string[]) => void } = {},
): Promise<string> {
  const normalizedEmail = user.email.trim().toLowerCase();
  const deterministicWorkspaceId = workspaceIdForUser(user.id);
  const workspaceName = `${user.name?.trim() || "My"}'s workspace`;
  const slug = workspaceSlug(user.name ?? "", user.id);

  return db.transaction(async (tx) => {
    // A profile row with no sign-in account behind it (e.g. the 0002 bootstrap
    // owner seeded for hey@replyless.ai) can hold this email, and the unique
    // email index then aborts provisioning, leaving the real account with no
    // profile or workspace. Release the email; the placeholder keeps its id,
    // memberships and data, and nothing is handed to the new account.
    const released = await tx.update(schema.users)
      .set({ normalizedEmail: sql`left(${schema.users.normalizedEmail}, 260) || '#unclaimed-' || ${schema.users.id}::text`, updatedAt: new Date() })
      .where(and(
        eq(schema.users.normalizedEmail, normalizedEmail),
        ne(schema.users.id, user.id),
        sql`NOT EXISTS (SELECT 1 FROM auth_users WHERE auth_users.id = ${schema.users.id})`,
      ))
      .returning({ id: schema.users.id });
    if (released.length) options.onEmailReleased?.(released.map((row) => row.id));

    await tx.insert(schema.users).values({
      id: user.id,
      email: user.email,
      normalizedEmail,
      displayName: user.name,
      avatarUrl: user.image ?? null,
    }).onConflictDoNothing({ target: schema.users.id });

    if (consent) {
      await tx.execute(sql`
        UPDATE users
        SET terms_accepted_at = COALESCE(terms_accepted_at, ${consent.acceptedAt}),
            terms_version = CASE WHEN terms_accepted_at IS NULL THEN ${consent.termsVersion} ELSE terms_version END
        WHERE id = ${user.id}
      `);
    }
    // Self-healing only restores product data. It must never invent legal consent
    // for an auth user whose original signup evidence is unavailable.

    await tx.insert(schema.workspaces).values({
      id: deterministicWorkspaceId,
      name: workspaceName,
      slug,
      status: "active",
      defaultTimezone: "UTC",
      dailySendCap: 200,
      killSwitchEnabled: false,
      createdByUserId: user.id,
    }).onConflictDoNothing();

    const [workspace] = await tx.select({ id: schema.workspaces.id }).from(schema.workspaces).where(or(
      eq(schema.workspaces.id, deterministicWorkspaceId),
      eq(schema.workspaces.slug, slug),
    )).limit(1);
    if (!workspace) throw new Error("Workspace provisioning did not resolve a workspace.");

    await tx.insert(schema.memberships).values({
      id: randomUUID(),
      workspaceId: workspace.id,
      userId: user.id,
      role: "owner",
      status: "active",
      joinedAt: new Date(),
    }).onConflictDoNothing({ target: [schema.memberships.workspaceId, schema.memberships.userId] });

    return workspace.id;
  });
}

// True once the instance has any sign-in account. The 0002 bootstrap owner is a
// profile row (users) with no auth_users row behind it, so it never counts.
export async function hasSignInAccount(db: InboxJoyDb): Promise<boolean> {
  const [row] = await db.select({ id: schema.authUsers.id }).from(schema.authUsers).limit(1);
  return Boolean(row);
}

// The workspace of the pending, unexpired invitation `token` links to, when it
// was sent to exactly this address; null otherwise. A matching address alone
// proves nothing (anyone can type an invited address), so sign-up through an
// invitation must present the invitation's token: docs/regression-guardrails.md
// section 14.
export async function invitedWorkspaceForToken(db: InboxJoyDb, normalizedEmail: string, token: unknown): Promise<string | null> {
  const invitation = await findInvitationByToken(db, token);
  if (!invitation || invitation.normalizedEmail !== normalizedEmail || invitation.acceptedAt || invitation.expiresAt <= new Date()) return null;
  return invitation.workspaceId;
}

// True when the instance's owner (its oldest sign-in account: the one setup
// admitted) is an active member, in any role, of this workspace. Invite-only
// sign-up admits a new account only into such a workspace; otherwise every
// invitee, who owns a personal workspace and may invite, could admit more.
export async function instanceOwnerBelongsTo(db: InboxJoyDb, workspaceId: string): Promise<boolean> {
  const [row] = await db.select({ id: schema.memberships.id }).from(schema.memberships).where(and(
    eq(schema.memberships.workspaceId, workspaceId),
    eq(schema.memberships.status, "active"),
    eq(schema.memberships.userId, sql`(SELECT ${schema.authUsers.id} FROM ${schema.authUsers} ORDER BY ${schema.authUsers.createdAt}, ${schema.authUsers.id} LIMIT 1)`),
  )).limit(1);
  return Boolean(row);
}

// Constant-time comparison of the sign-up body's setup token with SETUP_TOKEN.
// Hashing both first gives equal lengths, so a wrong length leaks nothing.
export function setupTokenMatches(expected: string, provided: unknown): boolean {
  if (typeof provided !== "string" || provided.length === 0 || provided.length > 512) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(expected), digest(provided.trim()));
}

// Lets exactly one sign-up become the instance's first account. better-auth
// inserts the auth_users row after the create hook returns, on another
// connection, so "no account exists yet" alone would admit two concurrent
// sign-ups. Claimers serialize on an advisory lock and leave a short-lived claim
// (the email, in auth_verifications) that later claimers see until the account
// row exists. A claim whose sign-up then failed expires, so setup can be retried.
export async function claimFirstAccount(db: InboxJoyDb, normalizedEmail: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${firstAccountClaimIdentifier}))`);
    const [account] = await tx.select({ id: schema.authUsers.id }).from(schema.authUsers).limit(1);
    if (account) return false;
    const now = new Date();
    const [claim] = await tx.select({ value: schema.authVerifications.value }).from(schema.authVerifications)
      .where(and(eq(schema.authVerifications.identifier, firstAccountClaimIdentifier), gt(schema.authVerifications.expiresAt, now)))
      .limit(1);
    if (claim && claim.value !== normalizedEmail) return false;
    await tx.delete(schema.authVerifications).where(eq(schema.authVerifications.identifier, firstAccountClaimIdentifier));
    await tx.insert(schema.authVerifications).values({
      id: randomUUID(),
      identifier: firstAccountClaimIdentifier,
      value: normalizedEmail,
      expiresAt: new Date(now.getTime() + firstAccountClaimTtlMs),
    });
    return true;
  });
}

export type SignupAdmission = "open" | "invitation" | "first_account";

export type SignupPolicy = {
  mode: SignupMode;
  edition: Edition;
  // SETUP_TOKEN; only ever set on self-host (resolveSetupToken).
  setupToken?: string;
};

// What the sign-up request carries besides the account fields.
export type SignupRequest = {
  email: string;
  inviteToken?: unknown;
  setupToken?: unknown;
};

export type SignupDecision =
  | { admitted: true; reason: SignupAdmission; emailVerified: boolean }
  | { admitted: false; code: typeof SIGNUP_CLOSED_CODE | typeof SETUP_TOKEN_REQUIRED_CODE };

// The server-side sign-up rule:
// why this account may be created and whether it starts email-verified, or why
// it may not be created.
// - Cloud with open sign-up admits everyone, unverified.
// - A valid invitation token for this exact address admits in either mode; in
//   invite mode only when the instance owner belongs to the inviting workspace,
//   so an invitee cannot open the server by inviting from their own workspace.
//   On self-host the account starts verified: a verified owner handed this
//   person the link, and a fresh server may have no system email to verify with.
// - The instance's first account (race-safe claim) becomes its owner. On
//   self-host it starts verified in either mode, and needs SETUP_TOKEN when set.
// - Anyone else: open mode admits them unverified; invite mode refuses.
export async function admitSignup(db: InboxJoyDb, policy: SignupPolicy, request: SignupRequest): Promise<SignupDecision> {
  const selfhost = policy.edition === "selfhost";
  if (!selfhost && policy.mode === "open") return { admitted: true, reason: "open", emailVerified: false };
  const normalizedEmail = request.email.trim().toLowerCase();
  const invitedWorkspaceId = request.inviteToken === undefined ? null : await invitedWorkspaceForToken(db, normalizedEmail, request.inviteToken);
  if (invitedWorkspaceId && (policy.mode === "open" || await instanceOwnerBelongsTo(db, invitedWorkspaceId))) {
    return { admitted: true, reason: "invitation", emailVerified: selfhost };
  }
  if (!(await hasSignInAccount(db))) {
    // Check the token before claiming, so a sign-up without it cannot hold the
    // claim and lock the real owner out while the claim lasts.
    if (selfhost && policy.setupToken && !setupTokenMatches(policy.setupToken, request.setupToken)) {
      return { admitted: false, code: SETUP_TOKEN_REQUIRED_CODE };
    }
    if (await claimFirstAccount(db, normalizedEmail)) return { admitted: true, reason: "first_account", emailVerified: selfhost };
  }
  if (policy.mode === "open") return { admitted: true, reason: "open", emailVerified: false };
  return { admitted: false, code: SIGNUP_CLOSED_CODE };
}

// The sign-up body fields the admission rule reads. better-auth hands the
// endpoint context (with its parsed body) to the create hook; an account
// created any other way has no such body and carries no tokens.
function signupRequestFields(context: unknown): { inviteToken?: unknown; setupToken?: unknown } {
  const body = context && typeof context === "object" ? (context as { body?: unknown }).body : undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const fields = body as Record<string, unknown>;
  return { inviteToken: fields.inviteToken, setupToken: fields.setupToken };
}

export function createAuth(env: AppEnv, db: InboxJoyDb, options: CreateAuthOptions = {}) {
  // better-auth uses baseURL both to MATCH incoming requests and to BUILD email
  // links. Caddy strips the public /api prefix before proxying, so matching must
  // use the bare origin — but the links users click must keep /api or they 404
  // on the web app. Match on origin; rewrite outgoing link prefixes below.
  const authPublicUrl = new URL(env.BETTER_AUTH_URL ?? env.API_BASE_URL);
  const authBaseUrl = authPublicUrl.origin;
  const publicAuthPrefix = `${authPublicUrl.origin}${authPublicUrl.pathname === "/" ? "" : authPublicUrl.pathname.replace(/\/+$/, "")}`;
  const toPublicUrl = (url: string) =>
    url.startsWith(authBaseUrl) ? `${publicAuthPrefix}${url.slice(authBaseUrl.length)}` : url;
  const transactionalEmail = options.transactionalEmail ?? transactionalEmailFromEnv(env);
  const emailCallbacks = createAuthEmailCallbacks(transactionalEmail, options.onEmailFailure);
  const onAffiliateAttributionFailure = options.onAffiliateAttributionFailure ?? (() => {});
  const runInBackground = options.runInBackground ?? ((task: Promise<unknown>) => {
    void task.catch(() => {});
  });
  const edition = resolveEdition(env);
  const isCloud = edition === "cloud";
  const signupPolicy: SignupPolicy = { mode: resolveSignupMode(env), edition, setupToken: resolveSetupToken(env) };

  return betterAuth({
    baseURL: authBaseUrl,
    basePath: "/v1/auth",
    secret: env.BETTER_AUTH_SECRET ?? env.AUTH_SECRET,
    trustedOrigins: [env.WEB_BASE_URL],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        authUser: schema.authUsers,
        authSession: schema.authSessions,
        authAccount: schema.authAccounts,
        authVerification: schema.authVerifications,
      },
    }),
    user: {
      modelName: "authUser",
      additionalFields: {
        acceptedTerms: {
          type: "boolean",
          required: false,
          defaultValue: false,
          returned: false,
        },
      },
    },
    session: { modelName: "authSession" },
    account: { modelName: "authAccount" },
    verification: { modelName: "authVerification" },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      autoSignIn: true,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: passwordResetExpiresInSeconds,
      sendResetPassword: async ({ user, url }) => {
        await emailCallbacks.sendPasswordReset(user, toPublicUrl(url));
      },
    },
    emailVerification: {
      expiresIn: emailVerificationExpiresInSeconds,
      sendOnSignUp: true,
      sendOnSignIn: true,
      sendVerificationEmail: async ({ user, url }) => {
        // Accounts verified at creation (self-host owner and invitees who
        // signed up with their link) need no verification email.
        if (user.emailVerified) return;
        await emailCallbacks.sendVerificationEmail(user, toPublicUrl(url));
      },
      afterEmailVerification: async (user) => {
        await emailCallbacks.sendWelcome(user);
      },
    },
    advanced: {
      database: { generateId: () => randomUUID() },
      backgroundTasks: { handler: runInBackground },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user, context) => {
            // The Terms and Privacy pages exist only on the managed service.
            if (isCloud && context?.path === "/sign-up/email" && user.acceptedTerms !== true) {
              throw new APIError("BAD_REQUEST", { message: termsAcceptanceMessage });
            }
            // Every way of creating an account passes through this hook, so no
            // other auth endpoint can skip the sign-up mode.
            const decision = await admitSignup(db, signupPolicy, { email: user.email, ...signupRequestFields(context) });
            if (!decision.admitted) {
              throw decision.code === SETUP_TOKEN_REQUIRED_CODE
                ? new APIError("FORBIDDEN", { message: setupTokenRequiredMessage, code: SETUP_TOKEN_REQUIRED_CODE })
                : new APIError("FORBIDDEN", { message: signupClosedMessage, code: SIGNUP_CLOSED_CODE });
            }
            // Self-host: the first owner, and anyone signing up with their
            // invitation link, start verified (canSend blocks campaigns for an
            // unverified owner, and a fresh server may not send mail yet). Cloud
            // accounts always verify by email: docs/regression-guardrails.md section 14.
            if (decision.emailVerified) {
              return { data: { ...user, emailVerified: true } };
            }
          },
          after: async (user, context) => {
            const isRealSignup = context?.path === "/sign-up/email";
            const consent = isRealSignup && user.acceptedTerms === true
              ? { acceptedAt: new Date(), termsVersion: currentTermsVersion }
              : undefined;
            const workspaceId = await provisionWorkspace(db, user, consent, {
              onEmailReleased: (placeholderUserIds) => console.warn(JSON.stringify({ msg: "released email held by placeholder profile", userId: user.id, placeholderUserIds })),
            });

            // Affiliate attribution must never fail or delay a signup, and only
            // applies to real signups on the managed service (self-host has no
            // affiliate program) -- never to the self-heal provisionWorkspace
            // call in app.ts's request hook (an existing auth user with no
            // membership), which has no sign-up context and would misattribute an
            // unrelated later request as a new referral.
            if (isRealSignup && isCloud) {
              try {
                const rawCode = context?.getCookie(AFFILIATE_COOKIE_NAME) ?? null;
                const code = normalizeAffiliateCode(rawCode);
                if (code) {
                  await attributeReferral(db, { code, referredWorkspaceId: workspaceId });
                }
              } catch (error) {
                onAffiliateAttributionFailure(genericErrorInfo(error));
              }
            }

            if (isCloud && transactionalEmail.enabled && env.FOUNDER_ALERT_EMAIL) {
              runInBackground(transactionalEmail.sendSequenceTest({
                recipient: { email: env.FOUNDER_ALERT_EMAIL, name: "InboxJoy" },
                subject: `New InboxJoy signup: ${user.email}`,
                plainText: `${user.name ? `${user.name} — ` : ""}${user.email} just created a workspace.\n\nSigned up at ${new Date().toISOString()}.`,
              }));
            }
          },
        },
      },
    },
  });
}
