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

test("worker templates use standard WASIp3 HTTP", async () => {
  assert.deepEqual(listWorkerTemplates().map((entry) => entry.language), ["rust"]);
  assert.equal(listWorkerTemplates()[0].world, "wasi:http/service@0.3.0");
  const files = await workerTemplateFiles({ language: "rust", name: "demo-worker" });
  assert.deepEqual(files.map((file) => file.path).sort(), ["Cargo.toml", "README.md", "justfile", "src/lib.rs", "src/oden.rs"]);
  assert.match(files.find((file) => file.path === "src/lib.rs")!.contents, /wasip3::http::service::export!/);
  assert.match(files.find((file) => file.path === "justfile")!.contents, /wasm32-wasip2/);
  await assert.rejects(workerTemplateFiles({ language: "typescript" as any, name: "unsupported" }), /unsupported/);
});

test("worker template materialization refuses to overwrite unless forced", async () => {
  const dir = await mkdtemp(join(tmpdir(), "odenctl-worker-template-overwrite-"));
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
