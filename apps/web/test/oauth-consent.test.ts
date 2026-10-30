import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mintConsentToken, rejectCrossSiteRequest, verifyConsentToken, webOrigin } from "../lib/oauth-consent";

const fields = {
  userId: "user-1",
  clientId: "client-1",
  codeChallenge: "challenge-1",
  redirectUri: "https://client.example.test/callback?a=1|2",
  workspaceId: "workspace-1",
};

function post(headers: Record<string, string>): Request {
  return new Request("https://ignored-host.example.test/oauth/authorize", { method: "POST", headers });
}

describe("OAuth consent CSRF helpers", () => {
  const previousEnv = { WEB_BASE_URL: process.env.WEB_BASE_URL, BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET };

  beforeEach(() => {
    process.env.WEB_BASE_URL = "https://app.inboxjoy.test";
    process.env.BETTER_AUTH_SECRET = "consent-unit-test-secret-at-least-32-characters";
  });

  afterEach(() => {
    process.env.WEB_BASE_URL = previousEnv.WEB_BASE_URL;
    process.env.BETTER_AUTH_SECRET = previousEnv.BETTER_AUTH_SECRET;
  });

  it("takes the expected origin from WEB_BASE_URL, never the request host", () => {
    expect(webOrigin()).toBe("https://app.inboxjoy.test");
    expect(rejectCrossSiteRequest(post({ origin: "https://ignored-host.example.test", "sec-fetch-site": "same-origin" }))?.status).toBe(403);
    expect(rejectCrossSiteRequest(post({ origin: "https://app.inboxjoy.test", "sec-fetch-site": "same-origin" }))).toBeNull();
  });

  it("requires both Sec-Fetch-Site same-origin and a matching Origin", () => {
    expect(rejectCrossSiteRequest(post({ "sec-fetch-site": "same-origin" }))?.status).toBe(403);
    expect(rejectCrossSiteRequest(post({ origin: "https://app.inboxjoy.test" }))?.status).toBe(403);
    expect(rejectCrossSiteRequest(post({ origin: "https://app.inboxjoy.test", "sec-fetch-site": "cross-site" }))?.status).toBe(403);
    expect(rejectCrossSiteRequest(post({ origin: "https://evil.example.test", "sec-fetch-site": "same-origin" }))?.status).toBe(403);
    expect(rejectCrossSiteRequest(post({ origin: "null", "sec-fetch-site": "same-origin" }))?.status).toBe(403);
  });

  it("falls back to Referer only when Origin is absent", () => {
    expect(rejectCrossSiteRequest(post({ referer: "https://app.inboxjoy.test/app/mcp/authorize?x=1", "sec-fetch-site": "same-origin" }))).toBeNull();
    expect(rejectCrossSiteRequest(post({ referer: "https://evil.example.test/", "sec-fetch-site": "same-origin" }))?.status).toBe(403);
    // Present-but-foreign Origin wins over a matching Referer.
    expect(rejectCrossSiteRequest(post({
      origin: "https://evil.example.test",
      referer: "https://app.inboxjoy.test/app/mcp/authorize",
      "sec-fetch-site": "same-origin",
    }))?.status).toBe(403);
  });

  it("verifies a freshly minted token and rejects any changed field", () => {
    const token = mintConsentToken(fields);
    expect(verifyConsentToken(token, fields)).toBe(true);
    for (const key of Object.keys(fields) as Array<keyof typeof fields>) {
      expect(verifyConsentToken(token, { ...fields, [key]: `${fields[key]}-changed` })).toBe(false);
    }
  });

  it("rejects malformed, tampered, expired, and foreign-secret tokens", () => {
    const token = mintConsentToken(fields);
    const [exp, signature] = token.split(".");
    expect(verifyConsentToken(undefined, fields)).toBe(false);
    expect(verifyConsentToken("", fields)).toBe(false);
    expect(verifyConsentToken("not-a-token", fields)).toBe(false);
    expect(verifyConsentToken(`${exp}.${signature!.slice(0, -2)}`, fields)).toBe(false);
    // Only the canonical encoding verifies, even when a flipped trailing bit would decode identically.
    expect(verifyConsentToken(`${exp}.${signature!.slice(0, -1)}${signature!.endsWith("A") ? "B" : "A"}`, fields)).toBe(false);
    expect(verifyConsentToken(`${exp}.${signature}=`, fields)).toBe(false);
    expect(verifyConsentToken(`${Number(exp) + 60}.${signature}`, fields)).toBe(false);
    expect(verifyConsentToken(token, fields, Date.now() + 11 * 60 * 1000)).toBe(false);
    expect(verifyConsentToken(mintConsentToken(fields, Date.now() - 11 * 60 * 1000), fields)).toBe(false);

    process.env.BETTER_AUTH_SECRET = "a-different-secret-that-is-also-at-least-32-chars";
    expect(verifyConsentToken(token, fields)).toBe(false);
  });
});
