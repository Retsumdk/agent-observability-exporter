# agent-observability-exporter

Prometheus and OTLP/HTTP telemetry exporters for AI agent metrics and logs — zero runtime dependencies.

AI agents fail quietly: a tool call times out, a task loop spins on rate limits, token spend doubles overnight — and nothing surfaces until a human notices the bill or the deadlock. This library gives an agent runtime the two standard emission paths ops teams already run:

- **Pull** — a Prometheus text-exposition (`/metrics`) endpoint that Grafana scrapes like any other service.
- **Push** — OTLP/HTTP JSON payloads (`/v1/metrics`, `/v1/logs`) that any OpenTelemetry collector accepts (otel-collector, Grafana Alloy, Jaeger, Honeycomb, Datadog, and vendor OTLP endpoints).

Both paths read from the same in-process metrics registry and structured logger, so a dashboard built on the pull side and a trace pipeline on the push side always agree.

## Why not just use an SDK?

The OpenTelemetry SDKs are excellent and heavy: they bring exporters, resource detection, sampling, context propagation, and a dependency tree to match. An agent runtime often needs neither the dependencies nor the machinery — it needs counters, gauges, and histograms for task throughput, tool latency, and token spend; it needs structured logs with severity and attributes; and it needs them in the two wire formats the ecosystem already speaks. This library is exactly that, in ~1,200 lines of strict TypeScript with **zero runtime dependencies** (the CLI uses `node:util` `parseArgs`; the server uses `node:http`).

When you outgrow it, the registry and logger are small enough to keep as the emission layer and forward into a full SDK.

## Features

- **Metrics registry** — monotonic counters, point-in-time gauges, and cumulative histograms with explicit or default buckets, keyed by metric name plus a sorted label set.
- **Prometheus text format 0.0.4** — correct `# HELP`/`# TYPE` lines, `_total` counter suffixing, `le` bucket lines, `NaN`/`+Inf`/`-Inf` rendering, and label/HELP escaping per the exposition spec.
- **OTLP/HTTP JSON** — spec-compliant `ExportMetricsServiceRequest` and `ExportLogsServiceRequest` bodies: int64s as decimal strings, CUMULATIVE temporality, monotonic sums, histogram `bucketCounts`/`explicitBounds`, severity numbers (DEBUG=5, INFO=9, WARN=13, ERROR=17).
- **Reliable push** — batching with a bounded log buffer, per-request timeouts, exponential backoff with jitter, `Retry-After` support, fast-fail on 4xx (except 429), and OTLP `partialSuccess` surfacing.
- **Structured logging** — a bounded ring buffer of JSON records with injectable clock; the exporter drains it and ships it as OTLP logs.
- **Standalone server or embedded handler** — `createMetricsServer` for the common case, `metricsHandler(snapshot)` for mounting in any existing HTTP framework.
- **Reproducible demo workload** — a seeded simulated agent so docs, tests, and dashboards can be exercised deterministically.

## Installation

```bash
git clone https://github.com/Retsumdk/agent-observability-exporter.git
cd agent-observability-exporter
bun install          # or: npm install   (both run the prepare script and build dist/)
```

Requires Node >= 20 (library + CLI) or Bun >= 1.1 (tests).

## Quickstart

Instrument a tiny agent loop, render Prometheus text, and push one export to an OTLP endpoint:

```bash
bun examples/quickstart.ts http://localhost:4318
```

```text
--- Prometheus exposition (what /metrics serves) ---
# HELP agent_tasks Tasks completed
# TYPE agent_tasks counter
agent_tasks_total{kind="summarize"} 5
# HELP agent_task_latency_seconds Task latency
# TYPE agent_task_latency_seconds histogram
agent_task_latency_seconds_bucket{le="0.1"} 5
agent_task_latency_seconds_bucket{le="0.25"} 5
...
agent_task_latency_seconds_sum 0.203
agent_task_latency_seconds_count 5
# HELP agent_tasks_active Tasks in flight
# TYPE agent_tasks_active gauge
agent_tasks_active 0
```

