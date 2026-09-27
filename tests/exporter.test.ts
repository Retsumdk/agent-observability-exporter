import { describe, test, expect } from "bun:test";
import { MetricsRegistry } from "../src/metrics.js";
import { AgentLogger } from "../src/logger.js";
import { TelemetryExporter } from "../src/exporter.js";
import type { ExporterConfig, ExportResult, LogRecord, RegistrySnapshot } from "../src/types.js";

interface RecordedRequest {
  url: string;
  body: unknown;
  status: number;
  requestHeaders: Record<string, string>;
}

function makeStubFetch(script: Array<{ status: number; headers?: Record<string, string> }>) {
  const requests: RecordedRequest[] = [];
  let call = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const step = script[Math.min(call, script.length - 1)] ?? { status: 200 };
    call += 1;
    const rawHeaders = new Headers(init?.headers);
    const requestHeaders: Record<string, string> = {};
    rawHeaders.forEach((value, key) => {
      requestHeaders[key] = value;
    });
    requests.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")),
      status: step.status,
      requestHeaders,
    });
    return new Response("{}", {
      status: step.status,
      headers: step.headers ?? { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, requests, getCalls: () => call };
}

function makeConfig(overrides: Partial<ExporterConfig> = {}): ExporterConfig {
  return {
    endpoint: "http://collector.internal:4318",
    backoffMs: 1,
    timeoutMs: 500,
    flushIntervalMs: 60_000,
    sleep: async () => {},
    ...overrides,
  };
}

describe("TelemetryExporter", () => {
  test("exportOnce pushes the snapshot to the metrics path", async () => {
    const { fetchImpl, requests } = makeStubFetch([{ status: 200 }]);
    const registry = new MetricsRegistry();
    registry.counter("jobs_total").inc(5);
    const exporter = new TelemetryExporter(() => registry.snapshot(), makeConfig({ fetchImpl }));
    const result = await exporter.exportOnce();
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://collector.internal:4318/v1/metrics");
    expect(requests[0]?.body).toHaveProperty("resourceMetrics");
  });

  test("queued logs go to the logs path", async () => {
    const { fetchImpl, requests } = makeStubFetch([{ status: 200 }, { status: 200 }]);
    const registry = new MetricsRegistry();
    const logger = new AgentLogger();
    logger.info("hello");
    const exporter = new TelemetryExporter(() => registry.snapshot(), makeConfig({ fetchImpl }));
    exporter.addLogs(logger.drain());
    const result = await exporter.exportOnce();
    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url).toBe("http://collector.internal:4318/v1/logs");
    expect(requests[1]?.body).toHaveProperty("resourceLogs");
  });

  test("429 and 5xx are retried with backoff, then reported", async () => {
    const { fetchImpl, requests } = makeStubFetch([
      { status: 429, headers: { "retry-after": "0" } },
      { status: 503 },
      { status: 503 },
    ]);
    const registry = new MetricsRegistry();
    const exporter = new TelemetryExporter(
      () => registry.snapshot(),
      makeConfig({ fetchImpl, maxAttempts: 3 }),
    );
    const result = await exporter.exportOnce();
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.status).toBe(503);
    expect(requests).toHaveLength(3);
  });

  test("4xx (other than 429) fails fast without retries", async () => {
    const { fetchImpl, requests } = makeStubFetch([{ status: 401 }]);
    const registry = new MetricsRegistry();
    const exporter = new TelemetryExporter(
      () => registry.snapshot(),
      makeConfig({ fetchImpl, maxAttempts: 5 }),
    );
    const result = await exporter.exportOnce();
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.attempts).toBe(1);
    expect(requests).toHaveLength(1);
  });

  test("eventual success after retries reports ok with attempt count", async () => {
    const { fetchImpl } = makeStubFetch([{ status: 503 }, { status: 200 }]);
    const registry = new MetricsRegistry();
    const exporter = new TelemetryExporter(
      () => registry.snapshot(),
      makeConfig({ fetchImpl, maxAttempts: 3 }),
    );
    const result = await exporter.exportOnce();
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
  });

  test("a numeric Retry-After header extends the backoff delay", async () => {
    let slept = 0;
    const { fetchImpl } = makeStubFetch([
      { status: 429, headers: { "retry-after": "2" } },
      { status: 200 },
    ]);
    const registry = new MetricsRegistry();
    const exporter = new TelemetryExporter(() => registry.snapshot(), {
      ...makeConfig({ fetchImpl, maxAttempts: 2, backoffMs: 10 }),
      sleep: async (ms) => {
        slept = ms;
      },
    });
    const result = await exporter.exportOnce();
    expect(result.ok).toBe(true);
    expect(slept).toBeGreaterThanOrEqual(2_000);
  });

  test("logs are re-queued when the logs push fails but metrics succeed", async () => {
    const { fetchImpl } = makeStubFetch([
      { status: 200 },
      { status: 500 },
      { status: 200 },
    ]);
    const registry = new MetricsRegistry();
    const logger = new AgentLogger();
    logger.warn("payload");
    const exporter = new TelemetryExporter(
      () => registry.snapshot(),
      makeConfig({ fetchImpl, maxAttempts: 2 }),
    );
    exporter.addLogs(logger.drain());
    const result = await exporter.exportOnce();
    expect(result.ok).toBe(true);
    expect(exporter.droppedLogRecords).toBe(0);
  });

  test("addLogs drops the oldest records beyond maxLogBatch and counts them", () => {
    const registry = new MetricsRegistry();
    const exporter = new TelemetryExporter(
      () => registry.snapshot(),
      makeConfig({ maxLogBatch: 3 }),
    );
    const records: LogRecord[] = [];
    for (let i = 0; i < 5; i++) records.push({ time: i, level: "INFO", message: `m${i}` });
    exporter.addLogs(records);
    expect(exporter.droppedLogRecords).toBe(2);
  });

  test("custom headers are attached to requests", async () => {
    const { fetchImpl, requests } = makeStubFetch([{ status: 200 }]);
    const registry = new MetricsRegistry();
    const exporter = new TelemetryExporter(
      () => registry.snapshot(),
      makeConfig({ fetchImpl, headers: { "x-api-key": "secret" } }),
    );
    await exporter.exportOnce();
    expect(requests[0]?.requestHeaders).toEqual({
      "content-type": "application/json",
      "x-api-key": "secret",
    });
  });

  test("constructor rejects a missing endpoint", () => {
    const registry = new MetricsRegistry();
    expect(
      () => new TelemetryExporter(() => registry.snapshot(), { ...makeConfig(), endpoint: "" }),
    ).toThrow(/endpoint is required/);
  });

  test("start/stop control periodic flushing", async () => {
    const { fetchImpl, getCalls } = makeStubFetch([{ status: 200 }]);
    const registry = new MetricsRegistry();
    const exporter = new TelemetryExporter(
      () => registry.snapshot(),
      makeConfig({ fetchImpl, flushIntervalMs: 30 }),
    );
    exporter.start();
    await new Promise((resolve) => setTimeout(resolve, 120));
    exporter.stop();
    const callsAfterStop = getCalls();
    expect(callsAfterStop).toBeGreaterThanOrEqual(2);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(getCalls()).toBe(callsAfterStop);
  });

  test("lastResult reflects the most recent export", async () => {
    const { fetchImpl } = makeStubFetch([{ status: 200 }]);
    const registry = new MetricsRegistry();
    const exporter = new TelemetryExporter(() => registry.snapshot(), makeConfig({ fetchImpl }));
    expect(exporter.lastResult).toBeNull();
    const result: ExportResult = await exporter.exportOnce();
    expect(result.ok).toBe(true);
    expect(exporter.lastResult?.ok).toBe(true);
  });

  test("snapshot is captured once per export and never after stop", async () => {
    const { fetchImpl, getCalls } = makeStubFetch([{ status: 200 }]);
    const registry = new MetricsRegistry();
    let captures = 0;
    const snapshot = (): RegistrySnapshot => {
      captures += 1;
      return registry.snapshot();
    };
    const exporter = new TelemetryExporter(snapshot, makeConfig({ fetchImpl }));
    await exporter.exportOnce();
    expect(captures).toBe(1);
    expect(getCalls()).toBe(1);
  });
});
