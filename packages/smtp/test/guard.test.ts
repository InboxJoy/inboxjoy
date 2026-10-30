import { lookup } from "node:dns/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertSafeMailHost } from "../src/guard.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
const resolve = vi.mocked(lookup);

describe("mail host guard", () => {
  beforeEach(() => {
    resolve.mockReset();
    resolve.mockResolvedValue([{ address: "8.8.8.8", family: 4 }] as never);
  });

  it.each([25, 465, 587, 2525])("allows SMTP port %s", async (port) => {
    await expect(assertSafeMailHost("smtp.example.com", port, "smtp")).resolves.toEqual([{ address: "8.8.8.8", family: 4 }]);
  });

  it.each([143, 993])("allows IMAP port %s", async (port) => {
    await expect(assertSafeMailHost("imap.example.com", port, "imap")).resolves.toEqual([{ address: "8.8.8.8", family: 4 }]);
  });

  it.each([[80, "smtp"], [993, "smtp"], [587, "imap"], [22, "imap"], [587.5, "smtp"]] as const)("rejects port %s for %s before DNS", async (port, kind) => {
    await expect(assertSafeMailHost("mail.example.com", port, kind)).rejects.toThrow("port");
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(["127.0.0.1", "8.8.8.8", "::1", "2001:4860:4860::8888", "[::1]", "https://mail.example.com", "mail.example.com/path", "127.1", "2130706433", "0x7f000001", "0177.0.0.1"])("rejects IP literals and non-hosts: %s", async (host) => {
    await expect(assertSafeMailHost(host, 587, "smtp", { allowPrivate: true })).rejects.toThrow();
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(["0.0.0.0", "127.0.0.1", "10.10.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "::", "::1", "fc00::1", "fd12::1", "fe80::1", "febf::1", "::ffff:127.0.0.1", "::ffff:192.168.1.1", "::ffff:c0a8:101"])("rejects a private DNS result: %s", async (address) => {
    resolve.mockResolvedValue([{ address, family: address.includes(":") ? 6 : 4 }] as never);
    await expect(assertSafeMailHost("mail.example.com", 587, "smtp")).rejects.toThrow("public");
    await expect(assertSafeMailHost("mail.example.com", 587, "smtp", { allowPrivate: true })).resolves.toEqual([{ address, family: address.includes(":") ? 6 : 4 }]);
  });

  it("rejects mixed public/private DNS answers", async () => {
    resolve.mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }] as never);
    await expect(assertSafeMailHost("mail.example.com", 993, "imap")).rejects.toThrow("public");
  });

  it("returns every validated address for connection pinning without a second lookup", async () => {
    const addresses = [{ address: "8.8.8.8", family: 4 }, { address: "2001:4860:4860::8888", family: 6 }];
    resolve.mockResolvedValue(addresses as never);
    await expect(assertSafeMailHost("mail.example.com", 993, "imap")).resolves.toEqual(addresses);
    expect(resolve).toHaveBeenCalledOnce();
  });

  it.each(["172.15.255.255", "172.32.0.1", "2001:4860:4860::8888", "::ffff:8.8.8.8"])("allows a public DNS result: %s", async (address) => {
    resolve.mockResolvedValue([{ address, family: address.includes(":") ? 6 : 4 }] as never);
    await expect(assertSafeMailHost("mail.example.com", 993, "imap")).resolves.toEqual([{ address, family: address.includes(":") ? 6 : 4 }]);
  });

  it("rejects failed and empty DNS resolution", async () => {
    resolve.mockRejectedValue(new Error("DNS failure"));
    await expect(assertSafeMailHost("mail.example.com", 587, "smtp")).rejects.toThrow("resolved");
    resolve.mockResolvedValue([] as never);
    await expect(assertSafeMailHost("mail.example.com", 587, "smtp")).rejects.toThrow("resolved");
  });
});
