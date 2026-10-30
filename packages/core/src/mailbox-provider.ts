export const MAILBOX_PROVIDERS = ["gmail", "outlook", "smtp"] as const;

export type MailboxProvider = (typeof MAILBOX_PROVIDERS)[number];
export type ComposioProvider = "gmail" | "outlook";

export function isComposioProvider(provider: string): provider is ComposioProvider {
  return provider === "gmail" || provider === "outlook";
}

export function assertComposioProvider(provider: string, context: string): asserts provider is ComposioProvider {
  if (!isComposioProvider(provider)) {
    throw new Error(`${context}: provider "${provider}" is not supported by Composio (expected gmail or outlook)`);
  }
}
