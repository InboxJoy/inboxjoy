import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";

function isPrivateIpv4(address: string): boolean {
  const [first = 0, second = 0] = address.split(".").map(Number);
  return first === 0 || first === 10 || first === 127 || first >= 224
    || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168) || (first === 100 && second >= 64 && second <= 127)
    || (first === 198 && (second === 18 || second === 19));
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) return isPrivateIpv4(address);
  if (isIP(address) !== 6) return true;
  const normalized = new URL(`http://[${address}]`).hostname.slice(1, -1);
  if (normalized.startsWith("::ffff:")) {
    const words = normalized.slice(7).split(":").map((word) => Number.parseInt(word, 16));
    const upper = words[0] ?? 0;
    const lower = words[1] ?? 0;
    return isPrivateIpv4(`${upper >>> 8}.${upper & 255}.${lower >>> 8}.${lower & 255}`);
  }
  return normalized === "::" || normalized === "::1" || /^f[cd]/.test(normalized)
    || /^fe[89ab]/.test(normalized) || /^fec/.test(normalized) || normalized.startsWith("ff");
}

export async function assertSafeMailHost(host: string, port: number, kind: "smtp" | "imap", opts: { allowPrivate?: boolean } = {}): Promise<LookupAddress[]> {
  const ports = kind === "smtp" ? [587, 465, 25, 2525] : [993, 143];
  if (!ports.includes(port)) throw new Error(`Choose an allowed ${kind.toUpperCase()} port.`);
  if (isIP(host) || host.startsWith("[") || !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.?$/i.test(host)) {
    throw new Error("Mail host must be a DNS hostname, not an IP address or URL.");
  }
  try {
    if (isIP(new URL(`http://${host}`).hostname)) throw new Error("IP literal");
  } catch { throw new Error("Mail host must be a DNS hostname, not an IP address or URL."); }
  let addresses;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error("Mail host could not be resolved.");
  }
  if (!addresses.length) throw new Error("Mail host could not be resolved.");
  if (!opts.allowPrivate && addresses.some(({ address }) => isPrivateAddress(address))) throw new Error("Mail host must resolve only to public addresses.");
  return addresses;
}
