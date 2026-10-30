export const CONFIRMING_PAYMENT_KEY = "inboxjoy.checkout.returned-at";
export const PLAN_HINT_KEY = "inboxjoy.plan-hint";

export type BillingStorageKey = typeof CONFIRMING_PAYMENT_KEY | typeof PLAN_HINT_KEY;

export function pendingBillingStorageKey(key: BillingStorageKey): string {
  return `inboxjoy.billing.pending:${key}`;
}

export function workspaceBillingStorageKey(key: BillingStorageKey, workspaceId: string): string {
  return `${key}:${encodeURIComponent(workspaceId)}`;
}

export function migratePendingBillingStorage(workspaceId: string): void {
  for (const key of [PLAN_HINT_KEY, CONFIRMING_PAYMENT_KEY] as const) {
    try {
      const pendingKey = pendingBillingStorageKey(key);
      const value = window.sessionStorage.getItem(pendingKey);
      if (value === null) continue;
      window.sessionStorage.setItem(workspaceBillingStorageKey(key, workspaceId), value);
      window.sessionStorage.removeItem(pendingKey);
    } catch {}
  }
}
