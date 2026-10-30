// Shared owner-email -> workspace id lookup for founder-run admin CLIs
// (affiliate-admin.ts, billing-admin.ts). Mirrors the resolution affiliate-admin.ts
// used before this was factored out: prefer the workspace the user created,
// then fall back to the oldest workspace they actively own.
import { schema, type InboxJoyDb } from "@inboxjoy/db";
import { and, desc, eq } from "drizzle-orm";

export async function resolveWorkspaceIdByOwnerEmail(db: InboxJoyDb, ownerEmail: string): Promise<string> {
  const normalizedEmail = ownerEmail.trim().toLowerCase();
  const [user] = await db.select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.normalizedEmail, normalizedEmail))
    .limit(1);
  if (!user) throw new Error(`No user found for ${ownerEmail}`);

  const [createdWorkspace] = await db.select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.createdByUserId, user.id))
    .limit(1);
  if (createdWorkspace) return createdWorkspace.id;

  const [ownedMembership] = await db.select({ workspaceId: schema.memberships.workspaceId })
    .from(schema.memberships)
    .where(and(
      eq(schema.memberships.userId, user.id),
      eq(schema.memberships.role, "owner"),
      eq(schema.memberships.status, "active"),
    ))
    .orderBy(desc(schema.memberships.joinedAt))
    .limit(1);
  if (ownedMembership) return ownedMembership.workspaceId;

  throw new Error(`No workspace owned by ${ownerEmail}`);
}
