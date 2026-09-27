/**
 * Quickstart: instrument a tiny agent loop, expose it to Prometheus, and
 * push one export to an OTLP/HTTP collector.
 *
 *   bun examples/quickstart.ts
 *   bun examples/quickstart.ts http://localhost:4318
 *
 * With no argument the OTLP push is skipped (the demo collector is optional).
 */
import { MetricsRegistry } from "../src/metrics.js";
import { AgentLogger } from "../src/logger.js";
import { TelemetryExporter } from "../src/exporter.js";
import { renderPrometheus } from "../src/prometheus.js";
import { toOtlpMetrics } from "../src/otlp.js";

const endpoint = process.argv[2];

const registry = new MetricsRegistry();
const logger = new AgentLogger({ mirror: false });
const tasks = registry.counter("agent_tasks_total", { kind: "summarize" }, {
  help: "Tasks completed",
});
const latency = registry.histogram("agent_task_latency_seconds", undefined, {
  help: "Task latency",
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});
const active = registry.gauge("agent_tasks_active", undefined, { help: "Tasks in flight" });

for (let task = 1; task <= 5; task++) {
  active.inc();
  const startedAt = Date.now();
  logger.info("task started", { task });
  await new Promise((resolve) => setTimeout(resolve, 40));
  latency.observe((Date.now() - startedAt) / 1000);
  active.dec();
  tasks.inc();
  logger.info("task finished", { task });
}

console.log("--- Prometheus exposition (what /metrics serves) ---");
console.log(renderPrometheus(registry.snapshot()));

if (endpoint) {
  const exporter = new TelemetryExporter(() => registry.snapshot(), {
    endpoint,
    serviceName: "quickstart_agent",
  });
  exporter.addLogs(logger.drain());
  const result = await exporter.exportOnce();
  console.log(`--- OTLP push to ${endpoint}: ${result.ok ? "ok" : `failed (${result.error})`} ---`);
  console.log(JSON.stringify(toOtlpMetrics(registry.snapshot(), { serviceName: "quickstart_agent" })).slice(0, 400));
}
