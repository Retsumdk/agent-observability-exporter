/**
 * OTLP/HTTP JSON encoders (metrics + logs) per the OpenTelemetry protocol.
 *
 * Notes on the JSON mapping:
 * - int64 fields (`timeUnixNano`, `intValue`, `aggregationTemporality` counts)
 *   are serialized as strings or plain JSON numbers per the proto JSON mapping;
 *   timestamps are emitted as decimal strings because they exceed 2^53.
 * - counter families map to `sum` with CUMULATIVE temporality and isMonotonic.
 * - histogram families map to `histogram` with bucketCounts length = explicitBounds + 1
 *   (the last bucket is +Inf).
 * - log severity numbers follow the well-known table: DEBUG=5, INFO=9, WARN=13, ERROR=17.
 */

import type {
  LabelSet,
  LogRecord,
  LogLevel,
  MetricFamily,
  MetricKind,
  RegistrySnapshot,
} from "./types.js";

const SCOPE_NAME = "agent-observability-exporter";
const SCOPE_VERSION = "1.0.0";

const SEVERITY: Record<LogLevel, number> = {
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
};

export function severityNumber(level: LogLevel): number {
  return SEVERITY[level];
}

type OtlpValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number };

function attributeValue(value: string | number | boolean): OtlpValue {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (Number.isInteger(value)) return { intValue: String(value) };
  return { doubleValue: value };
}

function toAttributes(labels: LabelSet | undefined): Array<{ key: string; value: OtlpValue }> {
  if (!labels) return [];
  return Object.entries(labels).map(([key, value]) => ({
    key,
    value: attributeValue(value),
  }));
}

function toLogAttributes(
  attrs: Record<string, string | number | boolean> | undefined,
): Array<{ key: string; value: OtlpValue }> {
  if (!attrs) return [];
  return Object.entries(attrs).map(([key, value]) => ({ key, value: attributeValue(value) }));
}

function resource(serviceName: string) {
  return {
    attributes: [{ key: "service.name", value: { stringValue: serviceName } }],
  };
}

function scope() {
  return { name: SCOPE_NAME, version: SCOPE_VERSION };
}

export interface OtlpOptions {
  serviceName?: string;
  /** Observation timestamp in nanoseconds since the epoch; defaults to Date.now() * 1e6. */
  nowNanos?: string;
}

// --- Typed OTLP/HTTP JSON document shapes -------------------------------
// int64 fields (timeUnixNano, count, bucketCounts, intValue) serialize as
// decimal strings per the proto JSON mapping; doubles stay JSON numbers.

export interface OtlpAttribute {
  key: string;
  value: OtlpValue;
}

export interface OtlpDataPoint {
  attributes: OtlpAttribute[];
  asDouble: number;
  timeUnixNano: string;
}

export interface OtlpSum {
  dataPoints: OtlpDataPoint[];
  aggregationTemporality: number;
  isMonotonic: boolean;
}

export interface OtlpGauge {
  dataPoints: OtlpDataPoint[];
}

export interface OtlpHistogramDataPoint {
  attributes: OtlpAttribute[];
  count: string;
  sum: number;
  bucketCounts: string[];
  explicitBounds: number[];
  timeUnixNano: string;
  min?: number;
  max?: number;
}

export interface OtlpHistogram {
  aggregationTemporality: number;
  dataPoints: OtlpHistogramDataPoint[];
}

export interface OtlpMetric {
  name: string;
  unit?: string;
  sum?: OtlpSum;
  gauge?: OtlpGauge;
  histogram?: OtlpHistogram;
}

export interface OtlpScopeMetrics {
  scope: { name: string; version: string };
  metrics: OtlpMetric[];
}

export interface OtlpResourceMetrics {
  resource: { attributes: OtlpAttribute[] };
  scopeMetrics: OtlpScopeMetrics[];
}

export interface OtlpMetricsDocument {
  resourceMetrics: OtlpResourceMetrics[];
}

export interface OtlpLogRecord {
  timeUnixNano: string;
  observedTimeUnixNano: string;
  severityNumber: number;
  severityText: LogLevel;
  body: { stringValue: string };
  attributes: OtlpAttribute[];
}

