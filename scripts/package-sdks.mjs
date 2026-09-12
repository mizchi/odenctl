// Produce local distribution artifacts; this script does not publish packages.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.argv[2] ?? join(root, "target/sdk-packages"));
mkdirSync(output, { recursive: true });
const version = /^version = "([^"]+)"/m.exec(readFileSync(join(root, "sdk/rust/Cargo.toml"), "utf8"))?.[1];
if (!version) throw new Error("Rust SDK version is missing");
function run(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} failed: ${result.status}`);
}
// cargo package verifies the extracted crate with no workspace source paths.
run("cargo", ["package", "--allow-dirty", "--target", "wasm32-wasip2", "--target-dir", join(output, "rust-build")], join(root, "sdk/rust"));
cpSync(join(output, `rust-build/package/wasmplane-service-sdk-${version}.crate`), join(output, `wasmplane-service-sdk-${version}.crate`));
function copyContract(source, target) {
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(source)) {
    const from = join(source, name), to = join(target, name);
    if (statSync(from).isDirectory()) copyContract(from, to);
    else writeFileSync(to, readFileSync(from));
  }
}
const stage = mkdtempSync(join(tmpdir(), "wasmplane-sdk-pack-"));
try {
  cpSync(join(root, "sdk/moonbit"), stage, { recursive: true });
  copyContract(join(root, "wit/app"), join(stage, "wit/app"));
  run("pnpm", ["pack", "--pack-destination", output], stage);
} finally { rmSync(stage, { recursive: true, force: true }); }
console.log(`SDK packages: ${output}`);
