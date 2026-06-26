import { createServer } from "node:http";
import type { RouteSnapshot } from "../control-plane/contracts.ts";
import { ControlPlaneError, isControlPlaneError } from "../control-plane/errors.ts";
import {
  type FetchLike,
  publishRouteSnapshot,
  type RuntimeNodeTarget,
} from "../control-plane/snapshot-publisher.ts";

export interface HttpAppOptions {
  controlPlane: {
    createProject(input: any): unknown;
    createArtifact(input: any): unknown;
    createDeployment(input: any): unknown;
    pointRoute(input: any): unknown;
    createRouteSnapshot(): RouteSnapshot;
  };
  runtimeNodes?: RuntimeNodeTarget[];
  fetch?: FetchLike;
}

export function createHttpApp(options: HttpAppOptions) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const method = request.method ?? "GET";

      if (method === "GET" && url.pathname === "/healthz") {
        writeJson(response, 200, { ok: true });
        return;
      }
      if (method === "POST" && url.pathname === "/projects") {
        writeJson(response, 201, options.controlPlane.createProject(await readJson(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/artifacts") {
        writeJson(response, 201, options.controlPlane.createArtifact(await readJson(request)));
        return;
      }
      if (method === "POST" && url.pathname === "/deployments") {
        writeJson(response, 201, options.controlPlane.createDeployment(await readJson(request)));
        return;
      }
      if (method === "PUT" && url.pathname === "/routes") {
        writeJson(response, 200, options.controlPlane.pointRoute(await readJson(request)));
        return;
      }
      if (method === "GET" && url.pathname === "/snapshots/routes") {
        writeJson(response, 200, options.controlPlane.createRouteSnapshot());
        return;
      }
      if (method === "POST" && url.pathname === "/snapshots/routes/publish") {
        const runtimeNodes = options.runtimeNodes ?? [];
        if (runtimeNodes.length === 0) {
          throw new ControlPlaneError("validation", "no runtime nodes are configured");
        }
        const snapshot = options.controlPlane.createRouteSnapshot();
        writeJson(
          response,
          200,
          await publishRouteSnapshot(snapshot, runtimeNodes, options.fetch ?? fetch),
        );
        return;
      }

      writeJson(response, 404, { error: { code: "not_found", message: "route not found" } });
    } catch (error) {
      if (isControlPlaneError(error)) {
        writeJson(response, error.status, { error: { code: error.code, message: error.message } });
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

async function readJson(request: any): Promise<unknown> {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (body.trim().length === 0) {
    return {};
  }
  return JSON.parse(body);
}

function writeJson(response: any, status: number, value: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}
