import { describe, test, expect } from "bun:test";
import { MetricsRegistry, DEFAULT_BUCKETS, validateMetricName, serializeLabels } from "../src/metrics.js";
import { ExporterError } from "../src/errors.js";

describe("MetricsRegistry", () => {
  test("counters are cumulative per label set", () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter("jobs_total");
    counter.inc();
    counter.inc();
    counter.inc(4);
    const snapshot = registry.snapshot();
    expect(snapshot.metrics).toHaveLength(1);
    expect(snapshot.metrics[0]?.samples?.[0]?.value).toBe(6);
  });

  test("label sets create distinct series with deterministic ordering", () => {
    const registry = new MetricsRegistry();
    const post = registry.counter("requests_total", { route: "/b", method: "POST" });
    const get = registry.counter("requests_total", { method: "GET", route: "/a" });
    post.inc(1);
    get.inc(2);
    get.inc(3);
    const series = registry.snapshot().metrics[0]?.samples ?? [];
    expect(series).toHaveLength(2);
    expect(series[0]?.labels).toEqual({ method: "GET", route: "/a" });
    expect(series[0]?.value).toBe(5);
    expect(series[1]?.value).toBe(1);
  });

  test("gauges set, increment, and decrement", () => {
    const registry = new MetricsRegistry();
    const gauge = registry.gauge("queue_depth");
    gauge.set(10);
    gauge.inc(3);
    gauge.dec(8);
    expect(registry.snapshot().metrics[0]?.samples?.[0]?.value).toBe(5);
  });

  test("histogram buckets, sum, min, max, and +Inf bucket", () => {
    const registry = new MetricsRegistry();
    const histogram = registry.histogram("latency_seconds", undefined, { buckets: [0.1, 1] });
    for (const value of [0.05, 0.5, 0.5, 5]) histogram.observe(value);
    const histogramSeries = registry.snapshot().metrics[0]?.histograms?.[0];
    expect(histogramSeries?.counts).toEqual([1, 3, 4]); // cumulative le-buckets
    expect(histogramSeries?.bounds).toEqual([0.1, 1]);
    expect(histogramSeries?.sum).toBeCloseTo(6.05);
    expect(histogramSeries?.count).toBe(4);
    expect(histogramSeries?.min).toBe(0.05);
    expect(histogramSeries?.max).toBe(5);
  });

  test("histogram boundaries are validated: finite, unique", () => {
    const registry = new MetricsRegistry();
    expect(() => registry.histogram("h1", undefined, { buckets: [1, 1] })).toThrow(ExporterError);
    expect(() => registry.histogram("h2", undefined, { buckets: [Number.NaN] })).toThrow(ExporterError);
    expect(() => registry.histogram("h3", undefined, { buckets: [3, 1] })).not.toThrow(); // sorted, not rejected
  });

  test("histogram rejects non-finite observations", () => {
    const registry = new MetricsRegistry();
    const histogram = registry.histogram("latency_seconds");
    expect(() => histogram.observe(Number.NaN)).toThrow(ExporterError);
    expect(() => histogram.observe(Number.POSITIVE_INFINITY)).toThrow(ExporterError);
  });

  test("invalid metric and label names are rejected", () => {
    const registry = new MetricsRegistry();
    expect(() => registry.counter("bad name")).toThrow(ExporterError);
    expect(() => registry.counter("9starts_with_digit")).toThrow(ExporterError);
    expect(() => registry.counter("ok_name", { "bad-label": "x" })).toThrow(ExporterError);
    expect(() => registry.counter("ok_name", { label: 42 as unknown as string })).toThrow(ExporterError);
    expect(() => validateMetricName("http:requests_total")).not.toThrow(); // colons are legal
  });

  test("counter/gauge/histogram kind mismatch on same name is rejected", () => {
    const registry = new MetricsRegistry();
    registry.counter("shared_name");
    expect(() => registry.gauge("shared_name")).toThrow(ExporterError);
    expect(() => registry.histogram("shared_name")).toThrow(ExporterError);
  });

  test("counters reject negative and non-positive increments", () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter("jobs_total");
    expect(() => counter.inc(-1)).toThrow(ExporterError);
    expect(() => counter.inc(Number.NaN)).toThrow(ExporterError);
    expect(() => counter.inc(0)).not.toThrow(); // 0 is a legal no-op (series warm-up)
  });

  test("same labels with different insertion order map to one series", () => {
    const registry = new MetricsRegistry();
    registry.counter("m", { a: "1", b: "2" }).inc(1);
    registry.counter("m", { b: "2", a: "1" }).inc(2);
    expect(registry.snapshot().metrics[0]?.samples).toHaveLength(1);
    expect(registry.snapshot().metrics[0]?.samples?.[0]?.value).toBe(3);
  });

  test("serializeLabels is stable and injective for label ordering", () => {
    expect(serializeLabels(undefined)).toBe("");
    expect(serializeLabels({})).toBe("");
    expect(serializeLabels({ b: "2", a: "1" })).toBe("a=1,b=2");
    expect(serializeLabels({ route: "/a", method: "GET" })).toBe("method=GET,route=/a");
  });

  test("snapshot deep-copies: mutating the snapshot does not corrupt the registry", () => {
    const registry = new MetricsRegistry();
    registry.counter("jobs_total").inc(2);
    const snapshot = registry.snapshot();
    const samples = snapshot.metrics[0]?.samples ?? [];
    (samples[0] as { value: number }).value = 999;
    expect(registry.snapshot().metrics[0]?.samples?.[0]?.value).toBe(2);
  });

  test("unobserved gauges render as NaN in snapshots; counters start at zero", () => {
    const registry = new MetricsRegistry();
    registry.gauge("empty_gauge");
    registry.counter("empty_counter");
    const [gauge, counter] = registry.snapshot().metrics;
    expect(gauge?.samples?.[0]?.value).toBe(Number.NaN);
    expect(counter?.samples?.[0]?.value).toBe(0);
  });

  test("reset clears everything", () => {
    const registry = new MetricsRegistry();
    registry.counter("jobs_total").inc(1);
    registry.reset();
    expect(registry.snapshot().metrics).toHaveLength(0);
  });

  test("default histogram buckets are strictly increasing", () => {
    for (let i = 1; i < DEFAULT_BUCKETS.length; i++) {
      expect(DEFAULT_BUCKETS[i]).toBeGreaterThan(DEFAULT_BUCKETS[i - 1] as number);
    }
  });

  test("label sets are frozen in snapshots", () => {
    const registry = new MetricsRegistry();
    registry.counter("m", { a: "1" });
    const labels = registry.snapshot().metrics[0]?.samples?.[0]?.labels as Record<string, string>;
    expect(() => {
      (labels as Record<string, string>).a = "2";
    }).toThrow();
  });
});
