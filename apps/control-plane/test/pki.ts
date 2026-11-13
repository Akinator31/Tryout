// Throwaway PKI for tests, generated with the openssl CLI (OpenSSL 3 or
// later) so that no key, even a test one, is committed. Production
// certificates come from tryout-certs (apps/node/cmd/certs).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Leaf {
  cert: string;
  key: string;
  certFile: string;
  keyFile: string;
}

export interface TestPki {
  dir: string;
  caFile: string;
  ca: string;
  /** Leaf signed by the CA: name → files and PEM. */
  leaf(name: string, opts: { usage: "serverAuth" | "clientAuth"; san?: string[]; ca?: "main" | "other" }): Leaf;
}

/** Validity of test certificates, in days. */
export const TEST_DAYS = 400;

/** A new P-256 key, unencrypted, and the validity of the certificate. */
const EC = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", String(TEST_DAYS)];

/** Runs openssl in `cwd`, turning a failure into an error carrying its stderr. */
function openssl(args: string[], cwd: string) {
  try {
    execFileSync("openssl", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    const err = e as { code?: string; stderr?: Buffer };
    if (err.code === "ENOENT") throw new Error("the openssl CLI is required to generate test certificates");
    throw new Error(`openssl ${args[0]} failed: ${err.stderr?.toString() ?? String(e)}`);
  }
}

/** Writes an openssl config for subject `cn` with the extensions `ext`; returns its path. */
function cnf(cwd: string, name: string, cn: string, ext: string[]) {
  const file = join(cwd, `${name}.cnf`);
  writeFileSync(file, `[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=${cn}\n[ext]\n${ext.join("\n")}\n`);
  return file;
}

/** A self-signed CA: <name>.crt and <name>.key in `dir`. */
function makeCa(dir: string, name: string) {
  const conf = cnf(dir, name, name, ["basicConstraints=critical,CA:TRUE", "keyUsage=critical,keyCertSign"]);
  openssl(["req", "-x509", "-config", conf, "-extensions", "ext", ...EC, "-keyout", `${name}.key`, "-out", `${name}.crt`], dir);
}

/** A temporary directory with two CAs: "ca" (the main one) and "other-ca", for foreign certificates. */
export function makePki(): TestPki {
  const dir = mkdtempSync(join(tmpdir(), "tryout-pki-"));
  makeCa(dir, "ca");
  makeCa(dir, "other-ca");

  return {
    dir,
    caFile: join(dir, "ca.crt"),
    ca: readFileSync(join(dir, "ca.crt"), "utf8"),
    leaf(name, { usage, san = [], ca = "main" }) {
      const caName = ca === "main" ? "ca" : "other-ca";
      const ext = ["basicConstraints=critical,CA:FALSE", "keyUsage=critical,digitalSignature", `extendedKeyUsage=${usage}`];
      if (san.length) ext.push(`subjectAltName=${san.join(",")}`);

      const conf = cnf(dir, name, name, ext);
      const signer = ["-CA", `${caName}.crt`, "-CAkey", `${caName}.key`];
      openssl(
        ["req", "-x509", "-config", conf, "-extensions", "ext", ...signer, ...EC, "-keyout", `${name}.key`, "-out", `${name}.crt`],
        dir,
      );

      const certFile = join(dir, `${name}.crt`);
      const keyFile = join(dir, `${name}.key`);
      return { certFile, keyFile, cert: readFileSync(certFile, "utf8"), key: readFileSync(keyFile, "utf8") };
    },
  };
}