### Library use

```typescript
import { MetricsRegistry, AgentLogger, TelemetryExporter,
         renderPrometheus, createMetricsServer } from "agent-observability-exporter";

const registry = new MetricsRegistry();
const logger = new AgentLogger({ mirror: true });

const tasksOk = registry.counter("agent_tasks_completed_total", { status: "ok" }, {
  help: "Tasks the agent finished, by final status",
});
const latency = registry.histogram("agent_task_duration_ms", undefined, {
  help: "End-to-end task duration", unit: "ms", buckets: [25, 50, 100, 200, 400, 800, 1600, 3200],
});
const active = registry.gauge("agent_active_tasks", { help: "Tasks currently in flight" });

async function runTask(id: string): Promise<void> {
  active.inc();
  const startedAt = Date.now();
  try {
    await doWork(id);                 // your agent logic
    tasksOk.inc();
    logger.info("task completed", { task_id: id });
  } finally {
    latency.observe(Date.now() - startedAt);
    active.dec();
  }
}

// Pull: mount in any HTTP server.
const server = createMetricsServer(() => registry.snapshot());
server.listen(9090);

// Push: batch and forward to an OTLP collector.
const exporter = new TelemetryExporter(() => registry.snapshot(), {
  endpoint: "http://localhost:4318",
  serviceName: "my_agent",
});
logger.onRecord = (records) => exporter.addLogs(records);
exporter.start();
```

The push side is consumer-verified against a plain Node 22 install (`npm install github:Retsumdk/agent-observability-exporter`), which runs the `prepare` script, builds `dist/`, and imports as ESM:

```text
$ node consumer.mjs
prometheus lines: 3
otlp envelope has resourceMetrics: true
push ok: false (expected — no collector running in this example)
```

## CLI

The package installs an `agent-obs` binary (`node dist/main.js`):

| Command | What it does |
|---|---|
| `agent-obs serve [--port 9090] [--host 0.0.0.0] [--interval 10000] [--endpoint URL] [--service-name NAME]` | Runs a seeded, simulated agent workload with a live `/metrics` endpoint. With `--endpoint`, also pushes OTLP metrics + logs every `--interval` ms. |
| `agent-obs push --endpoint URL` | Runs a short instrumented session and pushes metrics + logs once — a collector wiring smoke test. Exit 1 on failure. |
| `agent-obs demo` | Prints the Prometheus rendering and full OTLP JSON bodies without any network. |
| `agent-obs help` | Usage. |

`agent-obs demo` output (seed 2026, 40 ticks — reproducible):

```text
=== Prometheus text exposition (what a scraper reads) ===
# HELP agent_tasks_completed Tasks the agent finished, by final status
# TYPE agent_tasks_completed counter
agent_tasks_completed_total{status="error"} 4
agent_tasks_completed_total{status="ok"} 43
# HELP agent_tool_calls Tool invocations, by tool name
# TYPE agent_tool_calls counter
agent_tool_calls_total{tool="fetch"} 22
agent_tool_calls_total{tool="search"} 28
agent_tool_calls_total{tool="summarize"} 23
# HELP agent_errors Errors encountered, by kind
# TYPE agent_errors counter
agent_errors_total{kind="rate_limit"} 3
agent_errors_total{kind="timeout"} 1
agent_errors_total{kind="tool_failure"} 0
# HELP agent_tokens_used Model tokens consumed (input + output)
# TYPE agent_tokens_used counter
agent_tokens_used_total 19979
# HELP agent_active_tasks Tasks currently in flight
# TYPE agent_active_tasks gauge
agent_active_tasks 24
# HELP agent_task_duration_ms End-to-end task duration
# TYPE agent_task_duration_ms histogram
agent_task_duration_ms_bucket{le="25"} 0
agent_task_duration_ms_bucket{le="50"} 0
agent_task_duration_ms_bucket{le="100"} 1
agent_task_duration_ms_bucket{le="200"} 1
agent_task_duration_ms_bucket{le="400"} 4
agent_task_duration_ms_bucket{le="800"} 8
agent_task_duration_ms_bucket{le="1600"} 16
agent_task_duration_ms_bucket{le="3200"} 24
agent_task_duration_ms_bucket{le="+Inf"} 24
agent_task_duration_ms_sum 32226
agent_task_duration_ms_count 24
```

