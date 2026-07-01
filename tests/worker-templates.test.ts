import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  listWorkerTemplates,
  materializeWorkerTemplate,
  workerTemplateFiles,
} from "../src/worker-templates.ts";

test("worker template catalog exposes common language SDK helpers", () => {
  assert.deepEqual(listWorkerTemplates().map((template) => template.language), ["rust", "typescript"]);
  assert.deepEqual(listWorkerTemplates().map((template) => template.world), [
    "myedge:runtime/worker@0.1.0",
    "myedge:runtime/worker@0.1.0",
  ]);
});

test("rust worker template writes WIT, SDK helpers, and build scaffolding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-worker-template-rust-"));
  const outDir = join(dir, "hello-worker");

  const result = await materializeWorkerTemplate({
    language: "rust",
    name: "hello-worker",
    outDir,
  });

  assert.deepEqual(result.files.map((file) => file.path).sort(), [
    "Cargo.toml",
    "README.md",
    "justfile",
    "src/lib.rs",
    "src/wasmplane.rs",
    "wit/world.wit",
  ]);
  assert.match(await readFile(join(outDir, "wit/world.wit"), "utf8"), /world worker/);
  assert.match(await readFile(join(outDir, "src/wasmplane.rs"), "utf8"), /pub async fn text_response/);
  assert.match(await readFile(join(outDir, "src/lib.rs"), "utf8"), /bindings::export!\(Component with_types_in bindings\)/);
  assert.match(await readFile(join(outDir, "justfile"), "utf8"), /wit-bindgen rust wit --world worker/);
});

test("typescript worker template writes WIT, SDK helpers, and jco scripts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-worker-template-typescript-"));
  const outDir = join(dir, "hello-worker");

  await materializeWorkerTemplate({
    language: "typescript",
    name: "hello-worker",
    outDir,
  });

  assert.match(await readFile(join(outDir, "wit/world.wit"), "utf8"), /package myedge:runtime@0\.1\.0/);
  assert.match(await readFile(join(outDir, "src/wasmplane.ts"), "utf8"), /export function textResponse/);
  assert.match(await readFile(join(outDir, "src/worker.ts"), "utf8"), /export async function handle/);
  assert.match(await readFile(join(outDir, "package.json"), "utf8"), /jco componentize/);
});

test("worker template materialization refuses to overwrite unless forced", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-worker-template-overwrite-"));
  const outDir = join(dir, "hello-worker");
  await materializeWorkerTemplate({ language: "rust", name: "hello-worker", outDir });
  await writeFile(join(outDir, "README.md"), "local edits");

  await assert.rejects(
    materializeWorkerTemplate({ language: "rust", name: "hello-worker", outDir }),
    /already exists/,
  );

  await materializeWorkerTemplate({ language: "rust", name: "hello-worker", outDir, force: true });
  assert.match(await readFile(join(outDir, "README.md"), "utf8"), /# hello-worker/);
});

test("worker template files can be generated without writing to disk", async () => {
  const files = await workerTemplateFiles({ language: "rust", name: "demo-worker" });

  assert.ok(files.some((file) => file.path === "wit/world.wit" && file.contents.includes("world worker")));
  assert.ok(files.some((file) => file.path === "src/wasmplane.rs" && file.contents.includes("header(req")));
});
