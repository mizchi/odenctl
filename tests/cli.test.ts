import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  deployComponent,
  parseDeployArgs,
  parseMigrateArgs,
  parseVolumeSqliteArgs,
  runMigrateCommand,
  runVolumeSqliteCommand,
} from "../src/cli.ts";
import {
  MVP_RUNTIME_BACKEND,
  MVP_WASI_PROFILE,
  MVP_WORKER_WORLD,
} from "../src/control-plane/contracts.ts";
import { createVolumeSqliteRegistry } from "../src/control-plane/volume-sqlite.ts";

test("CLI deploy flow uploads component, creates deployment, points route, and publishes snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-cli-"));
  const componentPath = join(dir, "worker.component.wasm");
  const componentBytes = Buffer.from("component bytes");
  await writeFile(componentPath, componentBytes);
  const calls: Array<{ path: string; method: string; headers: Record<string, string>; body: any }> = [];

  const result = await deployComponent({
    controlPlaneUrl: "http://control-plane.local",
    projectId: "prj_hello",
    componentPath,
    artifactId: "art_cli",
    deploymentId: "dep_cli",
    routeId: "rte_cli",
    host: "hello.example.dev",
    pathPrefix: "/api",
    outboundAllow: ["https://api.example.dev/v1/"],
    kv: [{ binding: "MAIN", namespaceId: "kv_main" }],
    secrets: [{ binding: "API_KEY", secretId: "sec_api_key" }],
    token: "control-secret",
    publish: true,
    fetch: async (url, init) => {
      const parsed = new URL(url);
      const body = init?.body ? JSON.parse(init.body) : {};
      calls.push({ path: parsed.pathname, method: init?.method ?? "GET", headers: init?.headers ?? {}, body });
      if (parsed.pathname === "/artifacts/local") {
        return jsonResponse(201, {
          id: body.id,
          projectId: body.projectId,
          digest: `sha256:${createHash("sha256").update(componentBytes).digest("hex")}`,
          location: "file:///tmp/artifact.component.wasm",
          sizeBytes: componentBytes.byteLength,
        });
      }
      if (parsed.pathname === "/deployments") {
        return jsonResponse(201, { id: body.id, projectId: body.projectId, artifactId: body.artifactId });
      }
      if (parsed.pathname === "/routes") {
        return jsonResponse(200, { id: body.id, projectId: body.projectId, deploymentId: body.deploymentId });
      }
      if (parsed.pathname === "/snapshots/routes/publish") {
        return jsonResponse(200, { ok: true, targets: [] });
      }
      return jsonResponse(404, { error: { code: "not_found" } });
    },
  });

  assert.deepEqual(
    calls.map((call) => [call.method, call.path]),
    [
      ["POST", "/artifacts/local"],
      ["POST", "/deployments"],
      ["PUT", "/routes"],
      ["POST", "/snapshots/routes/publish"],
    ],
  );
  assert.equal(calls[0]?.body.bytesBase64, componentBytes.toString("base64"));
  assert.deepEqual(
    calls.map((call) => call.headers.authorization),
    ["Bearer control-secret", "Bearer control-secret", "Bearer control-secret", "Bearer control-secret"],
  );
  assert.deepEqual(calls[1]?.body, {
    id: "dep_cli",
    projectId: "prj_hello",
    artifactId: "art_cli",
    world: MVP_WORKER_WORLD,
    runtime: { backend: MVP_RUNTIME_BACKEND, version: "wasmtime-42", wasi: MVP_WASI_PROFILE },
    limits: {
      cpuMs: 50,
      memoryMb: 64,
      wallMs: 1000,
      requestBytes: 1048576,
      responseBytes: 1048576,
      subrequests: 20,
      hostCalls: 100,
    },
    capabilities: {
      outboundHttp: { enabled: true, allow: ["https://api.example.dev/v1/"] },
      kv: [{ binding: "MAIN", namespaceId: "kv_main" }],
      secrets: [{ binding: "API_KEY", secretId: "sec_api_key" }],
      arbitraryFilesystem: false,
      arbitrarySockets: false,
      processSpawn: false,
    },
  });
  assert.deepEqual(calls[2]?.body, {
    id: "rte_cli",
    projectId: "prj_hello",
    host: "hello.example.dev",
    pathPrefix: "/api",
    deploymentId: "dep_cli",
  });
  assert.equal(result.publish.ok, true);
});

test("CLI deploy args parse capability bindings and limit overrides", () => {
  const input = parseDeployArgs(
    [
      "--project-id",
      "prj_hello",
      "--component",
      "worker.component.wasm",
      "--host",
      "hello.example.dev",
      "--kv",
      "MAIN=kv_main",
      "--secret",
      "API_KEY=sec_api_key",
      "--outbound",
      "https://api.example.dev/",
      "--limit",
      "wallMs=2500",
      "--token",
      "control-secret",
      "--no-publish",
    ],
    { WASMPLANE_CONTROL_PLANE_URL: "http://127.0.0.1:9999" },
  );

  assert.equal(input.controlPlaneUrl, "http://127.0.0.1:9999");
  assert.deepEqual(input.kv, [{ binding: "MAIN", namespaceId: "kv_main" }]);
  assert.deepEqual(input.secrets, [{ binding: "API_KEY", secretId: "sec_api_key" }]);
  assert.deepEqual(input.outboundAllow, ["https://api.example.dev/"]);
  assert.deepEqual(input.limits, { wallMs: 2500 });
  assert.equal(input.token, "control-secret");
  assert.equal(input.publish, false);
});

