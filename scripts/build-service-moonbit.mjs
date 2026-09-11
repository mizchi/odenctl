// Generated ABI bindings stay in target; the contract, SDK and app stay editable.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = resolve(process.argv[2] ?? resolve(root, "examples/service-moonbit"));
const generated = resolve(app, "target/generated");
function run(program, args, cwd = root) {
  const result = spawnSync(program, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run("wit-bindgen", ["moonbit", resolve(root, "wit/app"), "--world", "service", "--out-dir", generated, "--project-name", "wasmplane/service-sdk"]);
cpSync(resolve(root, "sdk/moonbit"), resolve(generated, "sdk"), { recursive: true });
mkdirSync(resolve(generated, "app"), { recursive: true });
for (const file of ["app.mbt", "moon.pkg.json"]) cpSync(resolve(app, file), resolve(generated, "app", file));
for (const [path, implementation] of [
  ["wasmplane/app/lifecycle", `pub async fn start(background_group : @async-core.TaskGroup[Unit]) -> Result[Unit, String] { @app.start(background_group) }
pub async fn stop(background_group : @async-core.TaskGroup[Unit]) -> Result[Unit, String] { @app.stop(background_group) }`],
  ["wasi/http/handler", `pub async fn handle(request : @types.Request, background_group : @async-core.TaskGroup[Unit]) -> Result[@types.Response, @types.ErrorCode] { @app.handle(request, background_group) }`],
]) {
  const directory = resolve(generated, "gen/interface", path);
  const pkg = JSON.parse(readFileSync(resolve(directory, "moon.pkg.json"), "utf8"));
  pkg.import.push({ path: "wasmplane/service-sdk/app", alias: "app" });
  writeFileSync(resolve(directory, "moon.pkg.json"), JSON.stringify(pkg, null, 2));
  writeFileSync(resolve(directory, "implementation.mbt"), implementation + "\n");
}
run("moon", ["build", "--target", "wasm", "--release"], generated);
const embedded = resolve(app, "target/embedded.wasm");
const component = resolve(app, "target/service.wasm");
run("wasm-tools", ["component", "embed", resolve(root, "wit/app"), resolve(generated, "_build/wasm/release/build/gen/gen.wasm"), "--world", "service", "--encoding", "utf16", "-o", embedded]);
run("wasm-tools", ["component", "new", embedded, "-o", component]);
run("wasm-tools", ["validate", "--features", "cm-async,cm-async-stackful", component]);
