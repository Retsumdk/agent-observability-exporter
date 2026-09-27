/**
 * Core type definitions for the agent observability exporter.
 */

export type MetricKind = "counter" | "gauge" | "histogram";

export type AttributeValue = string | number | boolean;

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface LogRecord {
  /** Epoch milliseconds. */
  time: number;
  level: LogLevel;
  message: string;
  attributes?: Record<string, AttributeValue>;
}

export interface LabelSet {
  readonly [label: string]: string;
}

export interface RegisterOptions {
  /** Human-readable description emitted as `# HELP` (and OTLP `description`). */
  help?: string;
  /** Unit annotation (`s`, `By`, `1`, ...); emitted as OTLP `unit` only. */
  unit?: string;
  /** Explicit bucket boundaries for histograms (ascending, finite, unique). */
  buckets?: number[];
}

/** A counter or gauge sample for one label combination. */
export interface Sample {
  labels: LabelSet;
  value: number;
}

/** A histogram sample for one label combination. */
export interface HistogramSample {
  labels: LabelSet;
  /** Observation counts per bucket; one extra bucket accumulates everything above the last bound. */
  counts: number[];
  /** Explicit bucket boundaries (ascending, finite). */
  bounds: number[];
  count: number;
  sum: number;
  min: number;
  max: number;
}

/** One metric family as captured by a snapshot. */
export interface MetricFamily {
  name: string;
  kind: MetricKind;
  help?: string;
  unit?: string;
  /** Present for counters and gauges. */
  samples?: Sample[];
  /** Present for histograms. */
  histograms?: HistogramSample[];
}

export interface RegistrySnapshot {
  /** Epoch milliseconds at which the snapshot was captured. */
  capturedAt: number;
  metrics: MetricFamily[];
}

export interface ExportResult {
  ok: boolean;
  /** HTTP status of the last attempt, when one was made. */
  status?: number;
  attempts: number;
  durationMs: number;
  error?: string;
  /** Populated when the collector reported a partial success on metrics. */
  rejectedDataPoints?: number;
  /** Populated when the collector reported a partial success on logs. */
  rejectedLogRecords?: number;
}

export interface ExporterConfig {
  /** OTLP/HTTP collector base URL, e.g. `http://localhost:4318`. */
  endpoint: string;
  /** Default `/v1/metrics`. */
  metricsPath?: string;
  /** Default `/v1/logs`. */
  logsPath?: string;
  /** Static headers for every request (auth tokens, etc.). */
  headers?: Record<string, string>;
  /** Background flush interval (ms). Default 10000. */
  flushIntervalMs?: number;
  /** Maximum log records buffered across flushes. Default 512. */
  maxLogBatch?: number;
  /** Attempts per export (1 = no retries). Default 3. */
  maxAttempts?: number;
  /** Base delay for exponential backoff with jitter (ms). Default 250. */
  backoffMs?: number;
  /** Upper bound for a single backoff delay (ms). Default 8000. */
  backoffCapMs?: number;
  /** Per-request timeout (ms). Default 10000. */
  timeoutMs?: number;
  /** `service.name` resource attribute. Default `"unknown_agent"`. */
  serviceName?: string;
  /** Fetch implementation override (tests). */
  fetchImpl?: typeof fetch;
  /** Clock override (epoch ms; tests). */
  now?: () => number;
  /** Sleep override for backoff (tests). */
  sleep?: (ms: number) => Promise<void>;
}

export interface WorkloadOptions {
  /** Delay between simulated ticks (ms). Default 500. */
  tickMs?: number;
  /** Run exactly this many ticks synchronously and auto-stop (demo/push mode). */
  ticks?: number;
  /** Seed for the deterministic RNG, so demo output is reproducible. */
  seed?: number;
}

export interface WorkloadHandle {
  /** Stops the workload. A no-op when `ticks` mode already completed. */
  stop(): void;
  /** Number of ticks executed so far. */
  readonly ticksRun: number;
}

/** Options for `createMetricsServer`. */
export interface MetricsServerOptions {
  port?: number;
  host?: string;
}

/** The result of rendering `/metrics` for one scrape request. */
export interface MetricsResponse {
  status: number;
  contentType: string;
  body: string;
}

/** Options for the deterministic demo workload used by `serve`/`demo`/`push`. */
export interface WorkloadOptions {
  /** Interval between ticks in interval mode. Default 500. */
  tickMs?: number;
  /** When set, runs exactly this many ticks synchronously and stops. */
  ticks?: number;
  /** RNG seed for reproducible sessions. Default 2026. */
  seed?: number;
}

/** Handle returned by the workload so callers can stop interval mode. */
export interface WorkloadHandle {
  stop(): void;
  readonly ticksRun: number;
}
