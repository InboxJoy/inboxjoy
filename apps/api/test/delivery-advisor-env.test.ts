import { deliveryAdvisorWorkspaceIds, isDeliveryAdvisorEnabled, loadAppEnv } from "@inboxjoy/config";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

describe("delivery advisor workspace allowlist", () => {
  const parse = (overrides: NodeJS.ProcessEnv = {}) => loadAppEnv({ DATABASE_URL: "postgresql://localhost/inboxjoy_test", ...overrides });

  it("defaults to empty, which disables the feature for every workspace", () => {
    const env = parse();
    expect(env.DELIVERY_ADVISOR_WORKSPACE_IDS).toEqual([]);
    expect(deliveryAdvisorWorkspaceIds(env)).toEqual(new Set());
    expect(isDeliveryAdvisorEnabled(env, randomUUID())).toBe(false);
  });

  it("parses a comma-separated allowlist and enables only listed workspaces", () => {
    const allowed = randomUUID();
    const other = randomUUID();
    const env = parse({ DELIVERY_ADVISOR_WORKSPACE_IDS: ` ${allowed} , ${other} ` });
    expect(deliveryAdvisorWorkspaceIds(env)).toEqual(new Set([allowed.toLowerCase(), other.toLowerCase()]));
    expect(isDeliveryAdvisorEnabled(env, allowed)).toBe(true);
    expect(isDeliveryAdvisorEnabled(env, allowed.toUpperCase())).toBe(true);
    expect(isDeliveryAdvisorEnabled(env, randomUUID())).toBe(false);
  });

  it("rejects a malformed entry instead of silently dropping it", () => {
    expect(() => parse({ DELIVERY_ADVISOR_WORKSPACE_IDS: "not-a-uuid" })).toThrow();
    expect(() => parse({ DELIVERY_ADVISOR_WORKSPACE_IDS: `${randomUUID()},not-a-uuid` })).toThrow();
  });
});
