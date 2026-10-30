import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Vitest compiles TSX with the classic JSX transform (tsconfig keeps jsx: "preserve"
// for Next), so the components under test need React in scope.
(globalThis as { React?: typeof React }).React = React;

vi.mock("@/components/logo", () => ({ Logo: () => null }));
vi.mock("@/components/nav-auth-link", () => ({ NavAuthLink: () => null }));
vi.mock("@/components/sticky-nav", () => ({ StickyNav: () => null }));
vi.mock("@/components/announcement-banner", () => ({ AnnouncementBanner: () => null }));

import { GITHUB_LINK_LABEL, GITHUB_LINK_TOOLTIP, GithubMark, GithubNavLink } from "../components/github-mark";
import { HeroGithubPill } from "../app/_pages/site";
import { SELF_HOST_REPO_URL } from "../lib/site-links";

function source(path: string) {
  return readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
}

describe("GitHub mark", () => {
  it("is a decorative currentColor icon on the 16px grid", () => {
    const html = renderToStaticMarkup(createElement(GithubMark, { size: 18 }));
    expect(html).toContain('viewBox="0 0 16 16"');
    expect(html).toContain('fill="currentColor"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('width="18"');
  });
});

describe("GitHub nav link", () => {
  it("icon variant names itself, explains itself and opens the repo in a new tab", () => {
    const html = renderToStaticMarkup(createElement(GithubNavLink));
    expect(html).toContain(`href="${SELF_HOST_REPO_URL}"`);
    expect(html).toContain('aria-label="InboxJoy on GitHub"');
    expect(html).toContain('title="Open source on GitHub"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(GITHUB_LINK_LABEL).toBe("InboxJoy on GitHub");
    expect(GITHUB_LINK_TOOLTIP).toBe("Open source on GitHub");
  });

  it("menu variant is a labelled row, so it needs no aria-label", () => {
    const html = renderToStaticMarkup(createElement(GithubNavLink, { variant: "menu" }));
    expect(html).toContain("v2-nav-github--menu");
    expect(html).toContain(`href="${SELF_HOST_REPO_URL}"`);
    expect(html).toContain("Open source on GitHub</a>");
    expect(html).not.toContain("aria-label");
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("can be taken out of the tab order while the sticky bar is hidden", () => {
    expect(renderToStaticMarkup(createElement(GithubNavLink, { tabIndex: -1 }))).toContain('tabindex="-1"');
  });

  it("shows in every marketing nav: hero, shared site nav, sticky bar and both mobile menus", () => {
    expect(source("components/sticky-nav.tsx")).toContain("<GithubNavLink tabIndex={shown ? 0 : -1} />");
    const site = source("app/_pages/site.tsx");
    expect(site).toContain("<GithubNavLink />");
    expect(site).toContain('<GithubNavLink variant="menu" />');
    const home = source("app/page.tsx");
    expect(home).toContain("<GithubNavLink />");
    expect(home).toContain('<GithubNavLink variant="menu" />');
  });
});

describe("Hero GitHub pill", () => {
  it("links to the repo in a new tab and reads as open source", () => {
    const html = renderToStaticMarkup(createElement(HeroGithubPill));
    expect(html).toContain('class="v2-hero-github"');
    expect(html).toContain(`href="${SELF_HOST_REPO_URL}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Open source");
    expect(html).toContain("Self-host free");
    expect(html).toContain("on GitHub");
    expect(html).toContain("<svg");
  });

  it("sits above the headline on the home page", () => {
    const home = source("app/page.tsx");
    const pill = home.indexOf("<HeroGithubPill />");
    expect(pill).toBeGreaterThan(-1);
    expect(pill).toBeLessThan(home.indexOf("<h1>"));
  });

  it("does not invent stats such as star counts", () => {
    const text = renderToStaticMarkup(createElement(HeroGithubPill)).replace(/<[^>]*>/g, "");
    expect(text).toBe("Open source · Self-host free on GitHub");
    expect(text).not.toMatch(/\d/);
    expect(text.toLowerCase()).not.toContain("star");
  });
});

describe("Pre-purchase launch copy", () => {
  it("says a campaign can be launched before buying; only sending waits for the license", () => {
    const pricing = source("app/pricing/page.tsx");
    expect(pricing).toContain("launch a campaign before you buy");
    expect(pricing).toContain("Campaign emails start sending once you have the license");
    for (const page of [pricing, source("app/terms/page.tsx")]) {
      expect(page).not.toContain("Launching a campaign needs");
      expect(page).not.toContain("launching campaigns needs");
      expect(page).not.toContain("to launch campaigns");
      expect(page).not.toContain("cannot be launched");
    }
  });
});
