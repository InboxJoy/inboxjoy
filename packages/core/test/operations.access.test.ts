import { schema } from "@inboxjoy/db";
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { operationByName, operations, runOperation, type OperationContext } from "../src/index.js";
import { prepareImportedLeads } from "../src/mcp-ops.js";
import { MCP_ADMIN_OPERATIONS, operationAvailableInEdition } from "../src/mcp-admin-operations.js";

describe("operation registry metadata", () => {
  it("declares access and zod schemas for every operation", () => {
    expect(operations.length).toBeGreaterThan(0);
    expect(operations.map((operation) => operation.name)).toEqual(expect.arrayContaining([
      "leads.import",
      "leads.get",
      "campaigns.setLeadVariables",
      "campaigns.getLeadVariables",
      "campaigns.listLeadVariableNames",
      "sequences.get",
      "sequences.setMailboxes",
      "sequences.launch",
      "enrollments.list",
      "replies.list",
      "analytics.overview",
      "reports.campaign",
      "workspaces.list",
      "workspaces.switch",
    ]));
    for (const operation of operations) {
      expect(["read", "write"]).toContain(operation.access);
      expect(operation.inputSchema).toHaveProperty("parse");
      expect(typeof operation.inputSchema.parse).toBe("function");
      expect(operation.outputSchema).toHaveProperty("parse");
      expect(typeof operation.outputSchema.parse).toBe("function");
    }
  });

  it("publishes session workspace operations with read/write access and UUID-only switching", () => {
    const list = operationByName.get("workspaces.list")!;
    const switchWorkspace = operationByName.get("workspaces.switch")!;
    expect(list.access).toBe("read");
    expect(list.inputSchema.parse({})).toEqual({});
    expect(switchWorkspace.access).toBe("write");
    const workspaceId = randomUUID();
    expect(switchWorkspace.inputSchema.parse({ workspaceId })).toEqual({ workspaceId });
    expect(switchWorkspace.inputSchema.safeParse({ workspaceId: "not-a-uuid" }).success).toBe(false);
    expect(switchWorkspace.inputSchema.safeParse({}).success).toBe(false);
  });

  it("publishes role changes with write access and only admin/member roles", () => {
    const operation = operationByName.get("team.memberRoleChange")!;
    const membershipId = randomUUID();
    expect(operation.access).toBe("write");
    for (const role of ["admin", "member"]) {
      expect(operation.inputSchema.parse({ id: membershipId, role })).toEqual({ id: membershipId, role });
      expect(operation.outputSchema.parse({ id: membershipId, role })).toEqual({ id: membershipId, role });
    }
    expect(operation.inputSchema.safeParse({ id: membershipId, role: "owner" }).success).toBe(false);
    expect(operation.inputSchema.safeParse({ id: membershipId }).success).toBe(false);
    expect(operation.inputSchema.safeParse({ id: "not-a-uuid", role: "admin" }).success).toBe(false);
  });

  it("publishes backward-compatible multi-list campaign and enrollment inputs", () => {
    const firstListId = randomUUID();
    const secondListId = randomUUID();
    for (const name of ["campaigns.create", "campaigns.update", "sequences.enroll", "sequences.launch"]) {
      const operation = operationByName.get(name);
      if (!operation) throw new Error(`Missing operation ${name}`);
      const base = name === "campaigns.create" ? { name: "Campaign", sequenceId: randomUUID(), inboxId: randomUUID() } : { id: randomUUID() };
      expect(operation.inputSchema.parse({ ...base, listIds: [firstListId, secondListId, firstListId] })).toMatchObject({ listIds: [firstListId, secondListId] });
      expect(operation.description).toContain("listIds");
    }

    const create = operationByName.get("campaigns.create")!;
    expect(create.inputSchema.parse({ name: "Legacy", sequenceId: randomUUID(), inboxId: randomUUID(), listId: firstListId })).toMatchObject({ listId: firstListId });
    expect(create.inputSchema.parse({ name: "All leads", sequenceId: randomUUID(), inboxId: randomUUID(), listId: null })).toMatchObject({ listId: null });
    expect(() => create.inputSchema.parse({ name: "Too many", sequenceId: randomUUID(), inboxId: randomUUID(), listIds: Array.from({ length: 21 }, () => randomUUID()) })).toThrow();
  });

  it("publishes deduplicated saved mailbox selections with a 50-mailbox limit", () => {
    const mailboxId = randomUUID();
    for (const name of ["sequences.setMailboxes", "sequences.launch"]) {
      const operation = operationByName.get(name)!;
      expect(operation.access).toBe("write");
      expect(operation.inputSchema.parse({ id: randomUUID(), mailboxIds: [mailboxId, mailboxId] })).toMatchObject({ mailboxIds: [mailboxId] });
      expect(operation.inputSchema.parse({ id: randomUUID(), mailboxIds: [] })).toMatchObject({ mailboxIds: [] });
      expect(operation.inputSchema.safeParse({ id: randomUUID(), mailboxIds: Array.from({ length: 51 }, () => randomUUID()) }).success).toBe(false);
      expect(operation.inputSchema.safeParse({ id: randomUUID(), mailboxIds: ["not-a-uuid"] }).success).toBe(false);
    }
    expect(operationByName.get("sequences.setMailboxes")!.inputSchema.safeParse({ id: randomUUID() }).success).toBe(false);
  });
});

