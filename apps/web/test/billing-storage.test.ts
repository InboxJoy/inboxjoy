import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { billingStorageKey, CONFIRMING_PAYMENT_KEY, confirmingPaymentActive, PLAN_HINT_KEY, readBillingStorage, writeBillingStorage } from "../lib/billing";
import { pendingBillingStorageKey } from "../lib/billing-storage";
import { postAuthDestination, rememberPlanHint } from "../lib/checkout";
import { setWorkspaceId } from "../lib/workspaces";

const values = new Map<string, string>();
const localValues = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); },
  removeItem: (key: string) => { values.delete(key); },
};

beforeEach(() => {
  values.clear();
  localValues.clear();
  vi.stubGlobal("window", { sessionStorage: storage, localStorage: { getItem: (key: string) => localValues.get(key) ?? null } });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("workspace-scoped billing storage", () => {
  it("keeps checkout confirmation and plan hints with their workspace after a switch", () => {
    const returnedAt = String(Date.now());
    setWorkspaceId("workspace-a");
    writeBillingStorage(CONFIRMING_PAYMENT_KEY, returnedAt);
    writeBillingStorage(PLAN_HINT_KEY, "monthly");
    expect(billingStorageKey(PLAN_HINT_KEY)).toBe(`${PLAN_HINT_KEY}:workspace-a`);
    expect(confirmingPaymentActive(readBillingStorage(CONFIRMING_PAYMENT_KEY))).toBe(true);
    setWorkspaceId("workspace-b");
    expect(readBillingStorage(CONFIRMING_PAYMENT_KEY)).toBeNull();
    expect(readBillingStorage(PLAN_HINT_KEY)).toBeNull();
    rememberPlanHint("?plan=lifetime");
    writeBillingStorage(CONFIRMING_PAYMENT_KEY, returnedAt);
    writeBillingStorage(CONFIRMING_PAYMENT_KEY, null);
    expect(readBillingStorage(PLAN_HINT_KEY)).toBe("lifetime");
    expect(readBillingStorage(CONFIRMING_PAYMENT_KEY)).toBeNull();
    setWorkspaceId("workspace-a");
    expect(readBillingStorage(PLAN_HINT_KEY)).toBe("monthly");
    expect(readBillingStorage(CONFIRMING_PAYMENT_KEY)).toBe(returnedAt);
  });

  it("ignores legacy keys in both browser storage areas", () => {
    setWorkspaceId("workspace-a");
    for (const store of [values, localValues]) {
      store.set(CONFIRMING_PAYMENT_KEY, String(Date.now()));
      store.set(PLAN_HINT_KEY, "yearly");
    }
    expect(readBillingStorage(CONFIRMING_PAYMENT_KEY)).toBeNull();
    expect(readBillingStorage(PLAN_HINT_KEY)).toBeNull();
  });

  it("retains checkout confirmation and the hint across a same-workspace page load", () => {
    setWorkspaceId("workspace-a");
    rememberPlanHint("?plan=lifetime");
    writeBillingStorage(CONFIRMING_PAYMENT_KEY, String(Date.now()));
    vi.stubGlobal("window", { sessionStorage: { ...storage } });
    expect(readBillingStorage(PLAN_HINT_KEY)).toBe("lifetime");
    expect(confirmingPaymentActive(readBillingStorage(CONFIRMING_PAYMENT_KEY))).toBe(true);
  });

  it("retains the lifetime hint and checkout return before pinning and migrates them for a reload", async () => {
    const returnedAt = String(Date.now());
    rememberPlanHint("?plan=lifetime");
    writeBillingStorage(CONFIRMING_PAYMENT_KEY, returnedAt);
    expect(billingStorageKey(PLAN_HINT_KEY)).toBe(pendingBillingStorageKey(PLAN_HINT_KEY));
    expect(readBillingStorage(PLAN_HINT_KEY)).toBe("lifetime");
    expect(readBillingStorage(CONFIRMING_PAYMENT_KEY)).toBe(returnedAt);
    vi.stubGlobal("window", { sessionStorage: { ...storage }, location: { search: "" } });
    setWorkspaceId("workspace-a");
    expect(values.get(`${PLAN_HINT_KEY}:workspace-a`)).toBe("lifetime");
    expect(values.get(`${CONFIRMING_PAYMENT_KEY}:workspace-a`)).toBe(returnedAt);
    expect(values.has(pendingBillingStorageKey(PLAN_HINT_KEY))).toBe(false);
    expect(values.has(pendingBillingStorageKey(CONFIRMING_PAYMENT_KEY))).toBe(false);
    vi.resetModules();
    const reloadedBilling = await import("../lib/billing");
    expect(reloadedBilling.readBillingStorage(PLAN_HINT_KEY)).toBe("lifetime");
    expect(reloadedBilling.readBillingStorage(CONFIRMING_PAYMENT_KEY)).toBe(returnedAt);
    expect(confirmingPaymentActive(reloadedBilling.readBillingStorage(CONFIRMING_PAYMENT_KEY))).toBe(true);
  });

  it("retains a lifetime hint across a login invitation redirect and workspace pinning", () => {
    const invitePath = "/app/invite/invitation-token";
    const search = `?plan=lifetime&next=${encodeURIComponent(invitePath)}`;
    rememberPlanHint(search);
    expect(postAuthDestination(search, { useNext: true })).toBe(invitePath);
    vi.stubGlobal("window", { sessionStorage: { ...storage }, location: { pathname: invitePath, search: "" } });
    expect(readBillingStorage(PLAN_HINT_KEY)).toBe("lifetime");
    setWorkspaceId("workspace-a");
    expect(readBillingStorage(PLAN_HINT_KEY)).toBe("lifetime");
    expect(values.has(pendingBillingStorageKey(PLAN_HINT_KEY))).toBe(false);
  });

  it("keeps migrated values isolated when pinning a second workspace", () => {
    const returnedAt = String(Date.now());
    rememberPlanHint("?plan=lifetime");
    writeBillingStorage(CONFIRMING_PAYMENT_KEY, returnedAt);
    setWorkspaceId("workspace-a");
    setWorkspaceId("workspace-b");
    expect(readBillingStorage(PLAN_HINT_KEY)).toBeNull();
    expect(readBillingStorage(CONFIRMING_PAYMENT_KEY)).toBeNull();
    writeBillingStorage(PLAN_HINT_KEY, "monthly");
    const secondReturnedAt = String(Number(returnedAt) + 1);
    writeBillingStorage(CONFIRMING_PAYMENT_KEY, secondReturnedAt);
    setWorkspaceId("workspace-a");
    expect(readBillingStorage(PLAN_HINT_KEY)).toBe("lifetime");
    expect(readBillingStorage(CONFIRMING_PAYMENT_KEY)).toBe(returnedAt);
    setWorkspaceId("workspace-b");
    expect(readBillingStorage(PLAN_HINT_KEY)).toBe("monthly");
    expect(readBillingStorage(CONFIRMING_PAYMENT_KEY)).toBe(secondReturnedAt);
  });

  it("clears pending values before pinning", () => {
    rememberPlanHint("?plan=lifetime");
    writeBillingStorage(CONFIRMING_PAYMENT_KEY, String(Date.now()));
    writeBillingStorage(PLAN_HINT_KEY, null);
    writeBillingStorage(CONFIRMING_PAYMENT_KEY, null);
    expect(readBillingStorage(PLAN_HINT_KEY)).toBeNull();
    expect(readBillingStorage(CONFIRMING_PAYMENT_KEY)).toBeNull();
    setWorkspaceId("workspace-a");
    expect(readBillingStorage(PLAN_HINT_KEY)).toBeNull();
    expect(readBillingStorage(CONFIRMING_PAYMENT_KEY)).toBeNull();
  });

  it("reads scoped values while a workspace is pinned", () => {
    setWorkspaceId("workspace-a");
    values.set(pendingBillingStorageKey(PLAN_HINT_KEY), "yearly");
    values.set(pendingBillingStorageKey(CONFIRMING_PAYMENT_KEY), String(Date.now()));
    writeBillingStorage(PLAN_HINT_KEY, "monthly");
    expect(readBillingStorage(PLAN_HINT_KEY)).toBe("monthly");
    expect(readBillingStorage(CONFIRMING_PAYMENT_KEY)).toBeNull();
  });

  it("retains pending values when pinning fails", () => {
    rememberPlanHint("?plan=lifetime");
    vi.stubGlobal("window", { sessionStorage: { ...storage, setItem: () => { throw new Error("Storage unavailable"); } } });
    expect(() => setWorkspaceId("workspace-a")).not.toThrow();
    expect(readBillingStorage(PLAN_HINT_KEY)).toBe("lifetime");
    expect(values.has(`${PLAN_HINT_KEY}:workspace-a`)).toBe(false);
  });

  it("retains a pending value when migration fails and retries on pinning", () => {
    rememberPlanHint("?plan=lifetime");
    const returnedAt = String(Date.now());
    writeBillingStorage(CONFIRMING_PAYMENT_KEY, returnedAt);
    vi.stubGlobal("window", { sessionStorage: { ...storage, setItem: (key: string, value: string) => {
      if (key === `${PLAN_HINT_KEY}:workspace-a`) throw new Error("Storage unavailable");
      storage.setItem(key, value);
    } } });
    expect(() => setWorkspaceId("workspace-a")).not.toThrow();
    expect(values.get(pendingBillingStorageKey(PLAN_HINT_KEY))).toBe("lifetime");
    expect(readBillingStorage(CONFIRMING_PAYMENT_KEY)).toBe(returnedAt);
    vi.stubGlobal("window", { sessionStorage: storage });
    setWorkspaceId("workspace-a");
    expect(readBillingStorage(PLAN_HINT_KEY)).toBe("lifetime");
    expect(values.has(pendingBillingStorageKey(PLAN_HINT_KEY))).toBe(false);
  });

  it("handles unavailable browser storage and server rendering", () => {
    Object.defineProperty(window, "sessionStorage", { get: () => { throw new Error("Storage unavailable"); } });
    expect(readBillingStorage(PLAN_HINT_KEY)).toBeNull();
    expect(() => writeBillingStorage(PLAN_HINT_KEY, "monthly")).not.toThrow();
    expect(() => setWorkspaceId("workspace-a")).not.toThrow();
    vi.stubGlobal("window", undefined);
    expect(readBillingStorage(CONFIRMING_PAYMENT_KEY)).toBeNull();
    expect(() => writeBillingStorage(CONFIRMING_PAYMENT_KEY, null)).not.toThrow();
    expect(() => setWorkspaceId("workspace-a")).not.toThrow();
  });

  it("handles billing storage failures after reading a valid workspace id", () => {
    vi.stubGlobal("window", { sessionStorage: {
      getItem: (key: string) => { if (key === "inboxjoy.workspace-id") return "workspace-a"; throw new Error("Storage unavailable"); },
      setItem: () => { throw new Error("Storage unavailable"); },
      removeItem: () => { throw new Error("Storage unavailable"); },
    } });
    expect(readBillingStorage(PLAN_HINT_KEY)).toBeNull();
    expect(() => writeBillingStorage(PLAN_HINT_KEY, "monthly")).not.toThrow();
    expect(() => writeBillingStorage(CONFIRMING_PAYMENT_KEY, null)).not.toThrow();
  });

  it("wires each picker storage access through the scoped helpers and retains transient confirmation", () => {
    const picker = readFileSync(fileURLToPath(new URL("../components/plan-picker.tsx", import.meta.url)), "utf8");
    expect(picker).not.toContain("sessionStorage");
    expect(picker).not.toContain("localStorage");
    expect(picker).toContain("hintedPlan ?? readBillingStorage(PLAN_HINT_KEY)");
    expect(picker).toContain("readBillingStorage(CONFIRMING_PAYMENT_KEY) ?? confirmingReturnedAt.current");
    expect(picker).toContain("writeBillingStorage(CONFIRMING_PAYMENT_KEY, confirmingReturnedAt.current)");
  });
});
