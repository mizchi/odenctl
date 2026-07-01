import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RouteSnapshot } from "../control-plane/contracts.ts";

export interface RuntimeRouteSnapshotStore {
  save(snapshot: RouteSnapshot): Promise<void>;
}

export function createFileRouteSnapshotStore(path: string): RuntimeRouteSnapshotStore {
  return {
    async save(snapshot) {
      await mkdir(dirname(path), { recursive: true });
      const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(snapshot), "utf8");
      await rename(temporaryPath, path);
    },
  };
}

export async function loadRouteSnapshotFile(path: string): Promise<RouteSnapshot | undefined> {
  try {
    const snapshot = JSON.parse(await readFile(path, "utf8"));
    assertRouteSnapshotFile(snapshot);
    return snapshot;
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

function assertRouteSnapshotFile(value: unknown): asserts value is RouteSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("route snapshot must be an object");
  }
  const snapshot = value as Record<string, unknown>;
  if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.routes)) {
    throw new Error("route snapshot must have schemaVersion 1 and routes");
  }
  if (snapshot.id !== undefined && typeof snapshot.id !== "string") {
    throw new Error("route snapshot id must be a string");
  }
  if (typeof snapshot.generatedAt !== "string") {
    throw new Error("route snapshot generatedAt must be a string");
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}
