/**
 * Structured logger for AI agents.
 *
 * Records are stored in a bounded in-memory buffer that the exporter drains
 * and ships as OTLP logs. `mirror` optionally echoes each record to the console
 * as a single-line JSON object so local runs stay inspectable; `onRecord` gives
 * push-based consumers (the CLI wires it to the exporter) each record as it is
 * emitted; a `sink` receives flushed batches for file/JSONL logging.
 */

import type { LogRecord, LogLevel } from "./types.js";

/** Renders one record as a single-line JSON object (for JSONL sinks). */
export function formatJsonLine(record: LogRecord): string {
  return JSON.stringify(record);
}

export interface LoggerOptions {
  /** Maximum buffered records before the oldest is dropped. Default 2048. */
  capacity?: number;
  /** Echo each record to stdout as one-line JSON. */
  mirror?: boolean;
  /** Clock override (epoch ms; tests). */
  now?: () => number;
  /** Batch receiver for `flushToSink()` (file writers, JSONL sinks). */
  sink?: (records: LogRecord[]) => void;
  /** Static attributes merged into every record emitted by this logger. */
  bindings?: Record<string, string | number | boolean>;
  /** Shared-buffer parent (internal — use `child()`). */
  parent?: AgentLogger;
}

export class AgentLogger {
  /** Invoked with each emitted record (single-element array). */
  onRecord?: (records: LogRecord[]) => void;
  private readonly buffer: LogRecord[];
  private readonly capacity: number;
  private readonly mirrorFn?: (record: LogRecord) => void;
  private readonly now: () => number;
  private readonly sink: ((records: LogRecord[]) => void) | undefined;
  private readonly bindings: Record<string, string | number | boolean>;
  private readonly parent: AgentLogger | undefined;
  private dropped = 0;

  constructor(options: LoggerOptions = {}) {
    if (options.parent) {
      // Children delegate storage to the root logger so `drain()` anywhere
      // returns the full stream; they only add their bindings.
      this.buffer = options.parent.buffer;
      this.capacity = options.parent.capacity;
      this.now = options.parent.now;
      if (options.parent.mirrorFn !== undefined) this.mirrorFn = options.parent.mirrorFn;
      if (options.parent.sink !== undefined) this.sink = options.parent.sink;
      this.parent = options.parent;
      this.dropped = 0;
      this.bindings = { ...options.parent.bindings, ...(options.bindings ?? {}) };
    } else {
      this.buffer = [];
      this.capacity = options.capacity ?? 2048;
      this.now = options.now ?? Date.now;
      if (options.mirror) {
        this.mirrorFn = (record) => {
          console.log(formatJsonLine(record));
        };
      }
      this.sink = options.sink;
      this.bindings = { ...(options.bindings ?? {}) };
    }
  }

  /** Returns a logger that merges `bindings` into every record it emits. */
  child(bindings: Record<string, string | number | boolean>): AgentLogger {
    return new AgentLogger({ parent: this.parent ?? this, bindings });
  }

  debug(message: string, attributes?: Record<string, string | number | boolean>): LogRecord {
    return this.emit("DEBUG", message, attributes);
  }

  info(message: string, attributes?: Record<string, string | number | boolean>): LogRecord {
    return this.emit("INFO", message, attributes);
  }

  warn(message: string, attributes?: Record<string, string | number | boolean>): LogRecord {
    return this.emit("WARN", message, attributes);
  }

  error(message: string, attributes?: Record<string, string | number | boolean>): LogRecord {
    return this.emit("ERROR", message, attributes);
  }

  /** Hands the current buffer to the sink (when configured) and clears it. */
  flushToSink(): LogRecord[] {
    const drained = this.buffer.splice(0, this.buffer.length);
    this.sink?.(drained);
    return drained;
  }

  /** Removes and returns all buffered records. Called by the exporter after a successful push. */
  drain(): LogRecord[] {
    return this.buffer.splice(0, this.buffer.length);
  }

  /** Number of records dropped when the buffer overflowed. */
  get droppedCount(): number {
    return this.dropped;
  }

  get size(): number {
    return this.buffer.length;
  }

  private emit(
    level: LogLevel,
    message: string,
    attributes?: Record<string, string | number | boolean>,
  ): LogRecord {
    const record: LogRecord = {
      time: this.now(),
      level,
      message,
      ...(Object.keys(this.bindings).length > 0 || attributes
        ? { attributes: { ...this.bindings, ...attributes } }
        : {}),
    };
    if (this.buffer.length >= this.capacity) {
      this.buffer.shift();
      this.dropped += 1;
    }
    this.buffer.push(record);
    this.mirrorFn?.(record);
    this.onRecord?.([record]);
    return record;
  }
}