test("CLI deploy args read token from environment", () => {
  const input = parseDeployArgs(
    [
      "--project-id",
      "prj_hello",
      "--component",
      "worker.component.wasm",
      "--host",
      "hello.example.dev",
    ],
    {
      WASMPLANE_CONTROL_PLANE_URL: "http://127.0.0.1:9999",
      WASMPLANE_CONTROL_PLANE_TOKEN: "env-secret",
    },
  );

  assert.equal(input.token, "env-secret");
});

test("CLI migrate args parse explicit SQLite path", () => {
  const input = parseMigrateArgs(
    ["check", "--sqlite", "/tmp/control.sqlite"],
    {},
  );

  assert.deepEqual(input, {
    action: "check",
    env: { WASMPLANE_DB: "/tmp/control.sqlite" },
  });
});

test("CLI migrate apply returns current schema status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-cli-migrate-"));
  const dbPath = join(dir, "control.sqlite");

  const result = await runMigrateCommand({
    action: "apply",
    env: { WASMPLANE_DB: dbPath },
  });

  assert.equal(result.ok, true);
  assert.equal(result.currentVersion, result.latestVersion);
  assert.deepEqual(result.pending, []);
});

test("CLI volume-sqlite args parse backup and restore commands", () => {
  assert.deepEqual(
    parseVolumeSqliteArgs(["backup", "--root", "/data/sqlite", "--id", "prj_api", "--backup-id", "daily"]),
    {
      action: "backup",
      rootDir: "/data/sqlite",
      id: "prj_api",
      backupId: "daily",
    },
  );
  assert.deepEqual(
    parseVolumeSqliteArgs([
      "restore",
      "--root",
      "/data/sqlite",
      "--id",
      "prj_api",
      "--backup-id",
      "daily",
      "--owner-id",
      "prj_api",
      "--schema-version",
      "7",
    ]),
    {
      action: "restore",
      rootDir: "/data/sqlite",
      id: "prj_api",
      backupId: "daily",
      ownerId: "prj_api",
      schemaVersion: 7,
    },
  );
  assert.deepEqual(
    parseVolumeSqliteArgs([
      "gc",
      "--root",
      "/data/sqlite",
      "--id",
      "prj_api",
      "--keep-latest",
      "2",
      "--older-than-ms",
      "86400000",
    ]),
    {
      action: "gc",
      rootDir: "/data/sqlite",
      id: "prj_api",
      keepLatest: 2,
      olderThanMs: 86400000,
    },
  );
});

test("CLI volume-sqlite command backs up and restores a database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-cli-volume-sqlite-"));
  await runVolumeSqliteCommand({
    action: "ensure",
    rootDir: dir,
    id: "prj_api",
    schemaVersion: 1,
  });
  const registry = createVolumeSqliteRegistry({ rootDir: dir });
  try {
    registry.withDatabase("prj_api", (db) => {
      db.exec("create table events (id text primary key); insert into events (id) values ('before')");
    });
  } finally {
    registry.close();
  }

  const backup = await runVolumeSqliteCommand({
    action: "backup",
    rootDir: dir,
    id: "prj_api",
    backupId: "cli_backup",
  });

  const changed = createVolumeSqliteRegistry({ rootDir: dir });
  try {
    changed.withDatabase("prj_api", (db) => {
      db.exec("insert into events (id) values ('after')");
    });
  } finally {
    changed.close();
  }

  const restored = await runVolumeSqliteCommand({
    action: "restore",
    rootDir: dir,
    id: "prj_api",
    backupId: "cli_backup",
  });

  assert.equal(backup.id, "cli_backup");
  assert.equal(restored.id, "prj_api");
  const verified = createVolumeSqliteRegistry({ rootDir: dir });
  try {
    verified.withDatabase("prj_api", (db) => {
      assert.deepEqual(
        db.prepare("select id from events order by id asc").all().map((row: any) => row.id),
        ["before"],
      );
    });
  } finally {
    verified.close();
  }
});

test("CLI volume-sqlite command prunes old backups", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-cli-volume-sqlite-gc-"));
  await runVolumeSqliteCommand({
    action: "ensure",
    rootDir: dir,
    id: "prj_api",
  });
  const registry = createVolumeSqliteRegistry({ rootDir: dir });
  try {
    registry.withDatabase("prj_api", (db) => {
      db.exec("create table events (id text primary key)");
    });
    registry.exportDatabase({ id: "prj_api", backupId: "backup_1" });
    registry.exportDatabase({ id: "prj_api", backupId: "backup_2" });
  } finally {
    registry.close();
  }

  const report = await runVolumeSqliteCommand({
    action: "gc",
    rootDir: dir,
    id: "prj_api",
    keepLatest: 1,
  });

  assert.deepEqual(report.deleted.map((backup: any) => backup.id), ["backup_1"]);
  const verified = createVolumeSqliteRegistry({ rootDir: dir });
  try {
    assert.deepEqual(verified.listBackups("prj_api").map((backup) => backup.id), ["backup_2"]);
  } finally {
    verified.close();
  }
});

function jsonResponse(status: number, body: any) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}
