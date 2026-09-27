/**
 * agent-observability-exporter — public API.
 *
 * Typical wiring:
 *   const registry = new MetricsRegistry();
 *   const logger = new AgentLogger();
 *   const server = createMetricsServer(() => registry.snapshot()); // Prometheus
 *   const exporter = new TelemetryExporter(() => registry.snapshot(), {
 *     endpoint: "http://collector:4318",
 *   });                                                            // OTLP push
 */

export { MetricsRegistry, DEFAULT_BUCKETS, validateMetricName, serializeLabels } from "./metrics.js";
export { renderPrometheus, PROMETHEUS_CONTENT_TYPE, escapeLabelValue, escapeHelp } from "./prometheus.js";
export { toOtlpMetrics, toOtlpLogs, severityNumber } from "./otlp.js";
export { TelemetryExporter } from "./exporter.js";
export { AgentLogger, formatJsonLine } from "./logger.js";
export { createMetricsServer, metricsHandler, PROMETHEUS_PATH, HEALTHZ_PATH } from "./server.js";
export { ExporterError, configError, validationError, networkError, timeoutError } from "./errors.js";
export { simulateAgentWork } from "./workload.js";

export type {
  AttributeValue,
  ExportResult,
  ExporterConfig,
  HistogramSample,
  LabelSet,
  LogLevel,
  LogRecord,
  MetricFamily,
  MetricKind,
  RegisterOptions,
  RegistrySnapshot,
  Sample,
  WorkloadHandle,
  WorkloadOptions,
} from "./types.js";
