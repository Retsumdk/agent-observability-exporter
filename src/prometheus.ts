/**
 * Prometheus text exposition format (version 0.0.4) renderer.
 *
 * Follows the wire rules Prometheus scrapers expect:
 * - counters expose `name_total` samples with `# TYPE name counter`
 * - histograms expose `_bucket{le="..."}` per bound, a `+Inf` bucket, `_sum`, `_count`
 * - label values escape backslash, double quote and newline; HELP escapes backslash and newline
 * - non-finite values render as `NaN`, `+Inf`, `-Inf`
 */

import { serializeLabels, validateMetricName } from "./metrics.js";
import type { LabelSet, MetricFamily, RegistrySnapshot } from "./types.js";

export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export function escapeHelp(help: string): string {
  return help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function renderValue(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  return String(value);
}

function renderLabels(labels: LabelSet): string {
  const serialized = serializeLabels(labels);
  if (serialized === "") return "";
  const pairs = serialized.split(",").map((pair) => {
    const eq = pair.indexOf("=");
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    return `${key}="${escapeLabelValue(value)}"`;
  });
  return `{${pairs.join(",")}}`;
}

/** Renders a label set with the synthetic `le` bucket label merged in. */
function renderLabelsWithLe(labels: LabelSet, le: string): string {
  return renderLabels({ ...labels, le });
}

function baseName(name: string): string {
  return name.endsWith("_total") ? name.slice(0, -"_total".length) : name;
}

function formatBound(bound: number): string {
  if (bound === Number.POSITIVE_INFINITY) return "+Inf";
  return String(bound);
}

/**
 * Renders a snapshot as a Prometheus text-exposition document.
 * Families appear in registry order; samples are sorted by serialized labels.
 */
export function renderPrometheus(snapshot: RegistrySnapshot): string {
  const lines: string[] = [];
  for (const family of snapshot.metrics) {
    emitFamily(lines, family);
  }
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

function emitFamily(lines: string[], family: MetricFamily): void {
  validateMetricName(family.name);
  if (family.kind === "histogram") {
    emitHistogram(lines, family);
    return;
  }
  const base = family.kind === "counter" ? baseName(family.name) : family.name;
  const sampleName = family.kind === "counter" ? `${base}_total` : family.name;
  if (family.help !== undefined) {
    lines.push(`# HELP ${base} ${escapeHelp(family.help)}`);
  }
  lines.push(`# TYPE ${base} ${family.kind}`);
  for (const sample of sortedSamples(family)) {
    lines.push(`${sampleName}${renderLabels(sample.labels)} ${renderValue(sample.value)}`);
  }
}

function emitHistogram(lines: string[], family: MetricFamily): void {
  if (family.help !== undefined) {
    lines.push(`# HELP ${family.name} ${escapeHelp(family.help)}`);
  }
  lines.push(`# TYPE ${family.name} histogram`);
  for (const histogram of sortedHistograms(family)) {
    histogram.bounds.forEach((bound, i) => {
      lines.push(
        `${family.name}_bucket${renderLabelsWithLe(histogram.labels, formatBound(bound))} ${renderValue(histogram.counts[i] ?? 0)}`,
      );
    });
    lines.push(
      `${family.name}_bucket${renderLabelsWithLe(histogram.labels, "+Inf")} ${renderValue(
        histogram.counts[histogram.counts.length - 1] ?? histogram.count,
      )}`,
    );
    lines.push(`${family.name}_sum${renderLabels(histogram.labels)} ${renderValue(histogram.sum)}`);
    lines.push(`${family.name}_count${renderLabels(histogram.labels)} ${renderValue(histogram.count)}`);
  }
}

function sortedSamples(family: MetricFamily) {
  return [...(family.samples ?? [])].sort((a, b) =>
    serializeLabels(a.labels).localeCompare(serializeLabels(b.labels)),
  );
}

function sortedHistograms(family: MetricFamily) {
  return [...(family.histograms ?? [])].sort((a, b) =>
    serializeLabels(a.labels).localeCompare(serializeLabels(b.labels)),
  );
}
