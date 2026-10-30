import { afterEach, describe, expect, it, vi } from "vitest";

import { editionConfigError } from "../lib/edition";

afterEach(() => { vi.unstubAllEnvs(); });

describe("editionConfigError", () => {
  it("refuses a production server without an edition, like the API and worker", () => {
    for (const value of [undefined, "", "  "]) {
      expect(editionConfigError({ NODE_ENV: "production", INBOXJOY_EDITION: value }), String(value)).toBe("INBOXJOY_EDITION must be set to cloud or selfhost in production.");
    }
  });

  it("refuses an unknown edition in every environment", () => {
    for (const NODE_ENV of ["production", "development", "test"]) {
      for (const value of ["Cloud", "self-host", "managed", " cloud"]) {
        expect(editionConfigError({ NODE_ENV, INBOXJOY_EDITION: value }), `${NODE_ENV} ${value}`).toBe(`INBOXJOY_EDITION must be cloud or selfhost, not "${value}".`);
      }
    }
  });

  it("accepts either edition in production", () => {
    expect(editionConfigError({ NODE_ENV: "production", INBOXJOY_EDITION: "cloud" })).toBeNull();
    expect(editionConfigError({ NODE_ENV: "production", INBOXJOY_EDITION: "selfhost" })).toBeNull();
  });

  it("lets dev and test run without one, as self-host", () => {
    expect(editionConfigError({ NODE_ENV: "development" })).toBeNull();
    expect(editionConfigError({ NODE_ENV: "test", INBOXJOY_EDITION: "" })).toBeNull();
    expect(editionConfigError({})).toBeNull();
  });

  it("lets next build run without one: published images are built for both editions", () => {
    expect(editionConfigError({ NODE_ENV: "production", NEXT_PHASE: "phase-production-build" })).toBeNull();
    expect(editionConfigError({ NODE_ENV: "production", NEXT_PHASE: "phase-production-server" })).not.toBeNull();
  });
});

describe("register", () => {
  it("stops a production server that has no edition before it serves a page", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("INBOXJOY_EDITION", "");
    const { register } = await import("../instrumentation");
    await expect(register()).rejects.toThrow("INBOXJOY_EDITION must be set to cloud or selfhost in production.");
  });

  it("starts a production server that names its edition", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("INBOXJOY_EDITION", "cloud");
    vi.stubEnv("WEB_BASE_URL", "https://inboxjoy.online");
    const { register } = await import("../instrumentation");
    await expect(register()).resolves.toBeUndefined();
  });
});
