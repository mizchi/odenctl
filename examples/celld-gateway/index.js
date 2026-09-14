// Application gateway for oden: the fleet's internal listener is not used.
const BODY_LIMIT = 1024 * 1024;
const ENVELOPE_LIMIT = 2 * BODY_LIMIT;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const RESERVED_HEADERS = new Set([
  "host", "content-length", "connection", "transfer-encoding", "upgrade",
  "proxy-authorization", "proxy-authenticate", "keep-alive", "te", "trailer",
  "x-oden-request-id",
]);

class InvalidRequest extends Error {}
class BodyTooLarge extends Error {}

async function readLimited(body, limit) {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new BodyTooLarge();
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

function encode(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

function decode(text) {
  if (typeof text !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) {
    throw new InvalidRequest();
  }
  const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  if (bytes.length > BODY_LIMIT) throw new BodyTooLarge();
  return bytes;
}

async function authorized(actual, expected) {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([actual, expected].map(async (text) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)))));
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

function objectRequest(input) {
  if (!input || !METHODS.has(input.method) || typeof input.path !== "string"
    || !input.path.startsWith("/") || input.path.startsWith("//")
    || /[\\\r\n#]/.test(input.path) || !Array.isArray(input.headers)) throw new InvalidRequest();
  const headers = new Headers();
  for (const entry of input.headers) {
    if (!Array.isArray(entry) || entry.length !== 2 || entry.some((v) => typeof v !== "string")
      || RESERVED_HEADERS.has(entry[0].toLowerCase())) throw new InvalidRequest();
    try { headers.append(entry[0], entry[1]); } catch { throw new InvalidRequest(); }
  }
  if (input.requestId !== undefined) {
    if (typeof input.requestId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.requestId)) throw new InvalidRequest();
    headers.set("x-oden-request-id", input.requestId);
  }
  const bytes = decode(input.body);
  if ((input.method === "GET" || input.method === "HEAD") && bytes.length) throw new InvalidRequest();
  return new Request(`https://object.invalid${input.path}`, {
    method: input.method, headers,
    ...(input.method === "GET" || input.method === "HEAD" ? {} : { body: bytes }),
  });
}

export default {
  async fetch(request, env) {
    if (!env.ODEN_GATEWAY_TOKEN) return new Response("gateway not configured", { status: 503 });
    if (!await authorized(request.headers.get("authorization") ?? "", `Bearer ${env.ODEN_GATEWAY_TOKEN}`)) {
      return new Response("unauthorized", { status: 401 });
    }
    const match = /^\/v1\/objects\/([A-Z][A-Z0-9_]{0,63})\/([^/]+)\/fetch$/.exec(new URL(request.url).pathname);
    if (request.method !== "POST" || !match) return new Response("not found", { status: 404 });
    const allowed = new Set((env.ODEN_BINDINGS ?? "").split(","));
    if (!allowed.has(match[1])) return new Response("binding denied", { status: 404 });
    try {
      let name;
      let input;
      try {
        name = decodeURIComponent(match[2]);
        input = JSON.parse(new TextDecoder().decode(await readLimited(request.body, ENVELOPE_LIMIT)));
      } catch (error) {
        if (error instanceof BodyTooLarge) throw error;
        throw new InvalidRequest();
      }
      if (!name || new TextEncoder().encode(name).length > 512 || /[\x00-\x1f\x7f]/.test(name)) throw new InvalidRequest();
      const forwarded = objectRequest(input);
      const namespace = env[match[1]];
      if (!namespace) return new Response("binding unavailable", { status: 503 });
      const response = await namespace.get(namespace.idFromName(name)).fetch(forwarded);
      const body = await readLimited(response.body, BODY_LIMIT);
      return Response.json({
        status: response.status,
        headers: [...response.headers].filter(([name]) => !RESERVED_HEADERS.has(name.toLowerCase())),
        body: encode(body),
      });
    } catch (error) {
      if (error instanceof BodyTooLarge) return new Response("body limit exceeded", { status: 413 });
      if (error instanceof InvalidRequest) return new Response("invalid request", { status: 400 });
      // The object may have committed before it failed or its response was lost.
      return new Response("object outcome unknown", { status: 502 });
    }
  },
};

// Example actor. Request IDs and results share a transaction with the counter.
export class Counter {
  constructor(state) { this.storage = state.storage; }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/") {
      return Response.json({ n: (await this.storage.get("n")) ?? 0 });
    }
    if (request.method !== "POST" || path !== "/increment") return new Response("not found", { status: 404 });
    const id = request.headers.get("x-oden-request-id");
    const result = await this.storage.transaction(async (tx) => {
      if (id) {
        const previous = await tx.get(`request:${id}`);
        if (previous !== undefined) return previous;
      }
      const result = { n: ((await tx.get("n")) ?? 0) + 1 };
      await tx.put("n", result.n);
      if (id) await tx.put(`request:${id}`, result);
      return result;
    });
    return Response.json(result);
  }
}
