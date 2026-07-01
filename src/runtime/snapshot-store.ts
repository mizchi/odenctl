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
    return JSON.parse(await readFile(path, "utf8")) as RouteSnapshot;
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}
