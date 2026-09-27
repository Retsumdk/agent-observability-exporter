/**
 * Metrics registry: monotonic counters, point-in-time gauges, and cumulative
 * histograms with explicit buckets, all keyed by metric name plus a sorted
 * label set. Snapshots are pure data so renderers and exporters stay dumb.
 */

import { ValidationError } from "./errors.js";
import type {
  HistogramSample,
  LabelSet,
  MetricFamily,
  MetricKind,
  RegisterOptions,
  RegistrySnapshot,
} from "./types.js";

export const DEFAULT_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

const NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function validateMetricName(name: string): void {
  if (typeof name !== "string" || name.length === 0 || !NAME_PATTERN.test(name)) {
    throw new ValidationError(
      `invalid metric name "${String(name)}": must match ${NAME_PATTERN.source}`,
    );
  }
}

function assertFinite(value: number, what: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`${what} must be a finite number, got ${String(value)}`);
  }
}

export function validateLabels(labels: LabelSet | undefined): void {
  if (labels === undefined) return;
  for (const [key, value] of Object.entries(labels)) {
    if (!LABEL_PATTERN.test(key)) {
      throw new ValidationError(`invalid label name "${key}": must match ${LABEL_PATTERN.source}`);
    }
    if (typeof value !== "string") {
      throw new ValidationError(`label "${key}" value must be a string, got ${typeof value}`);
    }
  }
}

