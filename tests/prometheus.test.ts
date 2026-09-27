import { describe, test, expect } from "bun:test";
import { MetricsRegistry } from "../src/metrics.js";
import { renderPrometheus, PROMETHEUS_CONTENT_TYPE } from "../src/prometheus.js";

describe("renderPrometheus", () => {
  test("empty registry renders an empty string", () => {
    const registry = new MetricsRegistry();
    expect(renderPrometheus(registry.snapshot())).toBe("");
  });

  test("counters expose _total samples with base-name TYPE line", () => {
    const registry = new MetricsRegistry();
    registry.counter("jobs", undefined, { help: "Jobs done." }).inc(3);
    const text = renderPrometheus(registry.snapshot());
    expect(text).toBe(
      "# HELP jobs Jobs done.\n" +
      "# TYPE jobs counter\n" +
      "jobs_total 3\n",
    );
  });

  test("counters already named with _total are not double-suffixed", () => {
    const registry = new MetricsRegistry();
    registry.counter("jobs_total").inc(2);
    const text = renderPrometheus(registry.snapshot());
    expect(text).toContain("# TYPE jobs counter\n");
    expect(text).toContain("jobs_total 2\n");
    expect(text).not.toContain("jobs_total_total");
  });

  test("label values are escaped (backslash, quote, newline)", () => {
    const registry = new MetricsRegistry();
    registry.counter("events_total", { reason: 'say "hi"\n\\done' }).inc(1);
    const text = renderPrometheus(registry.snapshot());
    expect(text).toContain('reason="say \\"hi\\"\\n\\\\done"');
  });

  test("HELP strings escape backslash and newline but not quotes", () => {
    const registry = new MetricsRegistry();
    registry.counter("e_total", undefined, { help: 'back\\slash\nand "quotes"' }).inc();
    const text = renderPrometheus(registry.snapshot());
    expect(text).toContain("# TYPE e counter");
    expect(text).toContain('back\\\\slash\\nand "quotes"');
  });

  test("gauges render as-is with labels sorted", () => {
    const registry = new MetricsRegistry();
    registry.gauge("depth", { b: "2", a: "1" }, { help: "Depth" }).set(4.5);
    const text = renderPrometheus(registry.snapshot());
    expect(text).toBe(
      "# HELP depth Depth\n" +
      "# TYPE depth gauge\n" +
      'depth{a="1",b="2"} 4.5\n',
    );
  });

  test("non-finite values render as NaN/+Inf/-Inf", () => {
    const registry = new MetricsRegistry();
    registry.gauge("weird").set(Number.NaN);
    registry.gauge("weird", { s: "inf" }).set(Number.POSITIVE_INFINITY);
    registry.gauge("weird", { s: "-inf" }).set(Number.NEGATIVE_INFINITY);
    const text = renderPrometheus(registry.snapshot());
    expect(text).toContain("weird NaN\n");
    expect(text).toContain('weird{s="inf"} +Inf\n');
    expect(text).toContain('weird{s="-inf"} -Inf\n');
  });

  test("histogram family renders buckets, +Inf, sum and count", () => {
    const registry = new MetricsRegistry();
    const histogram = registry.histogram("lat", undefined, { help: "Latency", buckets: [0.5, 1] });
    for (const value of [0.2, 0.7, 0.9, 3]) histogram.observe(value);
    const text = renderPrometheus(registry.snapshot());
    expect(text).toBe(
      "# HELP lat Latency\n" +
      "# TYPE lat histogram\n" +
      'lat_bucket{le="0.5"} 1\n' +
      'lat_bucket{le="1"} 3\n' +
      'lat_bucket{le="+Inf"} 4\n' +
      "lat_sum 4.8\n" +
      "lat_count 4\n",
    );
  });

  test("histogram with labels carries them on every bucket line", () => {
    const registry = new MetricsRegistry();
    const histogram = registry.histogram("lat", { route: "/x" }, { buckets: [1] });
    histogram.observe(0.5);
    const text = renderPrometheus(registry.snapshot());
    expect(text).toContain('lat_bucket{le="1",route="/x"} 1\n');
    expect(text).toContain('lat_bucket{le="+Inf",route="/x"} 1\n');
    expect(text).toContain('lat_sum{route="/x"} 0.5\n');
    expect(text).toContain('lat_count{route="/x"} 1\n');
  });

  test("integer values render without decimal noise; floats keep precision", () => {
    const registry = new MetricsRegistry();
    registry.gauge("g").set(3);
    registry.gauge("f").set(0.30000000000000004);
    const text = renderPrometheus(registry.snapshot());
    expect(text).toContain("g 3\n");
    expect(text).toContain("f 0.30000000000000004\n");
  });

  test("content type is the text/plain exposition format", () => {
    expect(PROMETHEUS_CONTENT_TYPE).toBe("text/plain; version=0.0.4; charset=utf-8");
  });
});
