import { createServer } from "node:http";
import type { RouteSnapshot } from "../control-plane/contracts.ts";
import { RuntimeError } from "./errors.ts";
import type {
  CompiledComponent,
  InvokeComponentResponse,
  RouteMatchInput,
  RuntimeHeader,
  RuntimeInvoker,
} from "./types.ts";

export interface RuntimeNodeAppOptions {
  supervisor: RuntimeNodeSupervisor;
  invoker?: RuntimeInvoker;
}

export interface RuntimeNodeSupervisor {
  loadSnapshot(snapshot: RouteSnapshot): void;
  prepareRoute(input: RouteMatchInput): Promise<CompiledComponent>;
}

export function createRuntimeNodeApp(options: RuntimeNodeAppOptions) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://runtime.local");
      const method = request.method ?? "GET";

      if (method === "GET" && url.pathname === "/__runtime/healthz") {
        writeJson(response, 200, { ok: true });
        return;
      }

      if (method === "PUT" && url.pathname === "/__runtime/snapshots/routes") {
        const snapshot = await readJson<RouteSnapshot>(request);
        assertRouteSnapshot(snapshot);
        options.supervisor.loadSnapshot(snapshot);
        writeJson(response, 200, {
          ok: true,
          routes: snapshot.routes.length,
          generatedAt: snapshot.generatedAt,
        });
        return;
      }

      if (url.pathname.startsWith("/__runtime/")) {
        writeJson(response, 404, { error: { code: "not_found", message: "runtime endpoint not found" } });
        return;
      }

      const prepared = await options.supervisor.prepareRoute({
        host: requestHost(request.headers),
        path: url.pathname,
      });

      if (options.invoker) {
        const invocation = await options.invoker.invoke({
          deploymentId: prepared.deploymentId,
          component: prepared,
          method,
          uri: requestUri(request.headers, url),
          headers: requestHeaders(request.headers),
          body: await readBody(request),
        });
        writeInvocationResponse(response, prepared, invocation);
        return;
      }

      response.writeHead(501, {
        "content-type": "application/json; charset=utf-8",
        "x-wasmplane-deployment": prepared.deploymentId,
        "x-wasmplane-precompiled": prepared.precompiledPath,
      });
      response.end(
        JSON.stringify({
          error: {
            code: "invoke_not_implemented",
            message: "WASIp3 component invocation is not wired yet",
          },
          deploymentId: prepared.deploymentId,
          precompiledPath: prepared.precompiledPath,
        }),
      );
    } catch (error) {
      if (error instanceof RuntimeError && error.code === "not_found") {
        writeJson(response, 404, { error: { code: error.code, message: error.message } });
        return;
      }
      if (error instanceof RuntimeError) {
        writeJson(response, 500, { error: { code: error.code, message: error.message } });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      writeJson(response, 500, { error: { code: "internal", message } });
    }
  });

  return {
    listen(options: { port: number; host?: string }) {
      return new Promise<typeof server>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, options.host ?? "127.0.0.1", () => {
          server.off("error", reject);
          resolve(server);
        });
      });
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function readJson<T>(request: any): Promise<T> {
  const body = await readBody(request);
  const text = Buffer.from(body).toString("utf8");
  if (text.trim().length === 0) {
    throw new RuntimeError("validation", "request body must be JSON");
  }
  return JSON.parse(text) as T;
}

async function readBody(request: any): Promise<Buffer> {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function writeJson(response: any, status: number, value: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function requestHost(headers: Record<string, string | string[] | undefined>): string {
  return requiredHeader(firstHeader(headers["x-forwarded-host"]) ?? firstHeader(headers.host));
}

function requestUri(headers: Record<string, string | string[] | undefined>, url: URL): string {
  const host = requestHost(headers).replace(/:\d+$/, "");
  const proto = firstHeader(headers["x-forwarded-proto"]) ?? "http";
  return `${proto}://${host}${url.pathname}${url.search}`;
}

function requestHeaders(headers: Record<string, string | string[] | undefined>): RuntimeHeader[] {
  const result: RuntimeHeader[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        result.push({ name, value: item });
      }
      continue;
    }
    result.push({ name, value });
  }
  return result;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requiredHeader(value: string | undefined): string {
  if (!value || value.trim().length === 0) {
    throw new RuntimeError("validation", "host or x-forwarded-host header is required");
  }
  return value;
}

function assertRouteSnapshot(value: RouteSnapshot) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.routes)) {
    throw new RuntimeError("validation", "route snapshot must have schemaVersion 1 and routes");
  }
}

function writeInvocationResponse(
  response: any,
  prepared: CompiledComponent,
  invocation: InvokeComponentResponse,
) {
  const headers: Record<string, string> = {
    "x-wasmplane-deployment": prepared.deploymentId,
    "x-wasmplane-precompiled": prepared.precompiledPath,
  };
  for (const header of invocation.headers) {
    if (isSafeResponseHeader(header.name)) {
      headers[header.name] = header.value;
    }
  }
  response.writeHead(invocation.status, headers);
  response.end(Buffer.from(invocation.body));
}

function isSafeResponseHeader(name: string): boolean {
  return !new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]).has(name.toLowerCase());
}
