import { describe, test, expect, afterAll } from "bun:test";
import { MetricsRegistry } from "../src/metrics.js";
import { metricsHandler, createMetricsServer } from "../src/server.js";
import type { RegistrySnapshot } from "../src/types.js";

const registry = new MetricsRegistry();
registry.counter("jobs_total", { queue: "default" }, { help: "Jobs" }).inc(9);
registry.gauge("depth", undefined, { help: "Depth" }).set(2);

describe("metricsHandler", () => {
  test("returns the exposition payload with the right content type", () => {
    const response = metricsHandler(registry.snapshot());
    expect(response.status).toBe(200);
    expect(response.contentType).toContain("version=0.0.4");
    expect(response.body).toContain('jobs_total{queue="default"} 9');
  });

  test("internal render failures produce a 500 plain-text body", () => {
    const broken = {
      capturedAt: 0,
      metrics: [
        {
          name: "not a valid name",
          kind: "gauge",
          samples: [{ labels: {}, value: 1 }],
        },
      ],
    } as unknown as RegistrySnapshot;
    const response = metricsHandler(broken);
    expect(response.status).toBe(500);
    expect(response.body).toContain("metrics render failed");
  });
});

describe("createMetricsServer", () => {
  const server = createMetricsServer(() => registry.snapshot());
  server.listen(0, "127.0.0.1");
  afterAll(() => {
    server.close();
  });

  const address = (): string => {
    const addr = server.address();
    if (addr && typeof addr === "object") return `http://127.0.0.1:${addr.port}`;
    throw new Error("server not listening");
  };

  test("GET /metrics returns the Prometheus exposition", async () => {
    const response = await fetch(`${address()}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("version=0.0.4");
    const text = await response.text();
    expect(text).toContain("# TYPE jobs counter");
    expect(text).toContain('jobs_total{queue="default"} 9');
  });

  test("GET /healthz reports ok", async () => {
    const response = await fetch(`${address()}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("ok");
  });

  test("GET /-/ready reports ok", async () => {
    const response = await fetch(`${address()}/-/ready`);
    expect(response.status).toBe(200);
  });

  test("HEAD /metrics works without a body", async () => {
    const response = await fetch(`${address()}/metrics`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  test("POST to /metrics is 405 with an allow header", async () => {
    const response = await fetch(`${address()}/metrics`, { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toContain("GET");
  });

  test("unknown paths are 404", async () => {
    const response = await fetch(`${address()}/nope`);
    expect(response.status).toBe(404);
  });
});
