/**
 * CLI for agent-observability-exporter.
 *
 * Commands:
 *   serve  — run an instrumented demo agent exposing /metrics (and optionally
 *            pushing to an OTLP endpoint on an interval)
 *   push   — one-shot push of a freshly instrumented session to an OTLP
 *            endpoint (smoke-tests collector wiring)
 *   demo   — print a rendered Prometheus snapshot and OTLP JSON sample
 *   help   — usage
 */

import process from "node:process";
import { parseArgs } from "node:util";
import { MetricsRegistry } from "./metrics.js";
import { renderPrometheus } from "./prometheus.js";
import { toOtlpMetrics, toOtlpLogs } from "./otlp.js";
import { TelemetryExporter } from "./exporter.js";
import { AgentLogger } from "./logger.js";
import { createMetricsServer } from "./server.js";
import { ExporterError } from "./errors.js";
import { simulateAgentWork } from "./workload.js";

interface ServeOptions {
  port: number;
  host: string;
  intervalMs: number;
  endpoint?: string;
  serviceName: string;
}

function parseServeOptions(values: Record<string, string | boolean | undefined>): ServeOptions {
  const port = Number(values.port ?? 9090);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ExporterError("CONFIG_ERROR", `invalid --port: ${String(values.port)}`);
  }
  const intervalMs = Number(values.interval ?? 10_000);
  if (!Number.isInteger(intervalMs) || intervalMs < 250) {
    throw new ExporterError("CONFIG_ERROR", `invalid --interval: ${String(values.interval)} (min 250)`);
  }
  const endpoint = typeof values.endpoint === "string" && values.endpoint.length > 0
    ? values.endpoint
    : undefined;
  if (endpoint !== undefined) {
    try {
      new URL(endpoint);
    } catch {
      throw new ExporterError("CONFIG_ERROR", `invalid --endpoint URL: ${endpoint}`);
    }
  }
  const serviceName =
    typeof values["service-name"] === "string" ? values["service-name"] : "demo_agent";
  return {
    port,
    host: typeof values.host === "string" ? values.host : "0.0.0.0",
    intervalMs,
    ...(endpoint === undefined ? {} : { endpoint }),
    serviceName,
  };
}

function cmdServe(values: Record<string, string | boolean | undefined>): number {
  const options = parseServeOptions(values);
  const registry = new MetricsRegistry();
  const logger = new AgentLogger({ mirror: true });
  const exporter = options.endpoint
    ? new TelemetryExporter(() => registry.snapshot(), {
        endpoint: options.endpoint,
        flushIntervalMs: options.intervalMs,
        serviceName: options.serviceName,
      })
    : undefined;
  if (exporter) {
    logger.onRecord = (records) => exporter.addLogs(records);
  }

  const workload = simulateAgentWork(registry, logger, { tickMs: 500 });
  const server = createMetricsServer(() => registry.snapshot(), {
    port: options.port,
    host: options.host,
  });
  server.listen(options.port, options.host, () => {
    const addr = server.address();
    const shown =
      addr && typeof addr === "object" ? `http://127.0.0.1:${addr.port}` : `port ${options.port}`;
    process.stdout.write(
      `[agent-obs] metrics on ${shown}/metrics\n` +
      `[agent-obs] health on   ${shown}/healthz\n` +
      (exporter
        ? `[agent-obs] pushing OTLP to ${options.endpoint} every ${options.intervalMs}ms\n`
        : "[agent-obs] no --endpoint given; Prometheus scraping only\n"),
    );
  });
  if (exporter) exporter.start();

  let exitCode = 0;
  const shutdown = (): void => {
    workload.stop();
    exporter?.stop();
    server.close(() => process.exit(exitCode));
    setTimeout(() => process.exit(exitCode), 2_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return 0;
}

async function cmdPush(values: Record<string, string | boolean | undefined>): Promise<number> {
  const endpoint = values.endpoint;
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    throw new ExporterError("CONFIG_ERROR", "push requires --endpoint <OTLP base URL>");
  }
  try {
    new URL(endpoint);
  } catch {
    throw new ExporterError("CONFIG_ERROR", `invalid --endpoint URL: ${endpoint}`);
  }
  const registry = new MetricsRegistry();
  const logger = new AgentLogger();
  simulateAgentWork(registry, logger, { ticks: 12, tickMs: 25 });
  const exporter = new TelemetryExporter(() => registry.snapshot(), {
    endpoint,
    serviceName: "push_smoke_agent",
  });
  exporter.addLogs(logger.drain());
  const result = await exporter.exportOnce();
  if (!result.ok) {
    process.stderr.write(`[agent-obs] push failed: ${result.error ?? "unknown"}\n`);
    return 1;
  }
  process.stdout.write(
    `[agent-obs] pushed snapshot in ${result.durationMs}ms after ${result.attempts} attempt(s)\n`,
  );
  return 0;
}

function cmdDemo(): number {
  const registry = new MetricsRegistry();
  const logger = new AgentLogger();
  simulateAgentWork(registry, logger, { ticks: 40, tickMs: 1 });
  process.stdout.write("=== Prometheus text exposition (what a scraper reads) ===\n");
  process.stdout.write(renderPrometheus(registry.snapshot()));
  process.stdout.write("\n=== OTLP/HTTP JSON body (what gets POSTed to /v1/metrics) ===\n");
  process.stdout.write(JSON.stringify(toOtlpMetrics(registry.snapshot(), { serviceName: "demo_agent" }), null, 2));
  process.stdout.write("\n=== OTLP/HTTP JSON body (what gets POSTed to /v1/logs) ===\n");
  process.stdout.write(JSON.stringify(toOtlpLogs(logger.drain(), { serviceName: "demo_agent" }), null, 2));
  process.stdout.write("\n");
  return 0;
}

function usage(): string {
  return [
    "agent-obs — telemetry exporter for AI agents (Prometheus + OTLP/HTTP)",
    "",
    "Usage:",
    "  agent-obs serve [--port 9090] [--host 0.0.0.0] [--interval 10000]",
    "                  [--endpoint http://collector:4318] [--service-name demo_agent]",
    "  agent-obs push --endpoint http://collector:4318",
    "  agent-obs demo",
    "  agent-obs help",
    "",
    "serve  Simulated agent workload with a live /metrics endpoint; add",
    "       --endpoint to also push OTLP metrics + logs on an interval.",
    "push   One-shot OTLP push of a short instrumented session (collector smoke test).",
    "demo   Print the Prometheus rendering and OTLP JSON without any network.",
  ].join("\n");
}

export async function runCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage() + "\n");
    return 0;
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      port: { type: "string", short: "p" },
      host: { type: "string" },
      interval: { type: "string" },
      endpoint: { type: "string", short: "e" },
      "service-name": { type: "string" },
    },
    allowPositionals: false,
  });
  switch (command) {
    case "serve":
      return cmdServe(values);
    case "push":
      return await cmdPush(values);
    case "demo":
      return cmdDemo();
    default:
      process.stderr.write(`unknown command: ${command}\n\n${usage()}\n`);
      return 1;
  }
}
