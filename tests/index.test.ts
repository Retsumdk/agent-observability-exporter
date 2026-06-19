import { describe, test, expect } from "bun:test";
describe("agent-observability-exporter", () => {
  test("module loads", async () => { const m = await import("./index"); expect(m).toBeDefined(); });
});
