/**
 * Deterministic simulated agent workload.
 *
 * `serve` uses it in interval mode to keep a live /metrics endpoint interesting;
 * `demo` and `push` use it in fixed-ticks mode so output is reproducible
 * (seeded mulberry32 RNG — same seed, same numbers, same README output).
 */

import type { WorkloadHandle, WorkloadOptions } from "./types.js";
import type { MetricsRegistry } from "./metrics.js";
import type { AgentLogger } from "./logger.js";

const TOOLS = ["search", "fetch", "summarize"] as const;
const ERROR_KINDS = ["timeout", "rate_limit", "tool_failure"] as const;

export function simulateAgentWork(
  registry: MetricsRegistry,
  logger: AgentLogger,
  options: WorkloadOptions = {},
): WorkloadHandle {
  const tickMs = options.tickMs ?? 500;
  const seed = options.seed ?? 2026;
  const random = mulberry32(seed);

  const tasksOk = registry.counter(
    "agent_tasks_completed_total",
    { status: "ok" },
    { help: "Tasks the agent finished, by final status" },
  );
  const tasksError = registry.counter("agent_tasks_completed_total", { status: "error" });
  const toolHandles = new Map<string, ReturnType<MetricsRegistry["counter"]>>(
    TOOLS.map((tool) => [
      tool,
      registry.counter(
        "agent_tool_calls_total",
        { tool },
        { help: "Tool invocations, by tool name" },
      ),
    ]),
  );
  const errorHandles = new Map<string, ReturnType<MetricsRegistry["counter"]>>(
    ERROR_KINDS.map((kind) => [
      kind,
      registry.counter("agent_errors_total", { kind }, { help: "Errors encountered, by kind" }),
    ]),
  );
  const tokensUsed = registry.counter("agent_tokens_used_total", undefined, {
    help: "Model tokens consumed (input + output)",
  });
  const activeTasks = registry.gauge("agent_active_tasks", undefined, {
    help: "Tasks currently in flight",
  });
  const taskDuration = registry.histogram("agent_task_duration_ms", undefined, {
    help: "End-to-end task duration",
    unit: "ms",
    buckets: [25, 50, 100, 200, 400, 800, 1_600, 3_200],
  });

  let ticksRun = 0;
  let active = 2;

  const tick = (): void => {
    ticksRun += 1;

    // Tasks arrive and complete at slightly different rates.
    const arrivals = intBetween(random, 0, 3);
    const completions = Math.min(active, intBetween(random, 0, 2));
    active = Math.max(0, active + arrivals - completions);
    activeTasks.set(active);

    const failed = completions > 0 && random() < 0.15 ? 1 : 0;
    const succeeded = completions - failed;
    if (succeeded > 0) {
      const durationMs = intBetween(random, 20, 2_800);
      tasksOk.inc(succeeded);
      taskDuration.observe(durationMs);
      logger.info("task completed", { task_id: `t-${ticksRun}`, duration_ms: durationMs });
    }
    if (failed > 0) {
      const kind = pick(random, ERROR_KINDS);
      tasksError.inc(1);
      errorHandles.get(kind)?.inc(1);
      logger.warn("task failed", { kind, task_id: `t-${ticksRun}` });
    }

    const calls = intBetween(random, 0, 4);
    for (let i = 0; i < calls; i++) {
      const tool = pick(random, TOOLS);
      toolHandles.get(tool)?.inc(1);
    }

    tokensUsed.inc(intBetween(random, 120, 900));
  };

  if (options.ticks !== undefined) {
    const ticks = Math.max(0, Math.trunc(options.ticks));
    for (let i = 0; i < ticks; i++) tick();
    return { stop: (): void => undefined, get ticksRun(): number { return ticksRun; } };
  }

  const timer = setInterval(tick, tickMs);
  timer.unref?.();
  return {
    stop: (): void => {
      clearInterval(timer);
    },
    get ticksRun(): number {
      return ticksRun;
    },
  };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function intBetween(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

function pick<T>(random: () => number, items: readonly T[]): T {
  const index = Math.min(items.length - 1, Math.floor(random() * items.length));
  const value = items[index];
  if (value === undefined) throw new Error("workload pick on empty list");
  return value;
}
