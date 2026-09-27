import { describe, test, expect } from "bun:test";
import { MetricsRegistry } from "../src/metrics.js";
import { MetricsRegistry as RegistryValue } from "../src/index.js";
import {
  renderPrometheus,
  PROMETHEUS_CONTENT_TYPE,
} from "../src/index.js";
import { toOtlpMetrics, toOtlpLogs, severityNumber } from "../src/index.js";
import { TelemetryExporter } from "../src/index.js";
import { AgentLogger } from "../src/index.js";
import { createMetricsServer, metricsHandler } from "../src/index.js";
import { ExporterError } from "../src/index.js";
import { formatJsonLine } from "../src/index.js";

describe("public API surface", () => {
  test("the package entry point exports the documented names", async () => {
    const mod = await import("../src/index.js");
    for (const name of [
      "MetricsRegistry",
      "DEFAULT_BUCKETS",
      "validateMetricName",
      "serializeLabels",
      "renderPrometheus",
      "PROMETHEUS_CONTENT_TYPE",
      "toOtlpMetrics",
      "toOtlpLogs",
      "severityNumber",
      "TelemetryExporter",
      "AgentLogger",
      "createMetricsServer",
      "metricsHandler",
      "ExporterError",
      "formatJsonLine",
    ]) {
      expect(mod, `missing export: ${name}`).toHaveProperty(name);
    }
  });

  test("values imported from the entry point are usable", () => {
    expect(new RegistryValue()).toBeInstanceOf(MetricsRegistry);
    expect(typeof renderPrometheus).toBe("function");
    expect(typeof toOtlpMetrics).toBe("function");
    expect(typeof toOtlpLogs).toBe("function");
    expect(typeof severityNumber).toBe("function");
    expect(typeof metricsHandler).toBe("function");
    expect(typeof createMetricsServer).toBe("function");
    expect(typeof formatJsonLine).toBe("function");
    expect(PROMETHEUS_CONTENT_TYPE).toContain("version=0.0.4");
    expect(new TelemetryExporter(() => new MetricsRegistry().snapshot(), {
      endpoint: "http://localhost:4318",
    })).toBeInstanceOf(TelemetryExporter);
    expect(new AgentLogger()).toBeInstanceOf(AgentLogger);
    expect(new ExporterError("CONFIG_ERROR", "x")).toBeInstanceOf(Error);
  });
});