export interface OtlpScopeLogs {
  scope: { name: string; version: string };
  logRecords: OtlpLogRecord[];
}

export interface OtlpResourceLogs {
  resource: { attributes: OtlpAttribute[] };
  scopeLogs: OtlpScopeLogs[];
}

export interface OtlpLogsDocument {
  resourceLogs: OtlpResourceLogs[];
}

function defaultNanos(nowNanos: string | undefined): string {
  return nowNanos ?? (BigInt(Date.now()) * 1_000_000n).toString();
}

function metricFamilyToOtlp(family: MetricFamily, nowNanos: string): OtlpMetric {
  if (family.kind === "counter") {
    return {
      name: family.name,
      ...(family.unit === undefined ? {} : { unit: family.unit }),
      sum: {
        dataPoints: (family.samples ?? []).map((sample) => ({
          attributes: toAttributes(sample.labels),
          asDouble: sample.value,
          timeUnixNano: nowNanos,
        })),
        aggregationTemporality: 2,
        isMonotonic: true,
      },
    };
  }
  if (family.kind === "gauge") {
    return {
      name: family.name,
      ...(family.unit === undefined ? {} : { unit: family.unit }),
      gauge: {
        dataPoints: (family.samples ?? []).map((sample) => ({
          attributes: toAttributes(sample.labels),
          asDouble: sample.value,
          timeUnixNano: nowNanos,
        })),
      },
    };
  }
  return {
    name: family.name,
    ...(family.unit === undefined ? {} : { unit: family.unit }),
    histogram: {
      aggregationTemporality: 2,
      dataPoints: (family.histograms ?? []).map((histogram) => {
        const dataPoint: OtlpHistogramDataPoint = {
          attributes: toAttributes(histogram.labels),
          count: String(histogram.count),
          sum: histogram.sum,
          bucketCounts: histogram.counts.map((c) => String(c)),
          explicitBounds: histogram.bounds,
          timeUnixNano: nowNanos,
        };
        if (histogram.count > 0) {
          dataPoint.min = histogram.min;
          dataPoint.max = histogram.max;
        }
        return dataPoint;
      }),
    },
  };
}

/** Encodes a registry snapshot as an OTLP/HTTP `ExportMetricsServiceRequest` JSON body. */
export function toOtlpMetrics(
  snapshot: RegistrySnapshot,
  options: OtlpOptions = {},
): OtlpMetricsDocument {
  const nowNanos = defaultNanos(options.nowNanos);
  const serviceName = options.serviceName ?? "agent";
  const byKind = new Map<MetricKind, MetricFamily[]>();
  for (const family of snapshot.metrics) {
    const list = byKind.get(family.kind) ?? [];
    list.push(family);
    byKind.set(family.kind, list);
  }
  // OTLP scopes group metric kinds: sum/gauge/histogram payloads cannot be merged,
  // so each kind gets its own scope entry.
  const scopeMetrics = [...byKind.entries()].map(([_kind, families]) => ({
    scope: scope(),
    metrics: families.map((family) => metricFamilyToOtlp(family, nowNanos)),
  }));
  return {
    resourceMetrics: [
      {
        resource: resource(serviceName),
        scopeMetrics,
      },
    ],
  };
}

/** Encodes log records as an OTLP/HTTP `ExportLogsServiceRequest` JSON body. */
export function toOtlpLogs(
  records: LogRecord[],
  options: OtlpOptions = {},
): OtlpLogsDocument {
  const serviceName = options.serviceName ?? "agent";
  const logRecords: OtlpLogRecord[] = records.map((record) => ({
    timeUnixNano: (BigInt(Math.trunc(record.time)) * 1_000_000n).toString(),
    observedTimeUnixNano: (BigInt(Math.trunc(record.time)) * 1_000_000n).toString(),
    severityNumber: severityNumber(record.level),
    severityText: record.level,
    body: { stringValue: record.message },
    attributes: toLogAttributes(record.attributes),
  }));
  return {
    resourceLogs: [
      {
        resource: resource(serviceName),
        scopeLogs: [
          {
            scope: scope(),
            logRecords,
          },
        ],
      },
    ],
  };
}
