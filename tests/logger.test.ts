import { describe, test, expect } from "bun:test";
import { AgentLogger, formatJsonLine } from "../src/logger.js";
import type { LogRecord } from "../src/types.js";

describe("AgentLogger", () => {
  test("levels map onto records and drain() empties the buffer", () => {
    const logger = new AgentLogger();
    logger.debug("d");
    logger.info("i", { a: 1 });
    logger.warn("w");
    logger.error("e", { code: "X" });
    const records = logger.drain();
    expect(records.map((record) => record.level)).toEqual(["DEBUG", "INFO", "WARN", "ERROR"]);
    expect(records[1]?.attributes?.["a"]).toBe(1);
    expect(records[3]?.attributes?.["code"]).toBe("X");
    expect(logger.drain()).toHaveLength(0);
  });

  test("records carry increasing timestamps from the injected clock", () => {
    let tick = 1000;
    const timed = new AgentLogger({ now: () => (tick += 5) });
    timed.info("one");
    timed.info("two");
    const [first, second] = timed.drain();
    expect((second?.time ?? 0) - (first?.time ?? 0)).toBe(5);
    expect(tick).toBeGreaterThan(1000);
  });

  test("buffers more records than the capacity without losing the newest", () => {
    const logger = new AgentLogger({ capacity: 10 });
    for (let i = 0; i < 25; i++) logger.info(`m${i}`);
    const drained = logger.drain();
    expect(drained).toHaveLength(10);
    expect(drained[0]?.message).toBe("m15");
    expect(logger.droppedCount).toBe(15);
    expect(logger.size).toBe(0);
  });

  test("child loggers inherit bindings into every record", () => {
    const logger = new AgentLogger();
    const child = logger.child({ task: "summarize" });
    child.info("started", { attempt: 1 });
    const [record] = logger.drain();
    expect(record?.attributes?.["task"]).toBe("summarize");
    expect(record?.attributes?.["attempt"]).toBe(1);
  });

  test("onRecord observes records as they are emitted", () => {
    const logger = new AgentLogger();
    const seen: string[] = [];
    logger.onRecord = (records) => {
      for (const record of records) seen.push(record.message);
    };
    logger.info("a");
    logger.warn("b");
    expect(seen).toEqual(["a", "b"]);
    expect(logger.drain()).toHaveLength(2);
  });

  test("console mirroring is opt-in and off by default", () => {
    const logger = new AgentLogger();
    const log = console.log;
    let mirrored = 0;
    console.log = () => {
      mirrored += 1;
    };
    try {
      logger.error("quiet");
    } finally {
      console.log = log;
    }
    expect(mirrored).toBe(0);
    expect(logger.drain()).toHaveLength(1);
  });

  test("formatJsonLine renders one JSON object per record", () => {
    const record: LogRecord = { time: 1700000000000, level: "INFO", message: "hi", attributes: { a: "b" } };
    const line = formatJsonLine(record);
    expect(JSON.parse(line)).toEqual(record);
    expect(line.includes("\n")).toBe(false);
  });
});
