import { randomBytes } from "node:crypto";

export interface RuntimeTelemetry {
  recordWorkerRequest(input: RuntimeTelemetryWorkerRequest): Promise<void>;
}

export interface RuntimeTelemetryWorkerRequest {
  requestId: string;
  method: string;
  host: string;
  path: string;
  projectId?: string;
  deploymentId?: string;
  status: number;
  durationMs: number;
  errorCode?: string;
  traceparent?: string;
}

export interface OtlpHttpTraceExporterOptions {
  endpoint: string;
  serviceName: string;
  serviceInstanceId?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  nowMs?: () => number;
  idGenerator?: (bytes: number) => string;
}

export function createOtlpHttpTraceExporter(options: OtlpHttpTraceExporterOptions): RuntimeTelemetry {
  const fetchImpl = options.fetch ?? fetch;
  const nowMs = options.nowMs ?? (() => Date.now());
  const idGenerator = options.idGenerator ?? randomHex;
  return {
    async recordWorkerRequest(input) {
      const endMs = nowMs();
      const durationMs = Math.max(0, input.durationMs);
      const startMs = Math.max(0, endMs - durationMs);
      const parent = parseTraceparent(input.traceparent);
      const payload = buildOtlpTracePayload({
        ...input,
        traceId: parent?.traceId ?? idGenerator(16),
        parentSpanId: parent?.spanId,
        spanId: idGenerator(8),
        startTimeUnixNano: msToUnixNanoString(startMs),
        endTimeUnixNano: msToUnixNanoString(endMs),
        serviceName: options.serviceName,
        serviceInstanceId: options.serviceInstanceId,
      });
      const response = await fetchImpl(traceEndpoint(options.endpoint), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.headers ?? {}),
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(`OTLP trace export failed with ${response.status}: ${await response.text()}`);
      }
    },
  };
}

export function parseOtlpHeaders(value: string | undefined): Record<string, string> {
  if (!value) {
    return {};
  }
  const headers: Record<string, string> = {};
  for (const item of value.split(",")) {
    const separator = item.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = item.slice(0, separator).trim();
    const headerValue = item.slice(separator + 1).trim();
    if (key) {
      headers[key] = headerValue;
    }
  }
  return headers;
}

interface BuildOtlpTracePayloadInput extends RuntimeTelemetryWorkerRequest {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  serviceName: string;
  serviceInstanceId?: string;
}

function buildOtlpTracePayload(input: BuildOtlpTracePayloadInput) {
  const resourceAttributes = [
    stringAttribute("service.name", input.serviceName),
    ...(input.serviceInstanceId ? [stringAttribute("service.instance.id", input.serviceInstanceId)] : []),
  ];
  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes },
        scopeSpans: [
          {
            scope: { name: "wasmplane-runtime" },
            spans: [
              stripUndefined({
                traceId: input.traceId,
                spanId: input.spanId,
                parentSpanId: input.parentSpanId,
                name: `${input.method} ${input.path}`,
                kind: 2,
                startTimeUnixNano: input.startTimeUnixNano,
                endTimeUnixNano: input.endTimeUnixNano,
                attributes: [
                  stringAttribute("http.request.method", input.method),
                  stringAttribute("server.address", input.host),
                  stringAttribute("url.path", input.path),
                  intAttribute("http.response.status_code", input.status),
                  stringAttribute("wasmplane.request_id", input.requestId),
                  ...(input.projectId ? [stringAttribute("wasmplane.project_id", input.projectId)] : []),
                  ...(input.deploymentId ? [stringAttribute("wasmplane.deployment_id", input.deploymentId)] : []),
                  ...(input.errorCode ? [stringAttribute("wasmplane.error_code", input.errorCode)] : []),
                ],
                status: {
                  code: input.status >= 500 || input.errorCode ? 2 : 1,
                },
              }),
            ],
          },
        ],
      },
    ],
  };
}

function parseTraceparent(value: string | undefined): { traceId: string; spanId: string } | undefined {
  if (!value) {
    return undefined;
  }
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i.exec(value.trim());
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) {
    return undefined;
  }
  return { traceId: match[1].toLowerCase(), spanId: match[2].toLowerCase() };
}

function traceEndpoint(endpoint: string): string {
  const normalized = endpoint.replace(/\/+$/, "");
  return normalized.endsWith("/v1/traces") ? normalized : `${normalized}/v1/traces`;
}

function stringAttribute(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

function intAttribute(key: string, value: number) {
  return { key, value: { intValue: String(value) } };
}

function msToUnixNanoString(ms: number): string {
  return String(BigInt(Math.trunc(ms)) * 1_000_000n);
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function stripUndefined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}
