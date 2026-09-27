/**
 * TelemetryExporter — pushes metrics snapshots and structured logs to an
 * OTLP/HTTP collector with batching, timeouts, and exponential-backoff retry.
 *
 * The Prometheus path needs no exporter: any scraper reads `renderPrometheus`
 * output (served by `createMetricsServer`). This module covers the push side:
 * OpenTelemetry collectors (otel-collector, Grafana Alloy, Jaeger, Honeycomb,
 * Datadog OTLP endpoints) accept OTLP/HTTP JSON on `/v1/metrics` and `/v1/logs`.
 *
 * Failure semantics:
 * - 2xx → success (a `partialSuccess` body is surfaced as rejected* counts).
 * - 4xx other than 429 → permanent failure, no retry.
 * - 429/5xx/network/timeout → retried up to `maxAttempts` with exponential
 *   backoff + jitter; a numeric `Retry-After` header is honoured additively.
 * - Log records are only dropped from the pending buffer after a successful
 *   push; on overflow the oldest records are dropped and counted.
 */

import type {
  ExportResult,
  ExporterConfig,
  LogRecord,
  RegistrySnapshot,
} from "./types.js";
import { toOtlpLogs, toOtlpMetrics } from "./otlp.js";
import { ExporterError } from "./errors.js";

interface OtlpPartialSuccess {
  rejectedDataPoints?: number;
  rejectedLogRecords?: number;
  errorMessage?: string;
}

const DEFAULT_SERVICE_NAME = "unknown_agent";