The same snapshot renders as an OTLP `ExportMetricsServiceRequest` (abridged):

```json
{
  "resourceMetrics": [
    {
      "resource": { "attributes": [{ "key": "service.name", "value": { "stringValue": "demo_agent" } }] },
      "scopeMetrics": [
        {
          "scope": { "name": "agent-observability-exporter", "version": "1.0.0" },
          "metrics": [
            {
              "name": "agent_task_duration_ms",
              "unit": "ms",
              "histogram": {
                "aggregationTemporality": 2,
                "dataPoints": [
                  {
                    "attributes": [],
                    "count": "24",
                    "sum": 32226,
                    "bucketCounts": ["0", "0", "1", "1", "4", "8", "16", "24", "24"],
                    "explicitBounds": [25, 50, 100, 200, 400, 800, 1600, 3200],
                    "timeUnixNano": "1790540262021000000",
                    "min": 56,
                    "max": 2699
                  }
                ]
              }
            }
          ]
        }
      ]
    }
  ]
}
```

Spec notes the encoders follow: int64 fields (`timeUnixNano`, histogram `count`, `bucketCounts`) serialize as decimal strings; sums are CUMULATIVE (2) and monotonic; `min`/`max` are emitted only when the histogram has observations; log severity numbers are DEBUG=5, INFO=9, WARN=13, ERROR=17.

### Live server

```bash
node dist/main.js serve --port 9753
```

```text
[agent-obs] metrics on http://127.0.0.1:9753/metrics
[agent-obs] health on   http://127.0.0.1:9753/healthz
[agent-obs] no --endpoint given; Prometheus scraping only
{"time":1790540267884,"level":"WARN","message":"task failed","attributes":{"kind":"timeout","task_id":"t-3"}}
```

```bash
$ curl -s http://127.0.0.1:9753/healthz
ok
$ curl -s http://127.0.0.1:9753/metrics | head -4
# HELP agent_tasks_completed Tasks the agent finished, by final status
# TYPE agent_tasks_completed counter
agent_tasks_completed_total{status="error"} 1
agent_tasks_completed_total{status="ok"} 0
```

### Grafana

Point a Prometheus datasource at `http://<agent-host>:9090/metrics` (scrape interval 5–15s). Counters arrive as `agent_*_total`, so `rate(agent_tasks_completed_total{status="error"}[5m])` gives you an error-rate panel with zero configuration. For the push path, add an OTLP HTTP receiver on your collector and set `--endpoint http://collector:4318`.

## API

### `MetricsRegistry`

| Member | Description |
|---|---|
| `counter(name, labels?, options?)` | Returns a `CounterHandle` bound to that label set. `inc(value?)` rejects negative and non-finite values. |
| `gauge(name, labels?, options?)` | Returns a `GaugeHandle` with `set`, `inc`, `dec`, `get`. |
| `histogram(name, labels?, options?)` | Returns a `HistogramHandle` with `observe(value)`. Buckets are validated (finite, unique) and stored cumulative. Defaults: `[0.005 … 10]`. |
| `snapshot(nowMs?)` | Pure-data `RegistrySnapshot` — `{ capturedAt, metrics: MetricFamily[] }`. |
| `reset()` | Drops every family. |

