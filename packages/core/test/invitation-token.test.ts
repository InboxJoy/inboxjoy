import type { InboxJoyDb } from "@inboxjoy/db";
import { describe, expect, it } from "vitest";

import { findInvitationByToken, invitationTokenWorkspaceId } from "../src/index.js";

const workspaceId = "0b7c6a8e-3f1d-4c2b-9a5e-7d6f8e9a0b1c";

describe("invitation tokens", () => {
  it("reads the workspace from <workspaceId>.<secret>", () => {
    expect(invitationTokenWorkspaceId(`${workspaceId}.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde`)).toBe(workspaceId);
  });

  it("rejects anything that cannot be an invitation token without a lookup", async () => {
    // Any query against this fails the test.
    const noDatabase = new Proxy({}, { get: () => { throw new Error("database used"); } }) as unknown as InboxJoyDb;
    for (const token of [undefined, null, 42, "", "not-a-token", `${"0".repeat(36)}.short`, `${workspaceId}.${"a".repeat(300)}`]) {
      expect(invitationTokenWorkspaceId(token)).toBeNull();
      expect(await findInvitationByToken(noDatabase, token)).toBeNull();
    }
  });
});
