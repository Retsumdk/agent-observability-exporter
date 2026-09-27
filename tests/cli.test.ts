import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "dist", "main.js");

function runCli(
  args: string[],
  timeoutMs = 15_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, ...args], { env: { ...process.env, NO_COLOR: "1" } });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe("CLI", () => {
  test(
    "demo prints a Prometheus snapshot and OTLP previews and exits 0",
    async () => {
      const result = await runCli(["demo"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("# TYPE agent_tasks_completed counter");
      expect(result.stdout).toContain("agent_tokens_used_total ");
      expect(result.stdout).toContain("# TYPE agent_task_duration_ms histogram");
      expect(result.stdout).toContain("resourceMetrics");
      expect(result.stdout).toContain("resourceLogs");
      expect(result.stdout).toContain("severityNumber");
    },
    20_000,
  );

  test("unknown commands exit non-zero with guidance", async () => {
    const result = await runCli(["frobnicate"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("unknown command: frobnicate");
    expect(result.stderr).toContain("agent-obs serve");
  });

  test("push without --endpoint fails with a usage hint", async () => {
    const result = await runCli(["push"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--endpoint");
  });

  test(
    "push delivers metrics and logs to a real OTLP-shaped endpoint",
    async () => {
      const received: Array<{ path: string; body: Record<string, unknown> }> = [];
      const collector = createServer((request, response) => {
        let raw = "";
        request.on("data", (chunk) => (raw += String(chunk)));
        request.on("end", () => {
          received.push({ path: request.url ?? "", body: JSON.parse(raw || "{}") });
          response.writeHead(200, { "content-type": "application/json" });
          response.end("{}");
        });
      });
      await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
      const address = collector.address();
      const port = address && typeof address === "object" ? address.port : 0;

      const result = await runCli(["push", "--endpoint", `http://127.0.0.1:${port}`]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("[agent-obs] pushed snapshot");

      const paths = received.map((entry) => entry.path);
      expect(paths).toContain("/v1/metrics");
      expect(paths).toContain("/v1/logs");
      const metricsBody = received.find((entry) => entry.path === "/v1/metrics")?.body;
      expect(Array.isArray(metricsBody?.["resourceMetrics"])).toBe(true);
      const logsBody = received.find((entry) => entry.path === "/v1/logs")?.body;
      expect(Array.isArray(logsBody?.["resourceLogs"])).toBe(true);

      collector.close();
    },
    20_000,
  );

  test(
    "serve starts an HTTP server with live metrics and exits cleanly on SIGINT",
    async () => {
      const child = spawn("node", [CLI, "serve", "--port", "0", "--interval", "60000"]);
      let out = "";
      await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("serve never printed its address")), 15_000);
        child.stdout?.on("data", (chunk) => {
          out += String(chunk);
          if (out.includes("/metrics")) {
            clearTimeout(timer);
            resolve(out);
          }
        });
      });
      const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      expect(match).toBeTruthy();
      const base = `http://127.0.0.1:${match?.[1]}`;

      const metrics = await (await fetch(`${base}/metrics`)).text();
      expect(metrics).toContain("agent_tasks_completed_total");
      expect(metrics).toContain("# TYPE agent_task_duration_ms histogram");

      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);

      child.kill("SIGINT");
      const closed = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve(-1);
        }, 5_000);
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      expect(closed).toBe(0);
    },
    25_000,
  );

  test("help lists every command", async () => {
    const result = await runCli(["help"]);
    expect(result.code).toBe(0);
    for (const command of ["serve", "push", "demo", "help"]) {
      expect(result.stdout).toContain(command);
    }
  });
});
