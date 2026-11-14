// Relay of the agents' metrics: the control plane fetches each agent's
// /metrics over mutual TLS and serves them on its admin listener, every
// sample labelled with its node. Nodes run hostile code, so the text is parsed
// strictly and rebuilt: a node can only add samples under its own label, never
// break the scrape or spoof another node.

/** One node's /metrics text. */
export interface NodeMetrics {
  node: string;
  text: string;
}

/** A merged family: its header from the first node that sent it, and every node's samples. */
interface Family {
  help?: string;
  type: string;
  samples: string[];
}

const TYPES = new Set(["counter", "gauge", "histogram", "summary", "untyped"]);
const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const HEADER = /^# (HELP|TYPE) ([a-zA-Z_:][a-zA-Z0-9_:]*) (.*)$/;
const SAMPLE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? (\S+)$/;
const LABEL = /\s*([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\\n]|\\["\\n])*)"\s*(?:,|$)/y;
const VALUE = /^(?:[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|[+-]?Inf|NaN)$/;

/** Suffixes a sample may add to its family's name, by family type. */
const SUFFIXES: Record<string, string[]> = {
  histogram: ["_bucket", "_sum", "_count"],
  summary: ["_sum", "_count"],
};

/**
 * Merges the nodes' metrics into one exposition text, each family once, its
 * samples in node order. Dropped: samples outside a typed family, samples
 * with a timestamp, a `node` label or a repeated label, invalid lines, repeated
 * series, families whose type differs from an earlier node's, and families
 * named like one of the control plane's own (`reserved`) or prefixed by one.
 */
export function relayMetrics(sources: NodeMetrics[], reserved: Set<string> = new Set()): string {
  const families = new Map<string, Family>();
  const pendingHelp = new Map<string, string>();
  const seen = new Set<string>();
  const isReserved = (name: string) => [...reserved].some((r) => name === r || name.startsWith(`${r}_`));

  for (const { node, text } of sources) {
    let current: { name: string; family: Family } | null = null;

    for (const line of text.split("\n")) {
      const header = HEADER.exec(line);
      if (header) {
        current = openFamily({ families, pendingHelp, isReserved }, header, current);
        continue;
      }

      const relabelled = current && relabel(line, current.name, current.family.type, node);
      if (!relabelled || seen.has(relabelled.series)) continue;

      seen.add(relabelled.series);
      current!.family.samples.push(relabelled.line);
    }
  }

  return write(families);
}

/**
 * Handles a HELP or TYPE line: returns the family the following samples
 * belong to, or null when they must be dropped. A family is usable once its
 * TYPE is known; HELP alone only keeps the text for it.
 */
function openFamily(
  merge: {
    families: Map<string, Family>;
    /** HELP texts seen before their family's TYPE line, by family name. */
    pendingHelp: Map<string, string>;
    isReserved: (name: string) => boolean;
  },
  [, kind, name, rest]: RegExpExecArray,
  current: { name: string; family: Family } | null,
): { name: string; family: Family } | null {
  const { families, pendingHelp, isReserved } = merge;
  if (isReserved(name)) return null;

  if (kind === "HELP") {
    const known = families.get(name);
    if (known && known.help === undefined) known.help = rest;
    if (!known) pendingHelp.set(name, rest);
    return current?.name === name ? current : null;
  }

  if (!TYPES.has(rest)) return null;
  const known = families.get(name);
  if (known) return known.type === rest ? { name, family: known } : null;

  const family: Family = { help: pendingHelp.get(name), type: rest, samples: [] };
  pendingHelp.delete(name);
  families.set(name, family);
  return { name, family };
}

/**
 * Rebuilds a sample line with the node's label first, or returns null when the
 * line is not a valid sample of the family. `series` identifies the result,
 * to drop repeats.
 */
function relabel(line: string, family: string, type: string, node: string): { line: string; series: string } | null {
  const m = SAMPLE.exec(line);
  if (!m) return null;

  const [, name, labelText = "", value] = m;
  const names = [family, ...(SUFFIXES[type] ?? []).map((s) => family + s)];
  if (!METRIC_NAME.test(name) || !names.includes(name) || !VALUE.test(value)) return null;

  const labels = parseLabels(labelText);
  if (!labels || labels.has("node")) return null;

  const pairs = [`node="${escapeNode(node)}"`, ...[...labels].map(([k, v]) => `${k}="${v}"`)];
  const series = `${name}{${pairs.join(",")}}`;
  return { line: `${series} ${value}`, series };
}

/** The labels of a sample, values kept escaped; null when malformed or a name repeats. */
function parseLabels(text: string): Map<string, string> | null {
  const labels = new Map<string, string>();
  LABEL.lastIndex = 0;

  while (LABEL.lastIndex < text.length) {
    const m = LABEL.exec(text);
    if (!m || labels.has(m[1])) return null;
    labels.set(m[1], m[2]);
  }
  return labels;
}

/** Node names are schema-checked to [a-z0-9-]; escaping is a second guard. */
function escapeNode(node: string): string {
  return node.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

/** The merged families as exposition text; families without samples are left out. */
function write(families: Map<string, Family>): string {
  const out: string[] = [];

  for (const [name, f] of families) {
    if (f.samples.length === 0) continue;
    if (f.help !== undefined) out.push(`# HELP ${name} ${f.help}`);
    out.push(`# TYPE ${name} ${f.type}`, ...f.samples);
  }
  return out.map((line) => line + "\n").join("");
}
