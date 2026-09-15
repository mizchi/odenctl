// Build editable MoonBit fixtures against the shared, language-neutral WIT.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as buildService } from "../../sdk/moonbit/build.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const example = resolve(root, "examples/telemetry-composition");
const moonbit = resolve(example, "moonbit");
const wit = resolve(moonbit, "target/wit");
const bindgen = process.env.WIT_BINDGEN ?? "wit-bindgen";
const project = "odenctl/telemetry-fixture";

function run(program, args, cwd = root) {
  const result = spawnSync(program, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${program} failed (${result.status})`);
  }
}

// Resolve existing contracts into an isolated WIT package; no duplicate schemas.
rmSync(wit, { recursive: true, force: true });
mkdirSync(resolve(wit, "deps/app"), { recursive: true });
cpSync(resolve(root, "wit/app/deps"), resolve(wit, "deps"), {
  recursive: true,
  dereference: true,
});
for (const file of ["lifecycle.wit", "service.wit"]) {
  writeFileSync(
    resolve(wit, "deps/app", file),
    readFileSync(resolve(root, "wit/app", file)),
  );
}
cpSync(resolve(example, "wit/boundary.wit"), resolve(wit, "deps/boundary.wit"));
cpSync(resolve(moonbit, "worlds.wit"), resolve(wit, "worlds.wit"));

const provider = resolve(moonbit, "provider");
const generated = resolve(provider, "target/generated");
rmSync(generated, { recursive: true, force: true });
run(bindgen, [
  "moonbit",
  wit,
  "--world",
  "provider",
  "--out-dir",
  generated,
  "--project-name",
  project,
]);
const operations = resolve(
  generated,
  "gen/interface/example/boundary/operations",
);
const pkg = JSON.parse(
  readFileSync(resolve(operations, "moon.pkg.json"), "utf8"),
);
pkg.import.push({
  path: `${project}/interface/wasi/clocks/monotonic-clock`,
  alias: "clock",
});
writeFileSync(
  resolve(operations, "moon.pkg.json"),
  JSON.stringify(pkg, null, 2) + "\n",
);
cpSync(
  resolve(provider, "implementation.mbt"),
  resolve(operations, "implementation.mbt"),
);
run("moon", ["build", "--target", "wasm", "--release"], generated);
const embedded = resolve(provider, "target/embedded.wasm");
const component = resolve(provider, "target/provider.wasm");
run("wasm-tools", [
  "component",
  "embed",
  wit,
  resolve(generated, "_build/wasm/release/build/gen/gen.wasm"),
  "--world",
  "provider",
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

buildService(resolve(moonbit, "app"), { wit, world: "app" });
