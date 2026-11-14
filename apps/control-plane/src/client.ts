// Who is the visitor? The client key used by the per-client limits:
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
 *
 * A trusted proxy that sends no usable address puts all its visitors in one
 * budget, that of the last trusted hop: `warn` is told once, since it is a
 * configuration mistake.
 */
export function clientKeyResolver(cfg: ClientIpConfig, warn: (msg: string) => void = () => {}) {
  const isTrusted = trustedChecker(cfg.trusted_proxies);
  const header = cfg.header?.toLowerCase();

  let warned = false;
  const fallBack = (peer: string, what: string) => {
    if (!warned) {
      warned = true;
      warn(`a trusted proxy sent no usable client address in ${what}; its visitors share the limits of ${peer}`);
    }
    return keyOf(peer);
  };

  /** The client named by the configured header, which only the nearest proxy writes. */
  function fromHeader(peer: string, name: string, headers: IncomingHttpHeaders): string {
    const v = normalize(String(headers[name] ?? "").trim());
    return isIP(v) ? keyOf(v) : fallBack(peer, cfg.header!);
  }

  /** The rightmost X-Forwarded-For entry that is not a trusted proxy. */
  function fromForwardedFor(peer: string, headers: IncomingHttpHeaders): string {
    const hops = forwardedHops(headers);
    let last = peer; // the last address vouched for by a trusted hop

    for (let i = hops.length - 1; i >= 0; i--) {
      const hop = normalize(hops[i]);
      if (!isIP(hop)) break; // malformed: nothing further left can be trusted
      if (!isTrusted(hop) || i === 0) return keyOf(hop);
      last = hop;
    }
    return fallBack(last, "X-Forwarded-For");
  }

  return function clientKey(remoteAddress: string | undefined, headers: IncomingHttpHeaders): string {
    const peer = remoteAddress ? normalize(remoteAddress) : "";
    if (!isIP(peer)) return "unknown";
    if (!isTrusted(peer)) return keyOf(peer);

    return header ? fromHeader(peer, header, headers) : fromForwardedFor(peer, headers);
  };
}

/** Builds the trusted proxy check; the configuration has already validated the blocks. */
function trustedChecker(trustedProxies: string[]): (address: string) => boolean {
  const trusted = new BlockList();

  for (const c of trustedProxies) {
    const cidr = parseCidr(c);
    if (!cidr) throw new Error(`invalid trusted proxy: ${c}`);
    trusted.addSubnet(cidr.address, cidr.prefix, cidr.family);
  }
  return (a) => trusted.check(a, family(a));
}

/** The X-Forwarded-For entries, left to right; several headers form one list, in order. */
function forwardedHops(headers: IncomingHttpHeaders): string[] {
  const xff = headers["x-forwarded-for"];
  const joined = Array.isArray(xff) ? xff.join(",") : (xff ?? "");

  return joined
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** An IP address or CIDR block; IPv4-mapped IPv6 blocks are refused (write them as IPv4). */
export function parseCidr(s: string): { address: string; prefix: number; family: "ipv4" | "ipv6" } | undefined {
  const [address, prefix, ...rest] = s.split("/");
  if (!isIP(address) || rest.length || normalize(address) !== address) return undefined;

  const f = family(address);
  const max = f === "ipv6" ? 128 : 32;
  if (prefix === undefined) return { address, prefix: max, family: f };

  const validPrefix = /^\d{1,3}$/.test(prefix) && Number(prefix) <= max;
  return validPrefix ? { address, prefix: Number(prefix), family: f } : undefined;
}

const family = (a: string) => (isIP(a) === 6 ? "ipv6" : "ipv4");

/**
 * Drops an IPv6 zone and a port ("192.0.2.1:4711", "[2001:db8::1]:4711", as
 * some proxies write them), and turns an IPv4-mapped IPv6 address into IPv4.
 */
function normalize(addr: string): string {
  const a = addr
    .replace(/^\[([^\]]+)\](:\d+)?$/, "$1")
    .replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, "$1")
    .replace(/%.*$/, "");
  if (isIP(a) !== 6) return a;

  const g = groups(a);
  const isV4Mapped = g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff;
  if (!isV4Mapped) return a;

  return [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join(".");
}

/** IPv4: the address. IPv6: its /64, since a single client usually holds a whole /64. */
function keyOf(addr: string): string {
  if (isIP(addr) !== 6) return addr;

  const prefix = groups(addr).slice(0, 4).map((x) => x.toString(16));
  return `${prefix.join(":")}::/64`;
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
  if (tail === undefined) return h;

  const zeros = Array(8 - h.length - t.length).fill(0);
  return [...h, ...zeros, ...t];
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
      this.release(key);
    };
  }

  private release(key: string): void {
    const left = (this.open.get(key) ?? 1) - 1;
    if (left > 0) this.open.set(key, left);
    else this.open.delete(key);
  }
}