describe("MCP admin operation deny-list", () => {
  it("keeps every deny-listed operation name in sync with the registry", () => {
    const names = new Set(operations.map((operation) => operation.name));
    for (const denied of MCP_ADMIN_OPERATIONS) {
      expect(names.has(denied)).toBe(true);
    }
  });

  it("tags every deny-listed operation read or write", () => {
    for (const operation of operations) {
      if (MCP_ADMIN_OPERATIONS.has(operation.name)) {
        expect(["read", "write"]).toContain(operation.access);
      }
    }
  });

  it("excludes every registered administrative operation", () => {
    for (const operation of operations) {
      if (/^(apiKeys|team|workspaces|billing)\./.test(operation.name)
        || ["suppressions.remove", "sequences.delete", "workspace.delete"].includes(operation.name)) {
        expect(MCP_ADMIN_OPERATIONS.has(operation.name), operation.name).toBe(true);
      }
    }
  });
});

describe("edition-only operations", () => {
  it("hides the affiliate program from self-host and keeps everything else", () => {
    const affiliate = operations.filter((operation) => operation.name.startsWith("affiliate."));
    expect(affiliate.map((operation) => operation.name)).toEqual(expect.arrayContaining(["affiliate.get", "affiliate.listReferrals"]));
    for (const operation of operations) {
      expect(operationAvailableInEdition(operation.name, "cloud"), operation.name).toBe(true);
      expect(operationAvailableInEdition(operation.name, "selfhost"), operation.name).toBe(!operation.name.startsWith("affiliate."));
    }
    // billing.get answers in self-host; the billing writes refuse with not_available.
    expect(operationAvailableInEdition("billing.get", "selfhost")).toBe(true);
  });
});

