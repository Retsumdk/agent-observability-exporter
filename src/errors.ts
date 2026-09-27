/**
 * Error types for agent-observability-exporter.
 *
 * Every error carries a stable `code` so callers can branch on failure class
 * without matching on message text.
 */

export type ExporterErrorCode =
  | "CONFIG_ERROR"
  | "VALIDATION_ERROR"
  | "NETWORK_ERROR"
  | "TIMEOUT_ERROR";

export class ExporterError extends Error {
  readonly code: ExporterErrorCode;

  constructor(code: ExporterErrorCode, message: string) {
    super(message);
    this.name = "ExporterError";
    this.code = code;
  }
}

/** Thrown when a metric name, label, value, or configuration is invalid. */
export class ValidationError extends ExporterError {
  constructor(message: string) {
    super("VALIDATION_ERROR", message);
    this.name = "ValidationError";
  }
}

export function configError(message: string): ExporterError {
  return new ExporterError("CONFIG_ERROR", message);
}

export function validationError(message: string): ExporterError {
  return new ValidationError(message);
}

export function networkError(message: string): ExporterError {
  return new ExporterError("NETWORK_ERROR", message);
}

export function timeoutError(message: string): ExporterError {
  return new ExporterError("TIMEOUT_ERROR", message);
}
