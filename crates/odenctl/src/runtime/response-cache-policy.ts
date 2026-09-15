import { createHash } from "node:crypto";
import { validateHeaderName, validateHeaderValue } from "node:http";
import { RuntimeError } from "./errors.ts";
import type { InvokeComponentResponse, RuntimeHeader } from "./types.ts";

export interface ResponseCacheRule {
  projectId: string;
  host: string;
  pathPrefix: string;
  maxTtlSeconds: number;
  varyHeaders: string[];
}

export interface ResponseCacheConfig {
  maxBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxPending: number;
  rules: ResponseCacheRule[];
}

export interface ResponseCacheRequest {
  projectId?: string;
  deploymentId: string;
  componentIdentity: string;
  method: string;
  uri: string;
  headers: RuntimeHeader[];
  bodyBytes: number;
}

export interface ResponseCacheScope {
  projectId?: string;
  deploymentId?: string;
}

const bypassHeaders = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "range",
  "if-range",
  "if-match",
  "if-none-match",
  "if-modified-since",
  "if-unmodified-since",
  "cache-control",
  "pragma",
  "upgrade",
  "transfer-encoding",
]);
const hopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function invalid(message: string): never {
  throw new RuntimeError("validation", `response cache: ${message}`);
}

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("expected an object");
  }
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key))) {
    invalid("unknown property");
  }
  return result;
}

function integer(value: unknown, name: string, maximum: number): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 ||
    value > maximum
  ) {
    invalid(`${name} must be a positive integer <= ${maximum}`);
  }
  return value;
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(value)) {
    invalid(`invalid ${name}`);
  }
  return value;
}

export function parseResponseCacheConfig(input: unknown): ResponseCacheConfig {
  const value = record(input, [
    "maxBytes",
    "maxEntries",
    "maxEntryBytes",
    "maxPending",
    "rules",
  ]);
  const maxBytes = integer(value.maxBytes, "maxBytes", 1024 * 1024 * 1024);
  const maxEntryBytes = integer(value.maxEntryBytes, "maxEntryBytes", maxBytes);
  const maxEntries = integer(value.maxEntries, "maxEntries", 1_000_000);
  const maxPending = integer(value.maxPending, "maxPending", 4096);
  if (!Array.isArray(value.rules) || value.rules.length > 10_000) {
    invalid("rules must be an array of at most 10000 rules");
  }
  const seen = new Set<string>();
  const rules = value.rules.map((input): ResponseCacheRule => {
    const rule = record(input, [
      "projectId",
      "host",
      "pathPrefix",
      "maxTtlSeconds",
      "varyHeaders",
    ]);
    const projectId = identifier(rule.projectId, "projectId");
    if (typeof rule.host !== "string" || rule.host.length > 253) {
      invalid("invalid host");
    }
    let host: URL;
    try {
      host = new URL(`http://${rule.host}`);
    } catch {
      invalid("invalid host");
    }
    if (
      host.host !== rule.host || host.pathname !== "/" || host.username ||
      host.password || host.search || host.hash
    ) invalid("host must be a canonical lowercase authority without a scheme");
    if (
      typeof rule.pathPrefix !== "string" || !rule.pathPrefix.startsWith("/") ||
      /[?#\s]/.test(rule.pathPrefix) || rule.pathPrefix.length > 2048 ||
      (rule.pathPrefix.length > 1 && rule.pathPrefix.endsWith("/"))
    ) invalid("invalid pathPrefix; omit a trailing slash");
    const maxTtlSeconds = integer(
      rule.maxTtlSeconds,
      "maxTtlSeconds",
      31_536_000,
    );
    if (!Array.isArray(rule.varyHeaders) || rule.varyHeaders.length > 32) {
      invalid("varyHeaders must be an array of at most 32 names");
    }
    const varyHeaders = rule.varyHeaders.map((name): string => {
      if (
        typeof name !== "string" || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) ||
        name.length > 100 ||
        bypassHeaders.has(name) || hopHeaders.has(name) ||
        name.startsWith("x-oden-")
      ) invalid("invalid vary header");
      return name;
    });
    if (new Set(varyHeaders).size !== varyHeaders.length) {
      invalid("duplicate vary header");
    }
    const identity = JSON.stringify([projectId, rule.host, rule.pathPrefix]);
    if (seen.has(identity)) invalid("duplicate rule");
    seen.add(identity);
    return {
      projectId,
      host: rule.host,
      pathPrefix: rule.pathPrefix,
      maxTtlSeconds,
      varyHeaders,
    };
  });
  return { maxBytes, maxEntries, maxEntryBytes, maxPending, rules };
}

export function parseResponseCacheScope(input: unknown): ResponseCacheScope {
  const value = record(input, ["projectId", "deploymentId"]);
  return {
    ...(value.projectId === undefined
      ? {}
      : { projectId: identifier(value.projectId, "projectId") }),
    ...(value.deploymentId === undefined
      ? {}
      : { deploymentId: identifier(value.deploymentId, "deploymentId") }),
  };
}

function headerValues(headers: RuntimeHeader[], name: string): string[] {
  return headers.filter((h) => h.name.toLowerCase() === name).map((h) =>
    h.value
  );
}