describe("operation role gates", () => {
  const managerOperations = [
    "sequences.publish",
    "sequences.pause",
    "sequences.resume",
    "sequences.archive",
    "sequences.setMailboxes",
    "sequences.enroll",
    "sequences.launch",
    "campaigns.launch",
    "campaigns.pause",
    "campaigns.resume",
    "campaigns.archive",
  ];
  const ownerOperations = ["sequences.delete", "suppressions.remove", "team.memberRoleChange"];

  function inputFor(name: string): unknown {
    if (name === "team.memberRoleChange") return { id: randomUUID(), role: "admin" };
    if (name === "sequences.setMailboxes") return { id: randomUUID(), mailboxIds: [] };
    return name === "sequences.enroll" ? { id: randomUUID(), leadIds: [randomUUID()] } : { id: randomUUID() };
  }

  function roleContext(role: "admin" | "member"): { context: OperationContext; passedRoleGate: Error } {
    const passedRoleGate = new Error("passed role gate");
    const db = {
      select: () => ({
        from: (table: unknown) => {
          if (table !== schema.memberships) throw passedRoleGate;
          return {
            where: () => ({ limit: async () => [{ role }] }),
            innerJoin: () => { throw passedRoleGate; },
          };
        },
      }),
      transaction: async () => { throw passedRoleGate; },
    } as unknown as OperationContext["db"];
    return {
      context: {
        db,
        workspaceId: randomUUID(),
        userId: randomUUID(),
        env: { edition: "selfhost", authSecret: "role-gate-test-auth-secret-at-least-32-chars", apiBaseUrl: "https://api.example.test" },
      },
      passedRoleGate,
    };
  }

  it("forbids members from every manager and owner operation", async () => {
    for (const name of [...managerOperations, ...ownerOperations]) {
      const operation = operationByName.get(name);
      if (!operation) throw new Error(`Missing operation ${name}`);
      const { context } = roleContext("member");
      await expect(runOperation(operation, context, inputFor(name)), name).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("allows admins through every manager operation gate", async () => {
    for (const name of managerOperations) {
      const operation = operationByName.get(name);
      if (!operation) throw new Error(`Missing operation ${name}`);
      const { context, passedRoleGate } = roleContext("admin");
      await expect(runOperation(operation, context, inputFor(name)), name).rejects.toBe(passedRoleGate);
    }
  });

  it("keeps owner-only operations unavailable to admins", async () => {
    for (const name of ownerOperations) {
      const operation = operationByName.get(name);
      if (!operation) throw new Error(`Missing operation ${name}`);
      const { context } = roleContext("admin");
      await expect(runOperation(operation, context, inputFor(name)), name).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it.each(["sequences.launch", "sequences.enroll", "campaigns.launch"])("blocks %s for an unverified workspace owner", async (name) => {
    const db = {
      select: () => ({
        from: (table: unknown) => {
          if (table !== schema.memberships) throw new Error("unexpected table before verification gate");
          return {
            where: () => ({ limit: async () => [{ role: "owner" }] }),
            innerJoin: () => ({
              where: () => ({
                orderBy: () => ({ limit: async () => [{ emailVerified: false }] }),
              }),
            }),
          };
        },
      }),
    } as unknown as OperationContext["db"];
    const context: OperationContext = {
      db,
      workspaceId: randomUUID(),
      userId: randomUUID(),
      env: { edition: "selfhost", authSecret: "verification-gate-auth-secret-at-least-32-chars", apiBaseUrl: "https://api.example.test" },
    };
    const operation = operationByName.get(name);
    if (!operation) throw new Error(`Missing operation ${name}`);

    await expect(runOperation(operation, context, inputFor(name))).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { code: "email_unverified" },
    });
  });
});

describe("lead variable operations", () => {
  it("publishes setLeadVariables as a write op with exactly one campaign reference and an LLM-facing description", () => {
    const op = operationByName.get("campaigns.setLeadVariables")!;
    expect(op.access).toBe("write");
    for (const phrase of ["MERGE", "built-in", "customFields", "blocked", "enrolled automatically"]) expect(op.description).toContain(phrase);
    const lead = { email: "a@example.com", variables: { icebreaker: "Hi", old: null } };
    expect(op.inputSchema.safeParse({ campaignId: randomUUID(), leads: [lead] }).success).toBe(true);
    expect(op.inputSchema.safeParse({ sequenceId: randomUUID(), leads: [lead] }).success).toBe(true);
    expect(op.inputSchema.safeParse({ leads: [lead] }).success).toBe(false);
    expect(op.inputSchema.safeParse({ campaignId: randomUUID(), sequenceId: randomUUID(), leads: [lead] }).success).toBe(false);
  });

  it("accepts customFields and variables on imported leads", () => {
    const op = operationByName.get("leads.import")!;
    expect(op.inputSchema.safeParse({ sequenceId: randomUUID(), leads: [{ email: "a@example.com", customFields: { topic: "x", gone: null }, variables: { icebreaker: "y" } }] }).success).toBe(true);
    expect(op.inputSchema.safeParse({ sequenceId: randomUUID(), campaignId: randomUUID(), leads: [{ email: "a@example.com" }] }).success).toBe(false);
    expect(prepareImportedLeads([{ email: "a@example.com", customFields: { topic: "x" } }]).leads[0]).toMatchObject({ customFields: { topic: "x" } });
  });
});

describe("lead import preparation", () => {
  it("normalizes and deduplicates emails while preserving the first row", () => {
    expect(prepareImportedLeads([
      { email: " Ada@Example.COM ", firstName: "Ada" },
      { email: "ada@example.com", firstName: "Duplicate" },
    ])).toEqual({
      leads: [{ email: "Ada@Example.COM", normalizedEmail: "ada@example.com", firstName: "Ada" }],
      skippedInvalid: 0,
    });
  });

  it("counts invalid emails without rejecting valid rows", () => {
    expect(prepareImportedLeads([
      { email: "not-an-email" },
      { email: "valid@example.com", company: "InboxJoy" },
    ])).toEqual({
      leads: [{ email: "valid@example.com", normalizedEmail: "valid@example.com", company: "InboxJoy" }],
      skippedInvalid: 1,
    });
  });
});
