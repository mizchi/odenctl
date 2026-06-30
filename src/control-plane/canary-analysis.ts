export interface CanaryMetricEvent {
  deploymentId?: string;
  status: number;
  durationMs: number;
  errorCode?: string;
}

export interface CanaryAnalysisThresholds {
  minRequests?: number;
  p95Ms?: number;
  errorRate?: number;
  rejectCount?: number;
}

export interface CanaryAnalysisMetrics {
  requests: number;
  errors: number;
  rejects: number;
  errorRate: number;
  p95Ms: number;
}

export type CanaryAnalysisAction = "continue" | "rollback";
export type CanaryAnalysisReason =
  | "within_thresholds"
  | "insufficient_samples"
  | "p95_latency"
  | "error_rate"
  | "reject_count";

export interface CanaryAnalysisResult {
  action: CanaryAnalysisAction;
  reason: CanaryAnalysisReason;
  metrics: CanaryAnalysisMetrics;
}

export function analyzeCanaryEvents(
  events: CanaryMetricEvent[],
  candidateDeploymentId: string,
  thresholds: CanaryAnalysisThresholds,
): CanaryAnalysisResult {
  const candidateEvents = events.filter((event) => event.deploymentId === candidateDeploymentId);
  const metrics = summarizeCanaryMetrics(candidateEvents);
  const minRequests = thresholds.minRequests ?? 1;
  if (metrics.requests < minRequests) {
    return { action: "continue", reason: "insufficient_samples", metrics };
  }
  if (thresholds.rejectCount !== undefined && metrics.rejects > thresholds.rejectCount) {
    return { action: "rollback", reason: "reject_count", metrics };
  }
  if (thresholds.errorRate !== undefined && metrics.errorRate > thresholds.errorRate) {
    return { action: "rollback", reason: "error_rate", metrics };
  }
  if (thresholds.p95Ms !== undefined && metrics.p95Ms > thresholds.p95Ms) {
    return { action: "rollback", reason: "p95_latency", metrics };
  }
  return { action: "continue", reason: "within_thresholds", metrics };
}

export function summarizeCanaryMetrics(events: CanaryMetricEvent[]): CanaryAnalysisMetrics {
  const durations = events.map((event) => Math.max(0, event.durationMs)).sort((left, right) => left - right);
  const errors = events.filter(isErrorEvent).length;
  const rejects = events.filter(isRejectedEvent).length;
  const requests = events.length;
  return {
    requests,
    errors,
    rejects,
    errorRate: requests === 0 ? 0 : errors / requests,
    p95Ms: percentile(durations, 95),
  };
}

function isErrorEvent(event: CanaryMetricEvent): boolean {
  return event.status >= 500 || Boolean(event.errorCode);
}

function isRejectedEvent(event: CanaryMetricEvent): boolean {
  return event.status === 429 || event.status === 503
    || event.errorCode === "overloaded"
    || event.errorCode === "rate_limited";
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) {
    return 0;
  }
  const index = Math.ceil((percentileValue / 100) * values.length) - 1;
  return values[Math.max(0, Math.min(values.length - 1, index))];
}
