// The client key behind the per-IP limits and the cap on open
// event streams.
import assert from "node:assert/strict";
import { test } from "node:test";
import { clientKeyResolver, parseCidr, StreamLimiter } from "../src/client.ts";

test("without trusted proxies, the key is the socket address and headers are ignored", () => {
  const key = clientKeyResolver({ trusted_proxies: [] });
  assert.equal(key("203.0.113.7", { "x-forwarded-for": "198.51.100.1" }), "203.0.113.7");
});

test("IPv4-mapped IPv6 addresses are IPv4, and IPv6 addresses are grouped by /64", () => {
  const key = clientKeyResolver({ trusted_proxies: [] });
  assert.equal(key("::ffff:203.0.113.7", {}), "203.0.113.7");
  assert.equal(key("2001:db8:1:2:aaaa::1", {}), "2001:db8:1:2::/64");
  assert.equal(key("2001:DB8:1:2:ffff:ffff:ffff:ffff", {}), "2001:db8:1:2::/64");
  assert.equal(key("::1", {}), "0:0:0:0::/64");
  assert.equal(key("2001:db8::", {}), "2001:db8:0:0::/64");
});

test("behind trusted proxies, X-Forwarded-For is read from the right, skipping trusted hops", () => {
  const key = clientKeyResolver({ trusted_proxies: ["10.0.0.0/8", "fd00::/8"] });
  // client, then two of our proxies; the leftmost entry is attacker-controlled
  assert.equal(key("10.0.0.2", { "x-forwarded-for": "6.6.6.6, 198.51.100.9, 10.0.0.5" }), "198.51.100.9");
  assert.equal(key("::ffff:10.0.0.2", { "x-forwarded-for": "198.51.100.9" }), "198.51.100.9");
  assert.equal(key("fd00::2", { "x-forwarded-for": "2001:db8:5:6::9" }), "2001:db8:5:6::/64");
  // several headers are one list, in order
  assert.equal(key("10.0.0.2", { "x-forwarded-for": ["198.51.100.1", "198.51.100.2"] }), "198.51.100.2");
});

test("X-Forwarded-For is ignored when the peer is not a trusted proxy", () => {
  const key = clientKeyResolver({ trusted_proxies: ["10.0.0.0/8"] });
  assert.equal(key("203.0.113.7", { "x-forwarded-for": "198.51.100.9" }), "203.0.113.7");
});

test("a missing, all-trusted or malformed X-Forwarded-For falls back to the last trusted hop", () => {
  const key = clientKeyResolver({ trusted_proxies: ["10.0.0.0/8"] });
  assert.equal(key("10.0.0.2", {}), "10.0.0.2");
  assert.equal(key("10.0.0.2", { "x-forwarded-for": "10.0.0.9, 10.0.0.5" }), "10.0.0.9");
  assert.equal(key("10.0.0.2", { "x-forwarded-for": "198.51.100.1, garbage, 10.0.0.5" }), "10.0.0.5");
});

test("ports written by proxies are ignored", () => {
  const key = clientKeyResolver({ trusted_proxies: ["10.0.0.0/8"] });
  assert.equal(key("10.0.0.2", { "x-forwarded-for": "198.51.100.1:4711" }), "198.51.100.1");
  assert.equal(key("10.0.0.2", { "x-forwarded-for": "[2001:db8:5:6::9]:4711" }), "2001:db8:5:6::/64");
});

test("a trusted proxy that sends no client address is reported once", () => {
  const warnings: string[] = [];
  const key = clientKeyResolver({ trusted_proxies: ["10.0.0.0/8"], header: "X-Real-IP" }, (w) => warnings.push(w));

  assert.equal(key("10.0.0.2", {}), "10.0.0.2");
  assert.equal(key("10.0.0.3", { "x-real-ip": "a, b" }), "10.0.0.3");
  assert.equal(key("10.0.0.2", { "x-real-ip": "198.51.100.1" }), "198.51.100.1");

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /X-Real-IP.*share the limits of 10\.0\.0\.2/);
});

test("trusted proxy blocks: addresses or CIDR blocks, IPv4 written as IPv4", () => {
  assert.deepEqual(parseCidr("10.0.0.0/8"), { address: "10.0.0.0", prefix: 8, family: "ipv4" });
  assert.deepEqual(parseCidr("fd00::/8"), { address: "fd00::", prefix: 8, family: "ipv6" });
  assert.deepEqual(parseCidr("192.0.2.1"), { address: "192.0.2.1", prefix: 32, family: "ipv4" });

  const invalid = ["10.0.0.0/33", "fd00::/129", "10.0.0/8", "10.0.0.0/8/1", "::ffff:10.0.0.0/104", "10.0.0.0/x"];
  for (const bad of invalid) {
    assert.equal(parseCidr(bad), undefined, bad);
  }
});

test("a configured header is used only from trusted proxies, and only if it is an IP", () => {
  const key = clientKeyResolver({ trusted_proxies: ["10.0.0.0/8"], header: "CF-Connecting-IP" });
  assert.equal(key("10.0.0.2", { "cf-connecting-ip": "198.51.100.9", "x-forwarded-for": "6.6.6.6" }), "198.51.100.9");
  assert.equal(key("203.0.113.7", { "cf-connecting-ip": "198.51.100.9" }), "203.0.113.7");
  assert.equal(key("10.0.0.2", { "cf-connecting-ip": "nope" }), "10.0.0.2");
  assert.equal(key("10.0.0.2", {}), "10.0.0.2");
});

test("a missing socket address still yields a key", () => {
  const key = clientKeyResolver({ trusted_proxies: [] });
  assert.equal(key(undefined, {}), "unknown");
});

test("the stream limiter caps open streams per key and frees a slot on release", () => {
  const streams = new StreamLimiter(2);
  const a = streams.acquire("k");
  const b = streams.acquire("k");
  assert.ok(a && b);

  assert.equal(streams.acquire("k"), null);
  assert.ok(streams.acquire("other"));

  a();
  a(); // releasing twice frees one slot only
  assert.ok(streams.acquire("k"));
  assert.equal(streams.acquire("k"), null);
});

test("a stream limit of zero means no limit", () => {
  const streams = new StreamLimiter(0);
  for (let i = 0; i < 100; i++) assert.ok(streams.acquire("k"));
});
