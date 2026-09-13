// Keep the WIT and test source editable; regenerate ABI bindings in target/.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = dirname(fileURLToPath(import.meta.url));
const root = resolve(app, "../../..");
const wit = resolve(app, "../wit");
const generated = resolve(app, "target/generated");
const project = "wasmplane/service-sdk";
function run(program, args, cwd = app) {
  const result = spawnSync(program, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${program} failed (${result.status})`);
  }
}

rmSync(generated, { recursive: true, force: true });
run(process.env.WIT_BINDGEN ?? "wit-bindgen", [
  "moonbit",
  wit,
  "--world",
  "suite",
  "--out-dir",
  generated,
  "--project-name",
  project,
]);
const sdk = resolve(root, "sdk/moonbit");
mkdirSync(resolve(generated, "sdk"), { recursive: true });
for (
  const file of readdirSync(sdk).filter((name) =>
    name.endsWith(".mbt") || name === "moon.pkg.json"
  )
) {
  cpSync(resolve(sdk, file), resolve(generated, "sdk", file));
}
const checks = resolve(generated, "gen/interface/example/testing/checks");
const pkg = JSON.parse(readFileSync(resolve(checks, "moon.pkg.json"), "utf8"));
pkg.import.push(
  { path: `${project}/sdk`, alias: "io" },
  { path: `${project}/interface/wasi/clocks/monotonic-clock`, alias: "clock" },
  "moonbitlang/core/encoding/utf8",
);
writeFileSync(
  resolve(checks, "moon.pkg.json"),
  JSON.stringify(pkg, null, 2) + "\n",
);
for (const file of ["implementation.mbt", "pricing.mbt"]) {
  cpSync(resolve(app, file), resolve(checks, file));
}
run("moon", ["build", "--target", "wasm", "--release"], generated);
const embedded = resolve(app, "target/embedded.wasm");
const component = resolve(app, "target/tests.wasm");
run("wasm-tools", [
  "component",
  "embed",
  wit,
  resolve(generated, "_build/wasm/release/build/gen/gen.wasm"),
  "--world",
  "suite",
  "--encoding",
  "utf16",
  "-o",
  embedded,
]);
run("wasm-tools", ["component", "new", embedded, "-o", component]);
run("wasm-tools", [
  "validate",
  "--features",
  "cm-async,cm-async-stackful",
  component,
]);
