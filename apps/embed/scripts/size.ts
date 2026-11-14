// Checks the built embed page against its size budget; CI runs it after `npm run build`.
//
// - scripts and stylesheets: 25 KB gzipped, all together;
// - fonts: 100 KB, all together (woff2 is already compressed).
//
// Usage: node scripts/size.ts [dist dir]

import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { gzipSync } from "node:zlib";

const KB = 1024;

interface Budget {
  name: string;
  extensions: string[];
  limit: number;
  gzip: boolean;
}

interface File {
  name: string;
  bytes: Buffer;
}

const BUDGETS: Budget[] = [
  { name: "scripts and styles (gzip)", extensions: [".js", ".css"], limit: 25 * KB, gzip: true },
  { name: "fonts", extensions: [".woff2"], limit: 100 * KB, gzip: false },
];

/** Every file of dist/assets. */
function readAssets(dist: string): File[] {
  const dir = join(dist, "assets");
  return readdirSync(dir).map((name) => ({ name, bytes: readFileSync(join(dir, name)) }));
}

/** Prints one budget's total and files; returns whether it holds. */
function check(budget: Budget, files: File[]): boolean {
  const matching = files.filter((f) => budget.extensions.includes(extname(f.name)));
  const size = matching.reduce((sum, f) => sum + (budget.gzip ? gzipSync(f.bytes).length : f.bytes.length), 0);
  const ok = size <= budget.limit;

  console.log(`${ok ? "ok  " : "OVER"} ${budget.name}: ${(size / KB).toFixed(1)} KB of ${budget.limit / KB} KB`);
  for (const f of matching) console.log(`       ${f.name}`);
  return ok;
}

const files = readAssets(process.argv[2] ?? "dist");
const results = BUDGETS.map((budget) => check(budget, files));

process.exit(results.every(Boolean) ? 0 : 1);
