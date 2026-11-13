// Who is the visitor? The client key used by the per-client limits (ADR 0016):
// the IP address of the visitor, read through trusted proxies only, with IPv6
// addresses grouped by /64. Also the per-instance cap on open event streams.
import type { IncomingHttpHeaders } from "node:http";
import { BlockList, isIP } from "node:net";

export interface ClientIpConfig {
  /** CIDR blocks of the proxies allowed to report the client's address. */
  trusted_proxies: string[];
  /** Header holding the client's address, set by a trusted proxy; X-Forwarded-For otherwise. */
  header?: string;
}

/**
 * Returns a function mapping a request's socket address and headers to its
 * client key. Headers are only believed when the socket peer is a trusted
 * proxy: anyone can send them. X-Forwarded-For is read from the right, each
 * trusted hop vouching for the address on its left; the first address that is
 * not a trusted proxy is the client. Entries further left are written by the
 * client itself and are never used.
 */
export function clientKeyResolver(cfg: ClientIpConfig) {
  const trusted = new BlockList();
  for (const cidr of cfg.trusted_proxies) {
    const [net, prefix] = cidr.split("/");
    const family = isIP(net) === 6 ? "ipv6" : "ipv4";
    trusted.addSubnet(net, Number(prefix ?? (family === "ipv6" ? 128 : 32)), family);
  }
  const isTrusted = (a: string) => trusted.check(a, isIP(a) === 6 ? "ipv6" : "ipv4");
  const header = cfg.header?.toLowerCase();

  return function clientKey(remoteAddress: string | undefined, headers: IncomingHttpHeaders): string {
    const peer = remoteAddress ? normalize(remoteAddress) : "";
    if (!isIP(peer)) return "unknown";
    if (!isTrusted(peer)) return keyOf(peer);

    if (header) {
      const v = normalize(String(headers[header] ?? "").trim());
      return keyOf(isIP(v) ? v : peer);
    }
    const xff = headers["x-forwarded-for"];
    const hops = (Array.isArray(xff) ? xff.join(",") : (xff ?? "")).split(",").map((s) => s.trim()).filter(Boolean);
    let last = peer;
    for (let i = hops.length - 1; i >= 0; i--) {
      const hop = normalize(hops[i]);
      if (!isIP(hop)) break; // malformed: nothing further left can be trusted
      last = hop;
      if (!isTrusted(hop)) break;
    }
    return keyOf(last);
  };
}

/** Drops an IPv6 zone and turns an IPv4-mapped IPv6 address into IPv4. */
function normalize(addr: string): string {
  const a = addr.replace(/%.*$/, "");
  if (isIP(a) !== 6) return a;
  const g = groups(a);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join(".");
  }
  return a;
}

/** IPv4: the address. IPv6: its /64, since a single client usually holds a whole /64. */
function keyOf(addr: string): string {
  if (isIP(addr) !== 6) return addr;
  return `${groups(addr).slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

/** The eight 16-bit groups of a valid IPv6 address, with "::" and a trailing IPv4 expanded. */
function groups(addr: string): number[] {
  let s = addr.toLowerCase();
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    s = s.slice(0, v4.index) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const [head, tail] = s.split("::");
  const parse = (part: string | undefined) => (part ? part.split(":").map((x) => parseInt(x, 16)) : []);
  const h = parse(head);
  const t = parse(tail);
  return tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill(0), ...t];
}

/**
 * Caps the event streams open at once per client key, on this instance.
 * acquire() returns a release function, or null when the client is at the
 * cap. A cap of 0 means no limit.
 */
export class StreamLimiter {
  private readonly open = new Map<string, number>();
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  acquire(key: string): (() => void) | null {
    const n = this.open.get(key) ?? 0;
    if (this.max > 0 && n >= this.max) return null;
    this.open.set(key, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.open.get(key) ?? 1) - 1;
      if (left > 0) this.open.set(key, left);
      else this.open.delete(key);
    };
  }
}
