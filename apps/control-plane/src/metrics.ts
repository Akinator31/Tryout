// Metrics in the Prometheus text exposition format (version 0.0.4), without a
// client library, like the agent's internal/metrics: counters and histograms
// kept in memory, and gauges computed by the caller at each scrape.

/** Media type of the text exposition format. */
export const CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

export type Labels = Record<string, string>;

/** A gauge family computed at scrape time and passed to Registry.write. */
export interface Gauge {
  name: string;
  help: string;
  labels?: string[];
  samples: { labels?: Labels; value: number }[];
}

/** One family the registry writes. */
interface Family {
  write(out: string[]): void;
}

/** The counters and histograms of the process, written in the order they were declared. */
export class Registry {
  readonly #families: Family[] = [];

  /** Declares a counter family with the given label names. */
  counter(name: string, help: string, labels: string[] = []): Counter {
    const c = new Counter(name, help, labels);
    this.#families.push(c);
    return c;
  }

  /** Declares a histogram family with upper bounds in increasing order. */
  histogram(name: string, help: string, bounds: number[], labels: string[] = []): Histogram {
    const h = new Histogram(name, help, bounds, labels);
    this.#families.push(h);
    return h;
  }

  /** The given gauges, then every declared family. */
  write(gauges: Gauge[] = []): string {
    const out: string[] = [];

    for (const g of gauges) {
      header(out, g.name, g.help, "gauge");
      for (const s of g.samples) out.push(sample(g.name, g.labels ?? [], s.labels ?? {}, s.value));
    }
    for (const f of this.#families) f.write(out);

    return out.map((line) => line + "\n").join("");
  }
}

/** A counter family; a series appears on its first increment. */
export class Counter implements Family {
  readonly name: string;
  readonly help: string;
  readonly labels: string[];
  readonly #series = new Map<string, { labels: Labels; value: number }>();

  constructor(name: string, help: string, labels: string[]) {
    this.name = name;
    this.help = help;
    this.labels = labels;
  }

  /** Adds one to the series with these label values. */
  inc(labels: Labels = {}): void {
    const key = seriesKey(this.labels, labels);
    const s = this.#series.get(key) ?? { labels, value: 0 };
    s.value++;
    this.#series.set(key, s);
  }

  write(out: string[]): void {
    header(out, this.name, this.help, "counter");
    for (const key of [...this.#series.keys()].sort()) {
      const s = this.#series.get(key)!;
      out.push(sample(this.name, this.labels, s.labels, s.value));
    }
  }
}

/** A histogram family with fixed upper bounds. */
export class Histogram implements Family {
  readonly name: string;
  readonly help: string;
  readonly bounds: number[];
  readonly labels: string[];
  readonly #series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();

  constructor(name: string, help: string, bounds: number[], labels: string[]) {
    this.name = name;
    this.help = help;
    this.bounds = bounds;
    this.labels = labels;
  }

  /** Records `v` in the series with these label values. */
  observe(v: number, labels: Labels = {}): void {
    const key = seriesKey(this.labels, labels);
    const s = this.#series.get(key) ?? { labels, counts: this.bounds.map(() => 0), sum: 0, count: 0 };

    const bucket = this.bounds.findIndex((b) => v <= b);
    if (bucket >= 0) s.counts[bucket]++;
    s.sum += v;
    s.count++;
    this.#series.set(key, s);
  }

  /** Cumulative buckets, then the sum and the count of each series. */
  write(out: string[]): void {
    header(out, this.name, this.help, "histogram");
    const bucketLabels = [...this.labels, "le"];

    for (const key of [...this.#series.keys()].sort()) {
      const s = this.#series.get(key)!;
      let cumulative = 0;

      this.bounds.forEach((bound, i) => {
        cumulative += s.counts[i];
        out.push(sample(`${this.name}_bucket`, bucketLabels, { ...s.labels, le: formatNumber(bound) }, cumulative));
      });
      out.push(sample(`${this.name}_bucket`, bucketLabels, { ...s.labels, le: "+Inf" }, s.count));
      out.push(sample(`${this.name}_sum`, this.labels, s.labels, s.sum));
      out.push(sample(`${this.name}_count`, this.labels, s.labels, s.count));
    }
  }
}

/** The HELP and TYPE lines of a family. */
function header(out: string[], name: string, help: string, type: string): void {
  out.push(`# HELP ${name} ${escapeHelp(help)}`, `# TYPE ${name} ${type}`);
}

/** One sample line: name{label="value",...} value, labels in the declared order. */
function sample(name: string, names: string[], labels: Labels, value: number): string {
  const pairs = names.map((n) => `${n}="${escapeLabel(labels[n] ?? "")}"`);
  return `${name}${pairs.length ? `{${pairs.join(",")}}` : ""} ${formatNumber(value)}`;
}

/** A number as the exposition format writes it. */
function formatNumber(v: number): string {
  if (v === Infinity) return "+Inf";
  if (v === -Infinity) return "-Inf";
  return String(v);
}

/** Escapes a label value: backslash, double quote and newline. */
export function escapeLabel(v: string): string {
  return v.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

/** Escapes a HELP text: backslash and newline. */
function escapeHelp(v: string): string {
  return v.replaceAll("\\", "\\\\").replaceAll("\n", "\\n");
}

/** Identifies a series by its label values, in the declared order. */
function seriesKey(names: string[], labels: Labels): string {
  return names.map((n) => labels[n] ?? "").join("\xff");
}
