import { describe, test, expect } from "bun:test";
import { MetricsRegistry } from "../src/metrics.js";
import { toOtlpMetrics, toOtlpLogs, severityNumber } from "../src/otlp.js";
import { AgentLogger } from "../src/logger.js";

const FIXED_NANOS = "1700000000000000000";

describe("toOtlpMetrics", () => {
  test("produces the resourceMetrics/scopeMetrics envelope", () => {
    const registry = new MetricsRegistry();
    registry.counter("jobs_total").inc(3);
    const doc = toOtlpMetrics(registry.snapshot(), { serviceName: "my_agent", nowNanos: FIXED_NANOS });
    expect(doc.resourceMetrics).toHaveLength(1);
    expect(doc.resourceMetrics[0]?.resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "my_agent" } },
    ]);
    expect(doc.resourceMetrics[0]?.scopeMetrics[0]?.scope.name).toBe("agent-observability-exporter");
  });

  test("counters map to monotonic cumulative sums", () => {
    const registry = new MetricsRegistry();
    registry.counter("jobs_total", { kind: "batch" }).inc(3);
    const metric = toOtlpMetrics(registry.snapshot(), { serviceName: "a", nowNanos: FIXED_NANOS })
      .resourceMetrics[0]?.scopeMetrics[0]?.metrics[0];
    expect(metric?.name).toBe("jobs_total");
    expect(metric?.sum?.aggregationTemporality).toBe(2);
    expect(metric?.sum?.isMonotonic).toBe(true);
    const point = metric?.sum?.dataPoints[0];
    expect(point?.asDouble).toBe(3);
    expect(point?.timeUnixNano).toBe(FIXED_NANOS);
    expect(point?.attributes).toEqual([
      { key: "kind", value: { stringValue: "batch" } },
    ]);
  });

  test("gauges map to gauge datapoints", () => {
    const registry = new MetricsRegistry();
    registry.gauge("depth").set(7);
    const metric = toOtlpMetrics(registry.snapshot(), { serviceName: "a", nowNanos: FIXED_NANOS })
      .resourceMetrics[0]?.scopeMetrics[0]?.metrics[0];
    expect(metric?.gauge?.dataPoints[0]?.asDouble).toBe(7);
    expect(metric?.sum).toBeUndefined();
  });

  test("histograms map to OTLP histogram datapoints with string bucket counts", () => {
    const registry = new MetricsRegistry();
    const histogram = registry.histogram("lat", undefined, { buckets: [0.5, 1] });
    for (const value of [0.2, 0.7, 3]) histogram.observe(value);
    const metric = toOtlpMetrics(registry.snapshot(), { serviceName: "a", nowNanos: FIXED_NANOS })
      .resourceMetrics[0]?.scopeMetrics[0]?.metrics[0];
    expect(metric?.histogram?.aggregationTemporality).toBe(2);
    const point = metric?.histogram?.dataPoints[0];
    expect(point?.bucketCounts).toEqual(["1", "2", "3"]);
    expect(point?.explicitBounds).toEqual([0.5, 1]);
    expect(point?.count).toBe("3");
    expect(point?.sum).toBeCloseTo(3.9);
    expect(point?.min).toBe(0.2);
    expect(point?.max).toBe(3);
  });

  test("min/max are omitted for histograms with zero observations", () => {
    const registry = new MetricsRegistry();
    registry.histogram("empty", undefined, { buckets: [1] });
    const point = toOtlpMetrics(registry.snapshot(), { serviceName: "a" })
      .resourceMetrics[0]?.scopeMetrics[0]?.metrics[0]?.histogram?.dataPoints[0];
    expect(point?.count).toBe("0");
    expect(point?.min).toBeUndefined();
    expect(point?.max).toBeUndefined();
  });

  test("metrics are grouped by kind with stable ordering", () => {
    const registry = new MetricsRegistry();
    registry.counter("c_total").inc(1);
    registry.gauge("g").set(1);
    registry.histogram("h").observe(1);
    const groups = toOtlpMetrics(registry.snapshot(), { serviceName: "a" })
      .resourceMetrics[0]?.scopeMetrics ?? [];
    expect(groups).toHaveLength(3);
    const kinds = groups.map((group) => Object.keys(group.metrics[0] ?? {}).filter((k) => k !== "name" && k !== "unit")[0]);
    expect(kinds).toEqual(["sum", "gauge", "histogram"]);
  });

  test("unit annotations are carried through", () => {
    const registry = new MetricsRegistry();
    registry.counter("bytes_total", undefined, { unit: "By" }).inc(1);
    const metric = toOtlpMetrics(registry.snapshot(), { serviceName: "a" })
      .resourceMetrics[0]?.scopeMetrics[0]?.metrics[0];
    expect(metric?.unit).toBe("By");
  });

  test("empty snapshot produces an empty metrics list, not garbage", () => {
    const registry = new MetricsRegistry();
    const doc = toOtlpMetrics(registry.snapshot(), { serviceName: "a" });
    expect(doc.resourceMetrics[0]?.scopeMetrics).toHaveLength(0);
  });

  test("label values stay strings per the Prometheus data model", () => {
    const registry = new MetricsRegistry();
    registry.counter("events_total", { shard: "3" }).inc(1);
    const point = toOtlpMetrics(registry.snapshot(), { serviceName: "a" })
      .resourceMetrics[0]?.scopeMetrics[0]?.metrics[0]?.sum?.dataPoints[0];
    expect(point?.attributes).toEqual([
      { key: "shard", value: { stringValue: "3" } },
    ]);
  });
});

describe("toOtlpLogs", () => {
  test("maps records into resourceLogs/logRecords with severity numbers", () => {
    const logger = new AgentLogger();
    logger.info("hello", { attempt: 2, ok: true });
    const doc = toOtlpLogs(logger.drain(), { serviceName: "a" });
    expect(doc.resourceLogs).toHaveLength(1);
    expect(doc.resourceLogs[0]?.resource.attributes[0]?.key).toBe("service.name");
    const record = doc.resourceLogs[0]?.scopeLogs[0]?.logRecords[0];
    expect(record?.severityNumber).toBe(9);
    expect(record?.severityText).toBe("INFO");
    expect(record?.body.stringValue).toBe("hello");
    expect(record?.attributes).toEqual([
      { key: "attempt", value: { intValue: "2" } },
      { key: "ok", value: { boolValue: true } },
    ]);
    expect(record?.timeUnixNano).toMatch(/^\d+$/);
  });

  test("empty input produces an empty logRecords array", () => {
    const doc = toOtlpLogs([], { serviceName: "a" });
    expect(doc.resourceLogs[0]?.scopeLogs[0]?.logRecords).toHaveLength(0);
  });

  test("maps the standard levels", () => {
    expect(severityNumber("DEBUG")).toBe(5);
    expect(severityNumber("INFO")).toBe(9);
    expect(severityNumber("WARN")).toBe(13);
    expect(severityNumber("ERROR")).toBe(17);
  });
});
