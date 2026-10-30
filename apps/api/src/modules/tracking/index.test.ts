import { createHash } from "node:crypto";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerTrackingRoutes, trackingGif, trackingPathPattern } from "./index.js";

const token = "0123456789abcdef0123456789abcdef";
const message = {
  id: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
};

function createDbMock(acceptedAt: Date | null) {
  const messageLimit = vi.fn().mockResolvedValue([{ ...message, acceptedAt }]);
  const recentLimit = vi.fn().mockResolvedValue([]);
  const select = vi.fn()
    .mockReturnValueOnce({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: messageLimit })) })) })
    .mockReturnValueOnce({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: recentLimit })) })) });
  const values = vi.fn().mockResolvedValue(undefined);
  const tx = {
    execute: vi.fn().mockResolvedValue(undefined),
    select,
    insert: vi.fn(() => ({ values })),
  };
  const db = {
    transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<void>) => callback(tx)),
  };
  return { db, values };
}

async function recordOpen(userAgent: string | undefined, acceptedAt: Date | null = new Date(Date.now() - 60_000)) {
  const { db, values } = createDbMock(acceptedAt);
  const app = Fastify();
  registerTrackingRoutes(app, db as never);
  const response = await app.inject({
    method: "GET",
    url: `/t/${token}.gif`,
    headers: { "user-agent": userAgent ?? "" },
  });
  await app.close();
  expect(response.statusCode).toBe(200);
  expect(response.rawPayload).toEqual(trackingGif);
  expect(values).toHaveBeenCalledTimes(1);
  return values.mock.calls[0]![0];
}

describe("open tracking", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("serves the exact 43-byte GIF without authentication", async () => {
    const app = Fastify();
    registerTrackingRoutes(app);
    const response = await app.inject({ method: "GET", url: `/t/${token}.gif` });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(trackingGif);
    expect(response.rawPayload).toHaveLength(43);
    await app.close();
  });

  it("only exempts exact tracking pixel paths", () => {
    expect(trackingPathPattern.test("/t/0123456789abcdef0123456789abcdef.gif")).toBe(true);
    expect(trackingPathPattern.test("/t/not-a-token.gif")).toBe(false);
    expect(trackingPathPattern.test("/t/0123456789abcdef0123456789abcdef.gif/extra")).toBe(false);
  });

  it("marks a known proxy user agent as automated", async () => {
    vi.stubEnv("AUTH_SECRET", "tracking-test-secret");
    const metadata = (await recordOpen("Mozilla/5.0 GoogleImageProxy", null)).metadata;

    expect(metadata).toEqual({
      source: "tracking_pixel",
      userAgent: "Mozilla/5.0 GoogleImageProxy",
      ipHash: createHash("sha256").update("tracking-test-secret:127.0.0.1").digest("hex"),
      bot: true,
      botReason: "known_proxy_or_scanner",
    });
    expect(metadata.ipHash).not.toContain("127.0.0.1");
  });

  it("marks a missing user agent as automated", async () => {
    const metadata = (await recordOpen(undefined, null)).metadata;

    expect(metadata).toEqual(expect.objectContaining({
      source: "tracking_pixel",
      userAgent: "",
      bot: true,
      botReason: "no_user_agent",
    }));
    expect(metadata.ipHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("marks a normal browser user agent as human and omits botReason", async () => {
    const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36 ${"x".repeat(300)}`;
    const metadata = (await recordOpen(userAgent)).metadata;

    expect(metadata).toEqual(expect.objectContaining({
      source: "tracking_pixel",
      userAgent: userAgent.slice(0, 300),
      bot: false,
    }));
    expect(metadata).not.toHaveProperty("botReason");
  });

  it("marks an open within ten seconds of acceptance as prefetch", async () => {
    const userAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36";
    const metadata = (await recordOpen(userAgent, new Date(Date.now() - 5_000))).metadata;

    expect(metadata).toEqual(expect.objectContaining({
      source: "tracking_pixel",
      userAgent,
      bot: true,
      botReason: "prefetch",
    }));
  });
});
