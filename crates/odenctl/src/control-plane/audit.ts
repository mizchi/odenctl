import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ApiScope } from "./authz.ts";

export interface AuditEvent {
  timestamp: string;
  principal: string;
  scope: ApiScope;
  method: string;
  path: string;
  status: number;
}

export interface AuditSink {
  record(event: AuditEvent): Promise<void>;
}

export interface JsonlAuditSinkOptions {
  path: string;
}

export function createJsonlAuditSink(options: JsonlAuditSinkOptions): AuditSink {
  return {
    async record(event) {
      await mkdir(dirname(options.path), { recursive: true });
      await appendFile(options.path, `${JSON.stringify(event)}\n`);
    },
  };
}
