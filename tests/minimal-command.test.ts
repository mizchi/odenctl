import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const binary = process.env.ODEN_MINIMAL_BIN;

for (const component of [
  "examples/minimal-command/command.wat",
  "examples/minimal-command/target/wat.wasm",
  "examples/minimal-command/target/moonbit.wasm",
]) {
  test(`minimal command runs: ${component}`, { skip: !binary }, async () => {
    const result = await run(resolve(binary!), ["run", resolve(component)], { timeout: 10_000 });
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });
}
