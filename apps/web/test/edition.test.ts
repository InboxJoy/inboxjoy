import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getEdition, getRequestEdition } from "../lib/edition";
import { editionFeatures, isMarketingPath, MARKETING_SEGMENTS } from "../lib/edition-features";
import { editionMetadata } from "../lib/edition-metadata";
import { navItems, navItemsForEdition } from "../lib/navigation";
import { config, proxy } from "../proxy";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

// MarketingRoutesOnly reads the pathname; notFound() and redirect() stay real.
const navigation = vi.hoisted(() => ({ pathname: "/" as string | null }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => navigation.pathname,
}));

// connection() is what opts a route out of prerendering; outside a Next
// request it throws, so record the call instead.
const { connection } = vi.hoisted(() => ({ connection: vi.fn(async () => {}) }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection }));

function source(path: string) {
  return readFileSync(join(webRoot, path), "utf8");
}

function sourceFiles(dirs: string[]): string[] {
  return dirs.flatMap((dir) => readdirSync(join(webRoot, dir), { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => `${dir}/${file.split(sep).join("/")}`));
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("edition features", () => {
  it("ships the commercial layer in cloud only", () => {
    expect(editionFeatures("cloud")).toEqual({ billing: true, affiliate: true, piqo: true, marketingSite: true });
    expect(editionFeatures("selfhost")).toEqual({ billing: false, affiliate: false, piqo: false, marketingSite: false });
  });

  it("reads the edition from the running environment on every call", () => {
    vi.stubEnv("INBOXJOY_EDITION", "cloud");
    expect(getEdition()).toBe("cloud");
    vi.stubEnv("INBOXJOY_EDITION", "selfhost");
    expect(getEdition()).toBe("selfhost");
    vi.stubEnv("INBOXJOY_EDITION", "");
    expect(getEdition()).toBe("selfhost");
  });

  it("keeps the root layout static and edition-agnostic, so the marketing site is prerendered", () => {
    // Anything the root layout reads from the edition would be frozen at build
    // time (images are built without the variable), and a request API there
    // would render every marketing page per request.
    const layout = source("app/layout.tsx");
    expect(layout).not.toContain("force-dynamic");
    expect(layout).not.toMatch(/getEdition\(|getRequestEdition\(|<EditionProvider|<EditionScope|connection\(|headers\(|cookies\(/);
    expect(layout).not.toContain("NEXT_PUBLIC_INBOXJOY_EDITION");
    expect(source("lib/edition.ts")).not.toContain("NEXT_PUBLIC_");
  });

  it("reads the edition synchronously only where the route already renders per request", () => {
    // getRequestEdition() makes its route dynamic by itself. getEdition() does
    // not, so a page calling it must sit under /app or /docs, whose layouts
    // render per request, or opt out of prerendering itself (route handlers).
    const readers = sourceFiles(["app", "components"]).filter((file) => /\bgetEdition\(/.test(source(file)));
    expect(readers).toEqual(expect.arrayContaining(["app/robots.ts", "app/app/(product)/settings/billing/layout.tsx"]));
    for (const file of readers) {
      const perRequest = source(file).includes('export const dynamic = "force-dynamic";') || file.startsWith("app/app/") || file.startsWith("app/docs/");
      expect(perRequest, file).toBe(true);
    }
    for (const layout of ["app/app/layout.tsx", "app/docs/layout.tsx"]) {
      expect(source(layout), layout).toMatch(/generateMetadata\(\)[\s\S]*editionMetadata\(await getRequestEdition\(\)\)/);
      expect(source(layout), layout).toMatch(/<EditionScope edition=/);
    }
  });

  it("renders a route that reads the edition per request", async () => {
    vi.stubEnv("INBOXJOY_EDITION", "cloud");
    connection.mockClear();
    expect(await getRequestEdition()).toBe("cloud");
    expect(connection).toHaveBeenCalledOnce();
  });

  it("leaves PostHog opt-in by its own key in both editions", () => {
    expect(source("instrumentation-client.ts")).toContain("if (token) {");
    expect(source("components/session-recording-gate.tsx")).toContain("NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN");
  });

  it("describes the edition in the meta description", () => {
    const layout = source("app/layout.tsx");
    expect(layout).toContain("$79 lifetime, or self-host free.");
    expect(layout).not.toMatch(/start free|free plan|10,000 sends/i);
  });
});

describe("EditionProvider", () => {
  beforeEach(() => { vi.stubGlobal("React", React); });

  async function probe(edition?: "cloud" | "selfhost") {
    const { EditionProvider, useEdition, useEditionFeatures } = await import("../components/edition-provider");
    const Probe = () => React.createElement("span", null, `${useEdition()}:${String(useEditionFeatures().billing)}`);
    const tree = React.createElement(Probe);
    return renderToStaticMarkup(edition ? React.createElement(EditionProvider, { edition, children: tree }) : tree);
  }

  it("gives client components the edition the layout read", async () => {
    expect(await probe("cloud")).toBe("<span>cloud:true</span>");
    expect(await probe("selfhost")).toBe("<span>selfhost:false</span>");
  });

  it("fails loudly outside the provider instead of guessing an edition", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(probe()).rejects.toThrow("useEdition must be used inside EditionProvider.");
    error.mockRestore();
  });
});

describe("hosted-only extras", () => {
  beforeEach(() => { vi.stubGlobal("React", React); });

  function elementTypes(node: React.ReactNode): unknown[] {
    return React.Children.toArray(node).flatMap((child) => React.isValidElement<{ children?: React.ReactNode }>(child)
      ? [child.type, ...elementTypes(child.props.children)]
      : []);
  }

  it("mounts the JSON-LD, ?ref= capture and Piqo for cloud and nothing for self-host", async () => {
    const { HostedSiteExtras } = await import("../components/edition-scope");
    const { PiqoAnalytics } = await import("../components/piqo-analytics");
    const { AffiliateRefCapture } = await import("../components/affiliate-ref-capture");
    expect(elementTypes(HostedSiteExtras({ edition: "cloud" }))).toEqual(expect.arrayContaining([PiqoAnalytics, AffiliateRefCapture, "script"]));
    expect(elementTypes(HostedSiteExtras({ edition: "selfhost" })).filter((type) => type !== React.Fragment)).toEqual([]);
    expect(renderToStaticMarkup(HostedSiteExtras({ edition: "cloud" }))).toContain('<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization"');
    expect(renderToStaticMarkup(HostedSiteExtras({ edition: "selfhost" }))).toBe("");
  });

  it("wraps the pages both editions serve in the edition and its extras", async () => {
    const { EditionScope } = await import("../components/edition-scope");
    const { useEditionFeatures } = await import("../components/edition-provider");
    const Probe = () => React.createElement("span", null, `billing:${String(useEditionFeatures().billing)}`);
    const render = (edition: "cloud" | "selfhost") => renderToStaticMarkup(React.createElement(EditionScope, { edition, children: React.createElement(Probe) }));
    expect(render("selfhost")).toBe("<span>billing:false</span>");
    expect(render("cloud")).toMatch(/^<script type="application\/ld\+json">[\s\S]*<span>billing:true<\/span>$/);
  });

  it("mounts the root layout's cloud extras on marketing routes only, which self-host never serves", async () => {
    const { MarketingRoutesOnly } = await import("../components/edition-provider");
    const render = (pathname: string | null) => {
      navigation.pathname = pathname;
      return renderToStaticMarkup(React.createElement(MarketingRoutesOnly, null, React.createElement("i")));
    };
    for (const path of ["/", "/pricing", "/alternatives/instantly", "/use-cases/founders", "/terms"]) expect(render(path), path).toBe("<i></i>");
    for (const path of ["/app", "/app/login", "/docs", "/docs/mcp", "/dashboard", "/missing", null]) expect(render(path), String(path)).toBe("");
    expect(source("app/layout.tsx")).toContain('<MarketingRoutesOnly><HostedSiteExtras edition="cloud" /></MarketingRoutesOnly>');
  });
});

describe("edition metadata", () => {
  it("keeps a self-hosted instance out of search engines and off the hosted canonical", () => {
    expect(editionMetadata("cloud")).toEqual({});
    expect(editionMetadata("selfhost")).toMatchObject({ robots: { index: false, follow: false }, alternates: { canonical: null } });
    expect(editionMetadata("selfhost").description).toMatch(/your own server/);
  });

  it("is applied per request by the /app and /docs layouts", async () => {
    const { generateMetadata: appMetadata } = await import("../app/app/layout");
    const { generateMetadata: docsMetadata } = await import("../app/docs/layout");
    for (const generate of [appMetadata, docsMetadata]) {
      connection.mockClear();
      vi.stubEnv("INBOXJOY_EDITION", "selfhost");
      expect(await generate()).toMatchObject({ robots: { index: false, follow: false } });
      vi.stubEnv("INBOXJOY_EDITION", "cloud");
      expect(await generate()).toEqual({});
      expect(connection).toHaveBeenCalledTimes(2);
    }
  });
});

describe("marketing routes", () => {
  it.each(["/", "/pricing", "/pricing/", "/alternatives", "/alternatives/instantly", "/use-cases/founders", "/compare", "/compare/instantly-vs-inboxjoy", "/free-tools", "/free-tools/spf-dkim-dmarc-checker", "/blog", "/blog/some-post", "/terms", "/privacy", "/Pricing"])("treats %s as marketing", (path) => {
    expect(isMarketingPath(path)).toBe(true);
  });

  it.each(["/app", "/app/login", "/app/settings/billing", "/docs", "/docs/mcp", "/oauth/authorize", "/.well-known/openid-configuration", "/api/v1/billing", "/pricingx", "/application", "/llms.txt", "/dashboard"])("keeps %s", (path) => {
    expect(isMarketingPath(path)).toBe(false);
  });

  it("keeps the proxy matcher in step with the marketing segments", () => {
    const matchers = config.matcher;
    expect(matchers).toContain("/");
    expect(matchers.filter((matcher) => matcher !== "/").sort()).toEqual(MARKETING_SEGMENTS.map((segment) => `/${segment}/:path*`).sort());
  });

  it("classifies every top-level page, so a new marketing section can't slip past the proxy", () => {
    // Everything else here is the product, its sign-in pages, docs, OAuth, or a
    // legacy path that redirects into /app.
    const product = new Set(["app", "docs", "oauth", "analytics", "dashboard", "inboxes", "leads", "sequences", "settings"]);
    const pageRoutes = readdirSync(join(webRoot, "app"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
      .filter((entry) => existsSync(join(webRoot, "app", entry.name, "page.tsx")) || existsSync(join(webRoot, "app", entry.name, "layout.tsx")))
      .map((entry) => entry.name);
    const unclassified = pageRoutes.filter((name) => !product.has(name) && !isMarketingPath(`/${name}`));
    expect(unclassified).toEqual([]);
    expect(existsSync(join(webRoot, "app", "page.tsx"))).toBe(true);
  });
});

describe("proxy", () => {
  const request = (path: string) => new NextRequest(`http://web.internal:3000${path}`);

  it("sends marketing and legal routes to the app on self-host, dropping the query", () => {
    vi.stubEnv("INBOXJOY_EDITION", "selfhost");
    for (const path of ["/", "/pricing", "/alternatives/lemlist", "/use-cases", "/free-tools/warmup-calculator", "/blog", "/terms", "/privacy", "/compare/x", "/?ref=abc123&plan=lifetime"]) {
      const response = proxy(request(path));
      expect(response.status, path).toBe(307);
      expect(response.headers.get("location"), path).toBe("http://web.internal:3000/app");
    }
  });

  it("leaves the product, docs and OAuth alone on self-host", () => {
    vi.stubEnv("INBOXJOY_EDITION", "selfhost");
    for (const path of ["/app", "/app/signup", "/docs/quickstart", "/oauth/token", "/api/v1/health"]) {
      const response = proxy(request(path));
      expect(response.status, path).toBe(200);
      expect(response.headers.get("location"), path).toBeNull();
      expect(response.headers.get("x-middleware-next"), path).toBe("1");
    }
  });

  it("changes nothing on cloud", () => {
    vi.stubEnv("INBOXJOY_EDITION", "cloud");
    for (const path of ["/", "/pricing", "/terms", "/blog", "/app"]) {
      const response = proxy(request(path));
      expect(response.headers.get("location"), path).toBeNull();
      expect(response.headers.get("x-middleware-next"), path).toBe("1");
    }
  });

  it("decides per request from the environment it is running in", () => {
    vi.stubEnv("INBOXJOY_EDITION", "cloud");
    expect(proxy(request("/pricing")).headers.get("location")).toBeNull();
    vi.stubEnv("INBOXJOY_EDITION", "selfhost");
    expect(proxy(request("/pricing")).headers.get("location")).toBe("http://web.internal:3000/app");
  });
});

describe("product surfaces by edition", () => {
  it("lists Refer & earn in the sidebar and command palette on cloud only", () => {
    expect(navItemsForEdition("cloud").map((item) => item.label)).toEqual(navItems.map((item) => item.label));
    const selfHost = navItemsForEdition("selfhost").map((item) => item.label);
    expect(selfHost).not.toContain("Refer & earn");
    expect(selfHost).toEqual(navItems.filter((item) => item.icon !== "affiliate").map((item) => item.label));
    expect(selfHost).toContain("Settings");
    expect(selfHost).toContain("Docs");
  });

  it("returns a 404 for the affiliate page on self-host", async () => {
    const { default: AffiliateLayout } = await import("../app/app/(product)/affiliate/layout");
    vi.stubEnv("INBOXJOY_EDITION", "selfhost");
    expect(() => AffiliateLayout({ children: "page" })).toThrowError(expect.objectContaining({ digest: expect.stringContaining("404") }));
    vi.stubEnv("INBOXJOY_EDITION", "cloud");
    expect(AffiliateLayout({ children: "page" })).toBe("page");
  });

  it("sends the billing page back to settings on self-host", async () => {
    const { default: BillingLayout } = await import("../app/app/(product)/settings/billing/layout");
    vi.stubEnv("INBOXJOY_EDITION", "selfhost");
    expect(() => BillingLayout({ children: "page" })).toThrowError(expect.objectContaining({ digest: expect.stringMatching(/^NEXT_REDIRECT;[a-z]+;\/app\/settings;/) }));
    vi.stubEnv("INBOXJOY_EDITION", "cloud");
    expect(BillingLayout({ children: "page" })).toBe("page");
  });

  it("drops the Billing tab from settings navigation on self-host", () => {
    const nav = source("app/app/(product)/settings/settings-nav.tsx");
    expect(nav).toContain("useEditionFeatures()");
    expect(nav).toMatch(/slug !== "billing" \|\| billing/);
  });
});
