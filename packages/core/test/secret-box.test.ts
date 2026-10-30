import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildSecretKeyMap, decryptSecret, encryptSecret, secretKeyVersion } from "../src/crypto/secret-box.js";

describe("secret box", () => {
  it("preserves the fixed stored key version and decrypts a pre-existing envelope", () => {
    const current = Buffer.alloc(32, 7);
    const previous = Buffer.alloc(32, 6);
    const stored = "v1.1269854094.AwMDAwMDAwMDAwMD.wL/oEc9AR8UwelyJK1iiOQ==.VorMcT9MczIbMzArhCWb";
    const rotated = buildSecretKeyMap({ current: current.toString("base64"), previous: previous.toString("base64") });
    expect(secretKeyVersion(current)).toBe(1269854094);
    expect(rotated.get(1269854094)).toEqual(current);
    expect(rotated.get(secretKeyVersion(previous))).toEqual(previous);
    expect(decryptSecret(stored, { keys: rotated, aad: "account-id:smtp_password" })).toBe("stored-password");
    const previousOnly = buildSecretKeyMap({ previous: current.toString("base64") });
    expect(decryptSecret(stored, { keys: previousOnly, aad: "account-id:smtp_password" })).toBe("stored-password");
    expect(buildSecretKeyMap({})).toEqual(new Map());
    expect(buildSecretKeyMap({ current: current.toString("base64"), previous: current.toString("base64") }).size).toBe(1);
    expect(() => secretKeyVersion(Buffer.alloc(31))).toThrow("32 bytes");
  });

  const key = randomBytes(32);
  const aad = "account-id:smtp_password";
  const keys = new Map([[1, key]]);

  it.each(["smtp-password", "", "pässword 🔒"])("round-trips %j with a random 12-byte IV", (plaintext) => {
    const envelope = encryptSecret(plaintext, { key, keyVersion: 1, aad });
    expect(envelope).toMatch(/^v1\.1\./);
    expect(Buffer.from(envelope.split(".")[2]!, "base64")).toHaveLength(12);
    expect(decryptSecret(envelope, { keys, aad })).toBe(plaintext);
    expect(encryptSecret(plaintext, { key, keyVersion: 1, aad })).not.toBe(envelope);
  });

  it.each(["other-account:smtp_password", "account-id:imap_password"])("rejects AAD mismatch: %s", (otherAad) => {
    const envelope = encryptSecret("password", { key, keyVersion: 1, aad });
    expect(() => decryptSecret(envelope, { keys, aad: otherAad })).toThrow();
  });

  it("rejects a tampered authentication tag and ciphertext", () => {
    const envelope = encryptSecret("password", { key, keyVersion: 1, aad });
    for (const index of [3, 4]) {
      const parts = envelope.split(".");
      const bytes = Buffer.from(parts[index]!, "base64");
      bytes[0] = bytes[0]! ^ 1;
      parts[index] = bytes.toString("base64");
      expect(() => decryptSecret(parts.join("."), { keys, aad })).toThrow();
    }
  });

  it("decrypts previous-key envelopes while encrypting with the current key", () => {
    const current = randomBytes(32);
    const rotatedKeys = new Map([[1, key], [2, current]]);
    expect(decryptSecret(encryptSecret("old", { key, keyVersion: 1, aad }), { keys: rotatedKeys, aad })).toBe("old");
    expect(decryptSecret(encryptSecret("new", { key: current, keyVersion: 2, aad }), { keys: rotatedKeys, aad })).toBe("new");
  });

  it("rejects unknown envelope and key versions", () => {
    const envelope = encryptSecret("password", { key, keyVersion: 1, aad });
    expect(() => decryptSecret(envelope.replace(/^v1/, "v2"), { keys, aad })).toThrow();
    expect(() => decryptSecret(envelope, { keys: new Map(), aad })).toThrow("Unknown secret key version");
  });

  it("rejects invalid keys, versions and malformed envelopes", () => {
    expect(() => encryptSecret("password", { key: randomBytes(16), keyVersion: 1, aad })).toThrow();
    expect(() => encryptSecret("password", { key, keyVersion: 0, aad })).toThrow();
    for (const envelope of ["", "v1.1", "v1.1.!!!.!!!.!!!", "v1.1.YQ==.YQ==.YQ=="]) {
      expect(() => decryptSecret(envelope, { keys, aad })).toThrow();
    }
  });
});