const DEFAULTS = {
  metricsPath: "/v1/metrics",
  logsPath: "/v1/logs",
  flushIntervalMs: 10_000,
  maxLogBatch: 512,
  maxAttempts: 3,
  backoffMs: 250,
  backoffCapMs: 8_000,
  timeoutMs: 10_000,
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class TelemetryExporter {
  private readonly metricsPath: string;
  private readonly logsPath: string;
  private readonly flushIntervalMs: number;
  private readonly maxLogBatch: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly backoffCapMs: number;
  private readonly timeoutMs: number;
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly serviceName: string;
  private readonly logsPending: LogRecord[] = [];
  private readonly onLog: ((records: LogRecord[]) => void) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = true;

  /** Result of the most recent `exportOnce` (successful or not). */
  lastResult: ExportResult | null = null;
  /** Log records dropped because the pending buffer overflowed. */
  droppedLogRecords = 0;

  constructor(
    private readonly snapshot: () => RegistrySnapshot,
    config: ExporterConfig,
    hooks: { onLog?: (records: LogRecord[]) => void } = {},
  ) {
    if (!config.endpoint) throw new ExporterError("CONFIG_ERROR", "endpoint is required");
    this.endpoint = config.endpoint;
    this.metricsPath = config.metricsPath ?? DEFAULTS.metricsPath;
    this.logsPath = config.logsPath ?? DEFAULTS.logsPath;
    this.flushIntervalMs = config.flushIntervalMs ?? DEFAULTS.flushIntervalMs;
    this.maxLogBatch = config.maxLogBatch ?? DEFAULTS.maxLogBatch;
    this.maxAttempts = Math.max(1, config.maxAttempts ?? DEFAULTS.maxAttempts);
    this.backoffMs = config.backoffMs ?? DEFAULTS.backoffMs;
    this.backoffCapMs = config.backoffCapMs ?? DEFAULTS.backoffCapMs;
    this.timeoutMs = config.timeoutMs ?? DEFAULTS.timeoutMs;
    this.headers = { "content-type": "application/json", ...config.headers };
    this.serviceName = config.serviceName ?? DEFAULT_SERVICE_NAME;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? Date.now;
    this.sleepImpl = config.sleep ?? defaultSleep;
    this.onLog = hooks.onLog;
  }

  /** Queue log records (typically `logger.drain()` output) for the next flush. */
  addLogs(records: LogRecord[]): void {
    if (records.length === 0) return;
    const overflow = this.logsPending.length + records.length - this.maxLogBatch;
    if (overflow > 0) {
      this.logsPending.splice(0, overflow);
      this.droppedLogRecords += overflow;
    }
    this.logsPending.push(...records);
  }

  /** Push the current metrics snapshot and any pending logs once. */
  async exportOnce(): Promise<ExportResult> {
    const startedAt = this.now();
    const snapshot = this.snapshot();
    const logs = this.logsPending.splice(0, this.logsPending.length);

    const metricsResult = await this.sendWithRetry(
      this.metricsPath,
      toOtlpMetrics(snapshot, { serviceName: this.serviceName }),
    );

    let logsResult: ExportResult | null = null;
    if (logs.length > 0) {
      logsResult = await this.sendWithRetry(
        this.logsPath,
        toOtlpLogs(logs, { serviceName: this.serviceName }),
      );
      if (logsResult.ok) {
        this.onLog?.(logs);
      } else {
        this.logsPending.unshift(...logs);
      }
    }

    const result: ExportResult = {
      ok: metricsResult.ok && (logsResult === null || logsResult.ok),
      attempts: Math.max(metricsResult.attempts, logsResult?.attempts ?? 1),
      durationMs: this.now() - startedAt,
      ...(metricsResult.rejectedDataPoints ? { rejectedDataPoints: metricsResult.rejectedDataPoints } : {}),
      ...(logsResult?.rejectedLogRecords ? { rejectedLogRecords: logsResult.rejectedLogRecords } : {}),
    };
    if (metricsResult.status !== undefined) result.status = metricsResult.status;
    if (metricsResult.error !== undefined) result.error = metricsResult.error;
    this.lastResult = result;
    return result;
  }

  /** Start periodic flushing. Safe to call more than once. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.exportOnce().catch(() => {
        /* exportOnce never throws; failures are recorded on lastResult */
      });
    }, this.flushIntervalMs);
    this.timer.unref?.();
  }

  /** Stop periodic flushing. Pending logs remain queued for a manual `exportOnce`. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.stopped = true;
  }

  private async sendWithRetry(path: string, body: unknown): Promise<ExportResult> {
    const url = new URL(path, this.endpoint).toString();
    const sendStartedAt = this.now();
    let attempt = 0;
    let lastError = "unknown error";
    let lastStatus: number | undefined;
    let rejected: { rejectedDataPoints?: number; rejectedLogRecords?: number } | undefined;
    let retryAfterMs = 0;

    while (attempt < this.maxAttempts) {
      attempt += 1;
      try {
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers: this.headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (response.status >= 200 && response.status < 300) {
          rejected = await this.inspectPartialSuccess(response);
          return {
            ok: true,
            attempts: attempt,
            durationMs: this.now() - sendStartedAt,
            ...(rejected?.rejectedDataPoints ? { rejectedDataPoints: rejected.rejectedDataPoints } : {}),
            ...(rejected?.rejectedLogRecords ? { rejectedLogRecords: rejected.rejectedLogRecords } : {}),
          };
        }
        lastStatus = response.status;
        lastError = `HTTP ${response.status}`;
        if (response.status === 429 || response.status === 503) {
          retryAfterMs = parseRetryAfter(response.headers.get("retry-after")) ?? 0;
        }
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          break; // client errors are permanent
        }
      } catch (error) {
        if (error instanceof ExporterError) {
          lastError = error.message;
        } else if (error instanceof Error && error.name === "TimeoutError") {
          lastError = `request timed out after ${this.timeoutMs}ms`;
        } else if (error instanceof Error) {
          lastError = error.message;
        } else {
          lastError = String(error);
        }
      }
      if (attempt < this.maxAttempts) {
        await this.sleepImpl(this.delayFor(attempt) + retryAfterMs);
        retryAfterMs = 0;
      }
    }
    return {
      ok: false,
      attempts: attempt,
      durationMs: this.now() - sendStartedAt,
      ...(lastStatus === undefined ? {} : { status: lastStatus }),
      error: lastError,
    };
  }

  private delayFor(attempt: number): number {
    const base = Math.min(this.backoffMs * 2 ** (attempt - 1), this.backoffCapMs);
    const jitter = base * 0.25 * (Math.random() * 2 - 1);
    return Math.max(0, base + jitter);
  }

  /** Reads a 2xx body and surfaces OTLP `partialSuccess` counts, if any. */
  private async inspectPartialSuccess(
    response: Response,
  ): Promise<{ rejectedDataPoints?: number; rejectedLogRecords?: number } | undefined> {
    const text = await response.text();
    if (!text) return undefined;
    try {
      const parsed = JSON.parse(text) as { partialSuccess?: OtlpPartialSuccess };
      const partial = parsed.partialSuccess;
      if (partial && (partial.rejectedDataPoints || partial.rejectedLogRecords)) {
        console.warn(`[exporter] collector rejected data: ${JSON.stringify(partial)}`);
        return {
          ...(partial.rejectedDataPoints ? { rejectedDataPoints: partial.rejectedDataPoints } : {}),
          ...(partial.rejectedLogRecords ? { rejectedLogRecords: partial.rejectedLogRecords } : {}),
        };
      }
      return undefined;
    } catch {
      /* non-JSON 2xx body — acceptable */
      return undefined;
    }
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}
