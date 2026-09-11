import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

const binary = process.env.WASMPLANE_SERVICE_BIN && resolve(process.env.WASMPLANE_SERVICE_BIN);
const component = process.env.WASMPLANE_SERVICE_RUST && resolve(process.env.WASMPLANE_SERVICE_RUST);
const enabled = Boolean(binary && component);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, logs: () => string) {
  const deadline = Date.now() + 15_000;
  while (!check()) { if (Date.now() > deadline) throw new Error(`timeout: ${logs()}`); await sleep(25); }
}
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "wasmplane-app-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manifest = join(dir, "app.json");
  const app = { version: 1, component: "build/service.wasm", mode: "service", listen: "127.0.0.1:0",
    watch: ["source.txt"], build: [[process.execPath, "build.mjs"]],
    runtime: { timeout_ms: 2000 }, service: { shutdown_timeout_ms: 1000 } };
  await writeFile(manifest, JSON.stringify(app));
  await writeFile(join(dir, "source.txt"), "ok");
  await writeFile(join(dir, "build.mjs"), `import {readFileSync,mkdirSync,copyFileSync} from 'node:fs';
if(readFileSync('source.txt','utf8') === 'fail') process.exit(7);
mkdirSync('build',{recursive:true});copyFileSync(${JSON.stringify(component)},'build/service.wasm');`);
  return { dir, manifest, app };
}

test("manifest build runs argv in the app directory and rejects invalid contracts", { skip: !enabled }, async (t) => {
  const { dir, manifest, app } = await fixture(t);
  const built = spawnSync(binary!, ["build", manifest], { encoding: "utf8", cwd: tmpdir() });
  assert.equal(built.status, 0, built.stderr);
  assert.ok((await readFile(join(dir, "build/service.wasm"))).length > 8);
  for (const invalid of [{ ...app, version: 2 }, { ...app, typo: true }, { ...app, build: [[]] }, { ...app, runtime: { timeout_ms: 0 } }]) {
    await writeFile(manifest, JSON.stringify(invalid));
    const result = spawnSync(binary!, ["build", manifest], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
  }
});

test("start resolves component and directory grants relative to the manifest", { skip: !enabled }, async (t) => {
  const { dir, manifest } = await fixture(t);
  await mkdir(join(dir, "data"));
  await writeFile(join(dir, "command.wat"), await readFile("examples/minimal-command/command.wat"));
  await writeFile(manifest, JSON.stringify({ version: 1, mode: "command", component: "command.wat", runtime: { directories: [{ host: "data", guest: "/data" }] } }));
  const result = spawnSync(binary!, ["start", manifest], { cwd: tmpdir(), encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr);
});

test("dev interrupts a running build and its child processes on shutdown", { skip: !enabled || process.platform === "win32", timeout: 25_000 }, async (t) => {
  const { dir, manifest } = await fixture(t);
  await writeFile(join(dir, "build.mjs"), `import {spawn} from 'node:child_process';
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('build-child-ready:'+process.pid);setInterval(()=>{},1000)"],{stdio:'inherit'});
setInterval(()=>{},1000);`);
  const child = spawn(binary!, ["dev", manifest]);
  const exit = once(child, "exit");
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    const pid = /build-child-ready:(\d+)/.exec(output)?.[1];
    if (pid) { try { process.kill(Number(pid), "SIGKILL"); } catch {} }
    await exit;
  });
  await until(() => output.includes("build-child-ready"), () => output);
  child.kill("SIGTERM");
  assert.deepEqual(await exit, [0, null], output);
  // A descendant holding inherited pipes open prevents the close event.
  if (child.stdout.readableEnded) return;
  await Promise.race([once(child, "close"), sleep(2000).then(() => { throw new Error("build child outlived dev shutdown"); })]);
});

test("dev preserves the running generation on build failure and gracefully reloads on recovery", { skip: !enabled, timeout: 40_000 }, async (t) => {
  const { dir, manifest, app } = await fixture(t);
  const child = spawn(binary!, ["dev", manifest], { cwd: tmpdir() });
  const exit = once(child, "exit");
  let logs = "", output = "";
  child.stderr.on("data", (chunk) => { logs += chunk; });
  child.stdout.on("data", (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    await exit; clearTimeout(timer);
  });
  const addresses = () => [...logs.matchAll(/listening on (http:\/\/[^\s]+)\r?\n/g)].map((m) => m[1]);
  await until(() => addresses().length === 1, () => logs);
  assert.equal((await (await fetch(addresses()[0])).json()).count, 1);
  await writeFile(manifest, "{ invalid JSON");
  await until(() => logs.includes("manifest invalid"), () => logs);
  assert.equal((await (await fetch(addresses()[0])).json()).count, 2);
  await writeFile(join(dir, "source.txt"), "fail");
  await writeFile(manifest, JSON.stringify(app));
  await until(() => logs.includes("build failed"), () => logs);
  assert.equal((await (await fetch(addresses()[0])).json()).count, 3);
  assert.equal(addresses().length, 1);
  await writeFile(join(dir, "source.txt"), "recovered");
  await until(() => addresses().length === 2, () => logs);
  assert.equal((await (await fetch(addresses()[1])).json()).count, 1);
  child.kill("SIGTERM");
  assert.deepEqual(await exit, [0, null], logs);
  assert.equal(output.trim(), "lifecycle:start\nlifecycle:stop\nlifecycle:start\nlifecycle:stop");
});
