// agent_tls: the control plane's client certificate towards agents (ADR 0015).
import { X509Certificate, createPrivateKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentTls } from "./config.ts";
import type { Report } from "./config-report.ts";
import { isObject } from "./config-values.ts";

const CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";
const EXPIRY_WARNING_DAYS = 30;
const DAY_MS = 24 * 3600 * 1000;

type PemFile = keyof AgentTls;

/**
 * Reads the client certificate, its key and the CA, and checks what can be
 * checked before the first call to an agent: files readable, PEM valid, key
 * matching the certificate, clientAuth usage, dates. Problems go to `report`,
 * an expiry within 30 days to `warnings`. Returns the PEM contents when all
 * three files could be read.
 */
export function loadAgentTls(
  v: unknown,
  baseDir: string,
  now: Date,
  report: Report,
  warnings: string[],
): AgentTls | undefined {
  if (!isObject(v)) return undefined;

  const pem = readPemFiles(v, baseDir, report);
  const parse = <T>(k: PemFile, what: string, fn: (s: string) => T): T | undefined => {
    if (pem[k] === undefined) return undefined;
    try {
      return fn(pem[k]);
    } catch {
      report(["agent_tls", k], `not a PEM ${what}`);
      return undefined;
    }
  };

  const ca = parse("ca", "certificate", (s) => new X509Certificate(s));
  const cert = parse("cert", "certificate", (s) => new X509Certificate(s));
  const key = parse<KeyObject>("key", "private key", (s) => createPrivateKey(s));

  const checkDates = (k: PemFile, c: X509Certificate) => checkValidity(k, c, now, report, warnings);
  if (ca) checkCa(ca, checkDates, report);
  if (cert) checkClientCert(cert, key, checkDates, report);

  return pem.ca && pem.cert && pem.key ? (pem as AgentTls) : undefined;
}

/** Reads the files named in agent_tls, relative to the configuration's directory. */
function readPemFiles(v: Record<string, unknown>, baseDir: string, report: Report): Partial<AgentTls> {
  const pem: Partial<AgentTls> = {};

  for (const k of ["ca", "cert", "key"] as const) {
    const name = v[k];
    if (typeof name !== "string" || name === "") continue;

    const file = resolve(baseDir, name);
    try {
      pem[k] = readFileSync(file, "utf8");
    } catch (e) {
      report(["agent_tls", k], `cannot read ${file}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`);
    }
  }
  return pem;
}

function checkCa(ca: X509Certificate, checkDates: (k: PemFile, c: X509Certificate) => void, report: Report): void {
  if (!ca.ca) report(["agent_tls", "ca"], "not a CA certificate");
  checkDates("ca", ca);
}

function checkClientCert(
  cert: X509Certificate,
  key: KeyObject | undefined,
  checkDates: (k: PemFile, c: X509Certificate) => void,
  report: Report,
): void {
  if (!cert.keyUsage?.includes(CLIENT_AUTH)) {
    report(["agent_tls", "cert"], "the certificate does not allow client authentication (extended key usage clientAuth)");
  }

  checkDates("cert", cert);

  if (key && !cert.checkPrivateKey(key)) report(["agent_tls", "key"], "the key does not match agent_tls.cert");
}

/** An expired or not yet valid certificate is a problem; one expiring within 30 days, a warning. */
function checkValidity(k: PemFile, c: X509Certificate, now: Date, report: Report, warnings: string[]): void {
  const left = c.validToDate.getTime() - now.getTime();

  if (left <= 0) {
    report(["agent_tls", k], `the certificate expired on ${c.validTo}`);
  } else if (c.validFromDate > now) {
    report(["agent_tls", k], `the certificate is not valid before ${c.validFrom}`);
  } else if (left <= EXPIRY_WARNING_DAYS * DAY_MS) {
    warnings.push(`agent_tls.${k}: the certificate expires on ${c.validTo} (in ${Math.floor(left / DAY_MS)} days)`);
  }
}
