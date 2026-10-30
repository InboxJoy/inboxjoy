"use client";

import { sendPiqoEvent } from "@/lib/piqo";

export type AnalyticsEvent =
  | "signup_completed"
  | "checkout_started"
  | "checkout_completed"
  | "mailbox_connect_started"
  | "mailbox_connect_succeeded"
  | "mailbox_connect_failed"
  | "leads_imported"
  | "campaign_created"
  | "campaign_launched"
  | "guide_signup"
  | "verify_email_resent";

// Piqo stores at most 10 props per event, as strings. Never pass emails, names, or user IDs.
type AnalyticsProperties = Record<string, string | number | boolean>;

export function track(event: AnalyticsEvent, properties?: AnalyticsProperties) {
  sendPiqoEvent(event, properties);
}