export function serializeLabels(labels: LabelSet | undefined): string {
  if (!labels || Object.keys(labels).length === 0) return "";
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`)
    .join(",");
}

interface InternalSeries {
  labels: LabelSet;
  /** Counter/gauge value. */
  value?: number;
  /** Histogram accumulators, aligned with the family's buckets plus the +Inf bucket. */
  counts?: number[];
  sum?: number;
  min?: number;
  max?: number;
}

interface InternalFamily {
  name: string;
  kind: MetricKind;
  help?: string;
  unit?: string;
  buckets?: number[];
  series: Map<string, InternalSeries>;
}

export class CounterHandle {
  constructor(private readonly series: InternalSeries) {}

  /**
   * Adds to the counter. Zero creates the series without advancing it
   * (pre-warming labelled series); negative values are rejected because
   * counters are monotonic.
   */
  inc(value = 1): void {
    assertFinite(value, "counter increment");
    if (value < 0) {
      throw new ValidationError(`counter increments must be non-negative, got ${value}`);
    }
    this.series.value = (this.series.value ?? 0) + value;
  }

  /** Current accumulated value. */
  get(): number {
    return this.series.value ?? 0;
  }
}

export class GaugeHandle {
  constructor(private readonly series: InternalSeries) {}

  set(value: number): void {
    // Gauges may legitimately hold NaN/±Inf (Prometheus renders them).
    if (typeof value !== "number") {
      throw new ValidationError("gauge value must be a number");
    }
    this.series.value = value;
  }

  inc(value = 1): void {
    assertFinite(value, "gauge increment");
    this.series.value = (this.series.value ?? 0) + value;
  }

  dec(value = 1): void {
    assertFinite(value, "gauge decrement");
    this.series.value = (this.series.value ?? 0) - value;
  }


  get(): number {
    return this.series.value ?? 0;
  }
}

export class HistogramHandle {
  constructor(
    private readonly family: InternalFamily,
    private readonly series: InternalSeries,
  ) {}

  /** Records one observation. */
  observe(value: number): void {
    assertFinite(value, "observation");
    const buckets = this.family.buckets ?? [];
    const counts = (this.series.counts ??= new Array<number>(buckets.length + 1).fill(0));
    let index = buckets.length;
    for (let i = 0; i < buckets.length; i++) {
      const bound = buckets[i];
      if (bound !== undefined && value <= bound) {
        index = i;
        break;
      }
    }
    counts[index] = (counts[index] ?? 0) + 1;
    this.series.sum = (this.series.sum ?? 0) + value;
    this.series.min = this.series.min === undefined ? value : Math.min(this.series.min, value);
    this.series.max = this.series.max === undefined ? value : Math.max(this.series.max, value);
  }
}

export class MetricsRegistry {
  private readonly families = new Map<string, InternalFamily>();

  counter(name: string, labels?: LabelSet, options: RegisterOptions = {}): CounterHandle {
    const family = this.family(name, "counter", options);
    return new CounterHandle(this.seriesOf(family, name, labels));
  }

  gauge(name: string, labels?: LabelSet, options: RegisterOptions = {}): GaugeHandle {
    const family = this.family(name, "gauge", options);
    return new GaugeHandle(this.seriesOf(family, name, labels));
  }

  histogram(name: string, labels?: LabelSet, options: RegisterOptions = {}): HistogramHandle {
    const family = this.family(name, "histogram", options);
    return new HistogramHandle(family, this.seriesOf(family, name, labels));
  }

  snapshot(nowMs: number = Date.now()): RegistrySnapshot {
    const metrics: MetricFamily[] = [];
    for (const family of this.families.values()) {
      const out: MetricFamily = { name: family.name, kind: family.kind };
      if (family.help !== undefined) out.help = family.help;
      if (family.unit !== undefined) out.unit = family.unit;
      if (family.kind === "histogram") {
        out.histograms = [...family.series.values()]
          .map((series) => this.histogramSample(family, series))
          .sort((a, b) => serializeLabels(a.labels).localeCompare(serializeLabels(b.labels)));
      } else {
        out.samples = [...family.series.values()]
          .map((series) => ({
            labels: series.labels,
            value: series.value ?? (family.kind === "counter" ? 0 : Number.NaN),
          }))
          .sort((a, b) => serializeLabels(a.labels).localeCompare(serializeLabels(b.labels)));
      }
      metrics.push(out);
    }
    return { capturedAt: nowMs, metrics };
  }

  reset(): void {
    this.families.clear();
  }

  private histogramSample(family: InternalFamily, series: InternalSeries): HistogramSample {
    const buckets = family.buckets ?? [];
    const raw = series.counts ?? new Array<number>(buckets.length + 1).fill(0);
    // Prometheus and OTLP bucket counts are cumulative: le=N includes every
    // observation at or below N. The registry stores per-bucket counts; the
    // cumulative view is computed here so every consumer sees the wire shape.
    const counts: number[] = [];
    let running = 0;
    for (const rawCount of raw) {
      running += rawCount;
      counts.push(running);
    }
    return {
      labels: series.labels,
      counts,
      bounds: buckets,
      count: counts[counts.length - 1] ?? 0,
      sum: series.sum ?? 0,
      min: series.min ?? Number.NaN,
      max: series.max ?? Number.NaN,
    };
  }

  private family(name: string, kind: MetricKind, options: RegisterOptions): InternalFamily {
    validateMetricName(name);
    let family = this.families.get(name);
    if (!family) {
      family = {
        name,
        kind,
        ...(options.help === undefined ? {} : { help: options.help }),
        ...(options.unit === undefined ? {} : { unit: options.unit }),
        ...(kind === "histogram" ? { buckets: resolveBuckets(options) } : {}),
        series: new Map(),
      };
      this.families.set(name, family);
      return family;
    }
    if (family.kind !== kind) {
      throw new ValidationError(
        `metric "${name}" is already registered as a ${family.kind}, cannot re-register as ${kind}`,
      );
    }
    if (kind === "histogram" && options.buckets && !sameBounds(family.buckets ?? [], options.buckets)) {
      throw new ValidationError(
        `histogram "${name}" was already registered with different bucket boundaries`,
      );
    }
    return family;
  }

  private seriesOf(family: InternalFamily, _name: string, labels: LabelSet | undefined): InternalSeries {
    validateLabels(labels);
    const key = serializeLabels(labels);
    const existing = family.series.get(key);
    if (existing) return existing;
    const created: InternalSeries = {
      labels: Object.freeze({ ...labels }) as LabelSet,
      ...(family.kind === "histogram"
        ? { counts: new Array<number>((family.buckets?.length ?? 0) + 1).fill(0) }
        : {}),
    };
    family.series.set(key, created);
    return created;
  }
}

function resolveBuckets(options: RegisterOptions): number[] {
  if (!options.buckets || options.buckets.length === 0) return [...DEFAULT_BUCKETS];
  const bounds = [...options.buckets];
  for (const bound of bounds) assertFinite(bound, "bucket boundary");
  bounds.sort((a, b) => a - b);
  for (let i = 1; i < bounds.length; i++) {
    if (bounds[i] === bounds[i - 1]) {
      throw new ValidationError(`bucket boundaries must be unique, got duplicate ${bounds[i]}`);
    }
  }
  return bounds;
}

function sameBounds(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

export type { InternalFamily, InternalSeries };
