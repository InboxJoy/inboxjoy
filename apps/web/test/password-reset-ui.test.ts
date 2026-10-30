import { describe, expect, it } from "vitest";

import {
  authPageHref,
  classifyPasswordResetError,
  passwordResetCallbackUrl,
  resetTokenFromSearch,
  safeNextPath,
} from "../components/password-reset-state";

describe("password reset UI state", () => {
  it("recognizes disabled and unreachable reset providers", () => {
    expect(classifyPasswordResetError({ code: "RESET_PASSWORD_DISABLED" })).toBe("provider-unavailable");
    expect(classifyPasswordResetError(new Error("Failed to fetch"))).toBe("provider-unavailable");
    expect(classifyPasswordResetError({ status: 503 })).toBe("provider-unavailable");
  });

  it("recognizes invalid or consumed reset tokens", () => {
    expect(classifyPasswordResetError({ code: "INVALID_TOKEN" })).toBe("invalid-token");
    expect(classifyPasswordResetError({ message: "Invalid token" })).toBe("invalid-token");
    expect(resetTokenFromSearch("?error=INVALID_TOKEN")).toBeNull();
    expect(resetTokenFromSearch("?token=reset-token")).toBe("reset-token");
  });

  it("rejects missing tokens and unsafe next destinations", () => {
    expect(resetTokenFromSearch("")).toBeNull();
    expect(safeNextPath("?next=https%3A%2F%2Fevil.example")).toBeNull();
    expect(authPageHref("/app/login", "?next=https%3A%2F%2Fevil.example")).toBe("/app/login");
  });

  it("preserves a safe product destination through the reset flow", () => {
    const search = "?next=%2Fapp%2Fsequences%2Fcampaign-1";

    expect(safeNextPath(search)).toBe("/app/sequences/campaign-1");
    expect(authPageHref("/app/login", search)).toBe("/app/login?next=%2Fapp%2Fsequences%2Fcampaign-1");
    expect(passwordResetCallbackUrl("https://inboxjoy.example", search)).toBe(
      "https://inboxjoy.example/app/reset-password?next=%2Fapp%2Fsequences%2Fcampaign-1",
    );
  });
});
