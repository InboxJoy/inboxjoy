import { describe, expect, it, vi } from "vitest";

const captureException = vi.fn();
const shutdown = vi.fn().mockResolvedValue(undefined);
const PostHogMock = vi.fn().mockImplementation(() => ({ captureException, shutdown }));

vi.mock("posthog-node", () => ({ PostHog: PostHogMock }));

const { createPostHogServer } = await import("../src/posthog.js");

describe("worker posthog helper", () => {
  it("is a complete no-op with no network calls when POSTHOG_PROJECT_TOKEN is unset", async () => {
    const server = createPostHogServer({ POSTHOG_PROJECT_TOKEN: undefined, POSTHOG_HOST: "https://analytics.example.com" });

    expect(PostHogMock).not.toHaveBeenCalled();
    expect(() => server.captureException(new Error("boom"), { job: "test" })).not.toThrow();
    await expect(server.shutdown()).resolves.toBeUndefined();
    expect(captureException).not.toHaveBeenCalled();
  });

  it("constructs a client and forwards captures when a token is configured", () => {
    const server = createPostHogServer({ POSTHOG_PROJECT_TOKEN: "phc_test", POSTHOG_HOST: "https://analytics.example.com" });

    expect(PostHogMock).toHaveBeenCalledWith("phc_test", { host: "https://analytics.example.com" });

    const error = new Error("job failed");
    server.captureException(error, { job: "email.send-message", workerId: "worker-1-host-1" });

    expect(captureException).toHaveBeenCalledWith(error, undefined, { job: "email.send-message", workerId: "worker-1-host-1" });
  });

  it("leaves the host to the SDK default (PostHog's public cloud) when POSTHOG_HOST is unset", () => {
    createPostHogServer({ POSTHOG_PROJECT_TOKEN: "phc_test", POSTHOG_HOST: undefined });

    expect(PostHogMock).toHaveBeenLastCalledWith("phc_test", { host: undefined });
  });

  it("never lets a capture failure throw", () => {
    captureException.mockImplementationOnce(() => {
      throw new Error("posthog is down");
    });
    const server = createPostHogServer({ POSTHOG_PROJECT_TOKEN: "phc_test", POSTHOG_HOST: "https://analytics.example.com" });

    expect(() => server.captureException(new Error("boom"))).not.toThrow();
  });
});
