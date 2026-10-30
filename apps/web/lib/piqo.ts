import { containsInviteTokenPath } from "@/lib/analytics-privacy";

export const PIQO_SITE_ID = "psznewsy";
export const PIQO_DOMAIN = "inboxjoy.online";
export const PIQO_ORIGIN = "https://piqo.app";

const SCRIPT_ID = "piqo-analytics";
const TRACKED_HOSTS = new Set([PIQO_DOMAIN, `www.${PIQO_DOMAIN}`]);
const PRODUCT_PATH = /^\/(?:app|oauth)(?:\/|$)/i;
const SENSITIVE_ROUTE = /reset-password|mcp\/authorize/i;
const SENSITIVE_QUERY_KEY = /token|auth|email|key|code|secret|state/i;
const MAX_PENDING_EVENTS = 20;

type PiqoProps = Record<string, string | number | boolean>;
type PiqoWindow = Window & {
  piqo?: (name: string, options?: { props: PiqoProps }) => void;
  __inboxjoyPiqoBeaconGuarded?: boolean;
};

const pendingEvents: [string, PiqoProps | undefined][] = [];

/** Production only: the dev stack shares the apex domain and would pollute the stats. */
export function isPiqoHost(hostname: string): boolean {
  return TRACKED_HOSTS.has(hostname.toLowerCase());
}

export function isProductPath(pathname: string): boolean {
  return PRODUCT_PATH.test(pathname);
}

/**
 * Piqo records the full path and query string of every event. Invite, password
 * reset, and OAuth consent URLs carry credentials, so events are held back
 * while one of them is the current page.
 */
export function isSensitiveUrl(href: string): boolean {
  if (!href) return false;
  if (containsInviteTokenPath(href)) return true;
  try {
    const url = new URL(href, `https://${PIQO_DOMAIN}`);
    if (!isProductPath(url.pathname)) return false;
    if (SENSITIVE_ROUTE.test(`${url.pathname}${decodeURIComponent(url.search)}`)) return true;
    return [...url.searchParams.keys()].some((key) => SENSITIVE_QUERY_KEY.test(key));
  } catch {
    return true;
  }
}

// The referrer is sent with every event too, and a hard navigation away from a
// sensitive page leaves that page's full URL in it for the rest of the document.
function onSensitivePage(): boolean {
  const { href, origin } = window.location;
  return isSensitiveUrl(href) || (document.referrer.startsWith(origin) && isSensitiveUrl(document.referrer));
}

// piqo.js posts through sendBeacon and reads the URL at send time. Reporting a
// held-back beacon as sent also keeps its fetch fallback from firing.
function guardPiqoBeacon(): boolean {
  if (typeof navigator.sendBeacon !== "function") return false;
  const piqoWindow = window as PiqoWindow;
  if (piqoWindow.__inboxjoyPiqoBeaconGuarded) return true;
  piqoWindow.__inboxjoyPiqoBeaconGuarded = true;
  const sendBeacon = navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon = (url, data) => {
    if (String(url).startsWith(PIQO_ORIGIN) && onSensitivePage()) return true;
    return sendBeacon(url, data);
  };
  return true;
}

function flushPendingEvents(): void {
  for (const [name, props] of pendingEvents.splice(0)) sendPiqoEvent(name, props);
}

/** Injects the Piqo tracker once. Pageviews and SPA navigations are tracked by the script itself. */
export function loadPiqo(): void {
  if (!isPiqoHost(window.location.hostname) || document.getElementById(SCRIPT_ID)) return;
  if (!guardPiqoBeacon()) return;
  const script = document.createElement("script");
  script.id = SCRIPT_ID;
  script.defer = true;
  script.src = `${PIQO_ORIGIN}/piqo.js`;
  script.dataset.site = PIQO_SITE_ID;
  script.dataset.domain = PIQO_DOMAIN;
  script.addEventListener("load", flushPendingEvents);
  document.head.appendChild(script);
}

/** Custom event. Events fired before the tracker finishes loading are queued and sent on load. */
export function sendPiqoEvent(name: string, props?: PiqoProps): void {
  if (typeof window === "undefined") return;
  const { piqo } = window as PiqoWindow;
  if (piqo) piqo(name, props ? { props } : undefined);
  else if (pendingEvents.length < MAX_PENDING_EVENTS) pendingEvents.push([name, props]);
}