`RegisterOptions`: `help` (emitted as `# HELP` and OTLP `description`), `unit` (OTLP only), `buckets` (histograms). Metric names must match `[a-zA-Z_:][a-zA-Z0-9_:]*`; label names `[a-zA-Z_][a-zA-Z0-9_]*`. Re-registering the same name with a different kind, or a histogram with different buckets, throws a `VALIDATION_ERROR`.

### `AgentLogger`

`debug/info/warn/error(message, attributes?)` buffer structured records (bounded, default 2048). `drain()` removes and returns them; `onRecord` receives each record as emitted (the CLI wires this to the exporter); `child(bindings)` derives a logger with merged attributes; `flushToSink()` invokes an optional `sink` callback. Timestamps come from an injectable clock.

### `TelemetryExporter`

`new TelemetryExporter(() => registry.snapshot(), config)`.

| Config | Default | |
|---|---|---|
| `endpoint` | — | OTLP/HTTP base, required |
| `metricsPath` / `logsPath` | `/v1/metrics`, `/v1/logs` | |
| `headers` | — | Static headers (auth tokens) |
| `flushIntervalMs` | 10000 | Background flush period |
| `maxLogBatch` | 512 | Bounded pending-log buffer (oldest dropped, counted in `droppedLogRecords`) |
| `maxAttempts` | 3 | Attempts per export; 4xx (except 429) fails on the first attempt |
| `backoffMs` | 250 | Exponential base with ±25% jitter, 8s cap; numeric `Retry-After` is honored |
| `timeoutMs` | 10000 | Per-request timeout |
| `serviceName` | `"unknown_agent"` | `service.name` resource attribute |
| `fetchImpl`, `now`, `sleep` | global | Injection points for deterministic tests |

`exportOnce()` pushes the metrics snapshot, then any pending logs; both must succeed for `ok: true`, and a failed logs push is re-queued, not dropped. OTLP `partialSuccess` rejections surface in `rejectedDataPoints`/`rejectedLogRecords`. `start()`/`stop()` control the interval; `lastResult` always reflects the most recent attempt.

### `createMetricsServer` / `metricsHandler`

`createMetricsServer(() => registry.snapshot())` serves `GET /metrics` (text/plain; version=0.0.4), `GET /healthz` and `GET /-/ready` (200 `ok`), `HEAD /metrics`, `405` with an `allow` header for wrong methods, and JSON `404`s otherwise. `metricsHandler(snapshot)` is the transport-agnostic core — `{ status, contentType, body }` — for mounting in Express/Fastify/Hono.

### `simulateAgentWork(registry, logger, options?)`

Seeded (mulberry32, default seed 2026) simulated workload: task arrivals/completions, tool calls, token spend, error kinds, task-duration histogram, and structured logs. `options.ticks` runs a fixed number of iterations synchronously (used by `demo`/`push` and the tests); otherwise it runs on an interval and the returned handle's `stop()` ends it.

## Development

```bash
bun install
bun run typecheck   # tsc --noEmit (strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes)
bun test            # 75 tests
bun run build       # emits dist/ with declarations
bun run demo        # node dist/main.js demo
```

CI runs typecheck → test → build → a Node CLI smoke test on every push and PR.

## Design notes

- **Snapshots are plain data.** Registry, renderers, and exporter communicate through `RegistrySnapshot`, so any of them can be replaced or tested without mocks.
- **Cumulative buckets at observation time.** `observe` increments every bucket from the matched boundary up, which is what both Prometheus `le` lines and OTLP `bucketCounts` expect.
- **Int64s are strings.** OTLP's JSON mapping encodes 64-bit integers as decimal strings; the encoders do the same so collectors don't reject precision-losing numbers.
- **Failures are data, not exceptions.** Push failures return `ExportResult` with `attempts`/`status`/`error`; constructors throw typed `ExporterError`s with stable `code`s for config mistakes.

## License

[MIT](LICENSE) — Copyright (c) 2026 Retsumdk
