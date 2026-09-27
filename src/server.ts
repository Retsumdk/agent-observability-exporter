/**
 * Prometheus scrape endpoint.
 *
 * `metricsHandler` is transport-agnostic so it can be mounted in any HTTP
 * server; `createMetricsServer` wraps it in a standalone node:http server for
 * the common "point Prometheus at my agent" case.
 */

import http from "node:http";
import { renderPrometheus, PROMETHEUS_CONTENT_TYPE } from "./prometheus.js";
import type { RegistrySnapshot } from "./types.js";

export const PROMETHEUS_PATH = "/metrics";
export const HEALTHZ_PATH = "/healthz";

export interface MetricsResponse {
  status: number;
  contentType: string;
  body: string;
}

/** Render a snapshot the way a Prometheus scraper expects. */
export function metricsHandler(snapshot: RegistrySnapshot): MetricsResponse {
  let body: string;
  try {
    body = renderPrometheus(snapshot);
  } catch (error) {
    return {
      status: 500,
      contentType: "text/plain; charset=utf-8",
      body: `metrics render failed: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
  return { status: 200, contentType: PROMETHEUS_CONTENT_TYPE, body };
}

export interface MetricsServerOptions {
  port?: number;
  host?: string;
}

export function createMetricsServer(
  snapshot: () => RegistrySnapshot,
  _options: MetricsServerOptions = {},
): http.Server {
  return http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === PROMETHEUS_PATH && (request.method === "GET" || request.method === "HEAD")) {
      const rendered = metricsHandler(snapshot());
      response.writeHead(rendered.status, { "content-type": rendered.contentType });
      response.end(request.method === "HEAD" ? undefined : rendered.body);
      return;
    }
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      (url.pathname === HEALTHZ_PATH || url.pathname === "/-/ready")
    ) {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("ok\n");
      return;
    }
    if (url.pathname === "/metrics") {
      response.writeHead(405, {
        "content-type": "application/json",
        allow: "GET, HEAD",
      });
      response.end(JSON.stringify({ error: "method_not_allowed" }) + "\n");
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }) + "\n");
  });
}
