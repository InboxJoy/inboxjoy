import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function assertKey(key: Buffer): void {
  if (key.length !== 32) throw new Error("Secret encryption keys must be 32 bytes.");
}

export function secretKeyVersion(key: Buffer): number {
  assertKey(key);
  return (createHash("sha256").update(key).digest().readUInt32BE(0) & 0x7fffffff) || 1;
}

export function buildSecretKeyMap(opts: { current?: string; previous?: string }): Map<number, Buffer> {
  const keys = new Map<number, Buffer>();
  for (const encoded of [opts.previous, opts.current]) {
    if (!encoded) continue;
    const key = Buffer.from(encoded, "base64");
    keys.set(secretKeyVersion(key), key);
  }
  return keys;
}

export function encryptSecret(plaintext: string, opts: { key: Buffer; keyVersion: number; aad: string }): string {
  assertKey(opts.key);
  if (!Number.isSafeInteger(opts.keyVersion) || opts.keyVersion < 1) throw new Error("Invalid secret key version.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", opts.key, iv);
  cipher.setAAD(Buffer.from(opts.aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", opts.keyVersion, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(".");
}

export function decryptSecret(envelope: string, opts: { keys: Map<number, Buffer>; aad: string }): string {
  const parts = envelope.split(".");
  const [version, keyVersion, ivBase64, tagBase64, ciphertextBase64] = parts;
  if (parts.length !== 5 || version !== "v1" || !keyVersion || !/^[1-9]\d*$/.test(keyVersion)
    || ivBase64 === undefined || tagBase64 === undefined || ciphertextBase64 === undefined) throw new Error("Invalid secret envelope.");
  const key = opts.keys.get(Number(keyVersion));
  if (!key) throw new Error("Unknown secret key version.");
  assertKey(key);
  const decode = (value: string): Buffer => {
    const decoded = Buffer.from(value, "base64");
    if (decoded.toString("base64") !== value) throw new Error("Invalid secret envelope encoding.");
    return decoded;
  };
  const iv = decode(ivBase64);
  const tag = decode(tagBase64);
  if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid secret envelope.");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(opts.aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(decode(ciphertextBase64)), decipher.final()]).toString("utf8");
}