export function matchResponseCacheRequest(
  config: ResponseCacheConfig,
  input: ResponseCacheRequest,
) {
  if (
    !input.projectId || !["GET", "HEAD"].includes(input.method) ||
    input.bodyBytes !== 0
  ) return;
  if (input.headers.some((h) => bypassHeaders.has(h.name.toLowerCase()))) {
    return;
  }
  const lengths = headerValues(input.headers, "content-length");
  if (
    lengths.length > 1 || (lengths.length === 1 && !/^0+$/.test(lengths[0]))
  ) return;
  let url: URL;
  try {
    url = new URL(input.uri);
  } catch {
    return;
  }
  if (
    !["http:", "https:"].includes(url.protocol) || url.username ||
    url.password || url.hash
  ) return;
  const rule =
    config.rules.filter((r) =>
      r.projectId === input.projectId && r.host === url.host &&
      (r.pathPrefix === "/" || url.pathname === r.pathPrefix ||
        url.pathname.startsWith(r.pathPrefix + "/"))
    )
      .sort((a, b) => b.pathPrefix.length - a.pathPrefix.length)[0];
  if (!rule) return;
  // Keep query ordering and header value ordering. Never accept scope from guest headers.
  const key = createHash("sha256").update(JSON.stringify([
    input.projectId,
    input.deploymentId,
    input.componentIdentity,
    input.uri,
    rule,
    rule.varyHeaders.map((name) => headerValues(input.headers, name)),
    ["host", "x-forwarded-host", "x-forwarded-proto", "forwarded"].map((name) =>
      headerValues(input.headers, name)
    ),
  ])).digest("hex");
  return { key, rule };
}

function seconds(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return;
  const result = Number(value);
  return Number.isSafeInteger(result) &&
      result <= Number.MAX_SAFE_INTEGER / 1000
    ? result
    : undefined;
}

export function prepareResponseCacheEntry(
  response: InvokeComponentResponse,
  rule: ResponseCacheRule,
  requestTime: number,
  responseTime: number,
) {
  if (response.status !== 200) return;
  try {
    for (const h of response.headers) {
      validateHeaderName(h.name);
      validateHeaderValue(h.name, h.value);
    }
  } catch {
    return;
  }
  const headers = response.headers.map((h) => ({
    name: h.name.toLowerCase(),
    value: h.value,
  }));
  if (
    headers.some((h) =>
      ["set-cookie", "content-range", "connection", "trailer"].includes(h.name)
    )
  ) return;
  const directives = new Map<string, string | undefined>();
  for (
    const part of headerValues(headers, "cache-control").join(",").split(",")
  ) {
    const match = /^\s*([a-z-]+)(?:\s*=\s*(\d+|"\d+"))?\s*$/i.exec(part);
    if (!match) return;
    const name = match[1].toLowerCase();
    if (directives.has(name)) return;
    directives.set(name, match[2]?.replaceAll('"', ""));
  }
  if (
    [
      "no-store",
      "private",
      "no-cache",
      "stale-while-revalidate",
      "stale-if-error",
    ].some((d) => directives.has(d))
  ) return;
  if (
    directives.get("public") !== undefined ||
    ["max-age", "s-maxage"].some((name) =>
      directives.has(name) &&
      (directives.get(name) === undefined ||
        seconds(directives.get(name)!) === undefined)
    )
  ) return;
  const ttlValue = directives.get(
    directives.has("s-maxage") ? "s-maxage" : "max-age",
  );
  const ttl = ttlValue === undefined ? undefined : seconds(ttlValue);
  if (!ttl || (!directives.has("s-maxage") && !directives.has("public"))) {
    return;
  }
  const vary = headerValues(headers, "vary").join(",");
  if (
    vary &&
    vary.split(",").some((name) =>
      !rule.varyHeaders.includes(name.trim().toLowerCase())
    )
  ) return;
  const lengths = headerValues(headers, "content-length");
  if (
    lengths.length > 1 ||
    (lengths.length && seconds(lengths[0]) !== response.body.byteLength)
  ) return;
  const dates = headerValues(headers, "date");
  const ages = headerValues(headers, "age");
  if (dates.length > 1 || ages.length > 1) return;
  const date = dates.length ? Date.parse(dates[0]) : responseTime;
  const age = ages.length ? seconds(ages[0]) : 0;
  if (!Number.isFinite(date) || age === undefined) return;
  const initialAgeMs = Math.max(
    0,
    responseTime - date,
    age * 1000 + Math.max(0, responseTime - requestTime),
  );
  const lifetimeMs = Math.min(ttl, rule.maxTtlSeconds) * 1000;
  if (initialAgeMs >= lifetimeMs) return;
  const savedHeaders = headers.filter((h) =>
    !hopHeaders.has(h.name) && !h.name.startsWith("x-oden-") &&
    ![
      "age",
      "date",
      "content-length",
      "traceparent",
      "tracestate",
      "server-timing",
    ].includes(h.name)
  );
  savedHeaders.push({ name: "date", value: new Date(date).toUTCString() }, {
    name: "content-length",
    value: String(response.body.byteLength),
  });
  return {
    response: {
      status: 200,
      headers: savedHeaders,
      body: Uint8Array.from(response.body),
    },
    initialAgeMs,
    expiresAt: responseTime + lifetimeMs - initialAgeMs,
    storedAt: responseTime,
  };
}
