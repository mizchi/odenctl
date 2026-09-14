// Generated ABI bindings stay in target; the contract, SDK and app stay editable.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sdk = dirname(fileURLToPath(import.meta.url));
export function build(appPath = ".", options = {}) {
  const app = resolve(appPath);
  const wit = options.wit ?? resolve(sdk, "wit/app");
  const world = options.world ?? "service";
  const generated = resolve(app, "target/generated");
  function run(program, args, cwd = app) {
    const result = spawnSync(program, args, { cwd, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  rmSync(generated, { recursive: true, force: true });
  run(process.env.WIT_BINDGEN ?? "wit-bindgen", ["moonbit", wit, "--world", world, "--out-dir", generated, "--project-name", "oden/service-sdk"]);
  mkdirSync(resolve(generated, "sdk"), { recursive: true });
  for (const file of readdirSync(sdk).filter(name => name.endsWith(".mbt") || name === "moon.pkg.json")) {
    cpSync(resolve(sdk, file), resolve(generated, "sdk", file));
  }
  mkdirSync(resolve(generated, "app"), { recursive: true });
  for (const file of readdirSync(app).filter(name => name.endsWith(".mbt") || name === "moon.pkg.json")) {
    cpSync(resolve(app, file), resolve(generated, "app", file));
  }
  for (const [path, implementation] of [
    ["oden/app/lifecycle", `pub async fn start(background_group : @async-core.TaskGroup[Unit]) -> Result[Unit, String] { @app.start(background_group) }
  pub async fn stop(background_group : @async-core.TaskGroup[Unit]) -> Result[Unit, String] { @app.stop(background_group) }`],
    ["wasi/http/handler", `pub async fn handle(request : @types.Request, background_group : @async-core.TaskGroup[Unit]) -> Result[@types.Response, @types.ErrorCode] { @app.handle(request, background_group) }`],
  ]) {
    const directory = resolve(generated, "gen/interface", path);
    const pkg = JSON.parse(readFileSync(resolve(directory, "moon.pkg.json"), "utf8"));
    pkg.import.push({ path: "oden/service-sdk/app", alias: "app" });
    writeFileSync(resolve(directory, "moon.pkg.json"), JSON.stringify(pkg, null, 2));
    writeFileSync(resolve(directory, "implementation.mbt"), implementation + "\n");
  }
  run("moon", ["build", "--target", "wasm", "--release"], generated);
  const embedded = resolve(app, "target/embedded.wasm");
  const component = resolve(app, "target/service.wasm");
  run("wasm-tools", ["component", "embed", wit, resolve(generated, "_build/wasm/release/build/gen/gen.wasm"), "--world", world, "--encoding", "utf16", "-o", embedded]);
  run("wasm-tools", ["component", "new", embedded, "-o", component]);
  run("wasm-tools", ["validate", "--features", "cm-async,cm-async-stackful", component]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) build(process.argv[2]);
