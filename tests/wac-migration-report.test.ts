import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeWacRuntimeWorkerWit,
  evaluateWacMigrationReport,
  formatWacMigrationMarkdown,
  parseWacMigrationReportArgs,
  runWacMigrationProbe,
  type CommandRunner,
} from "../src/wac-migration-report.ts";

test("WAC migration report analyzes the runtime worker WIT blocker shape", () => {
  const analysis = analyzeWacRuntimeWorkerWit("worker.wit", `
package myedge:runtime@0.1.0;

interface http {
  resource incoming-body {
    read: async func(max: u64) -> option<list<u8>>;
  }
}

world worker {
  import http;
  import bridge;

  export handle: async func(req: request) -> response;
}
`);

  assert.equal(analysis.hasAsyncExport, true);
  assert.equal(analysis.hasResources, true);
  assert.equal(analysis.hasAsyncFunctions, true);
  assert.deepEqual(analysis.importedInterfaces, ["bridge", "http"]);
  assert.equal(analysis.risk, "wasip3-async-resource");
});

test("WAC migration report classifies known WASIp3 async blocker", () => {
  const runtimeWorld = analyzeWacRuntimeWorkerWit("worker.wit", "world worker { export handle: async func() }");
  const report = evaluateWacMigrationReport({
    generatedAt: "2026-07-04T00:00:00.000Z",
    wacVersion: "wac-cli 0.10.1",
    runtimeWorld,
    canary: { exitCode: 0, stdout: "42\n", stderr: "" },
    runtimeProbe: {
      exitCode: 101,
      stdout: "",
      stderr: "thread 'main' panicked at wac-graph-0.10.1/src/encoding.rs:653:42:\nno entry found for key",
    },
  });

  assert.equal(report.ok, true);
  assert.equal(report.status, "blocked");
  assert.equal(report.canary.status, "ok");
  assert.equal(report.runtimeWorker.status, "blocked");
  assert.equal(report.defaultBuildCanSwitch, false);
  assert.match(report.runtimeWorker.reason, /WASIp3 async worker world/);
  assert.equal(report.runtimeWorld.risk, "wasip3-async-resource");
});

test("WAC migration report marks runtime worker ready after successful probe", () => {
  const report = evaluateWacMigrationReport({
    generatedAt: "2026-07-04T00:00:00.000Z",
    wacVersion: "wac-cli 0.10.1",
    canary: { exitCode: 0, stdout: "42\n", stderr: "" },
    runtimeProbe: { exitCode: 0, stdout: "", stderr: "" },
  });

  assert.equal(report.ok, true);
  assert.equal(report.status, "ready");
  assert.equal(report.runtimeWorker.status, "ready");
  assert.equal(report.defaultBuildCanSwitch, true);
});

test("WAC migration report fails when the WAC canary fails", () => {
  const report = evaluateWacMigrationReport({
    generatedAt: "2026-07-04T00:00:00.000Z",
    wacVersion: "wac-cli 0.10.1",
    canary: { exitCode: 1, stdout: "", stderr: "answer mismatch" },
    runtimeProbe: { exitCode: 0, stdout: "", stderr: "" },
  });

  assert.equal(report.ok, false);
  assert.equal(report.status, "failed");
  assert.equal(report.canary.status, "failed");
  assert.equal(report.defaultBuildCanSwitch, false);
});

test("WAC migration markdown summarizes status and issue", () => {
  const markdown = formatWacMigrationMarkdown(
    evaluateWacMigrationReport({
      generatedAt: "2026-07-04T00:00:00.000Z",
      wacVersion: "wac-cli 0.10.1",
      runtimeWorld: analyzeWacRuntimeWorkerWit(
        "examples/rust-moonbit-release/wit/worker.wit",
        "interface http { resource incoming-body } world worker { import http; export handle: async func() }",
      ),
      canary: { exitCode: 0, stdout: "42\n", stderr: "" },
      runtimeProbe: {
        exitCode: 101,
        stdout: "",
        stderr: "wac-graph-0.10.1/src/encoding.rs:653:42:\nno entry found for key",
      },
    }),
  );

  assert.match(markdown, /status: blocked/);
  assert.match(markdown, /WAC upstream issue #180/);
  assert.match(markdown, /runtime worker WIT/);
  assert.match(markdown, /async export: yes/);
  assert.match(markdown, /resources: yes/);
  assert.match(markdown, /\| wac canary \| ok \|/);
  assert.match(markdown, /\| runtime worker probe \| blocked \|/);
});

test("WAC migration args parse output and format", () => {
  assert.deepEqual(
    parseWacMigrationReportArgs(["--format", "json", "--output", "reports/wac.json", "--timeout-ms", "1000"]),
    {
      format: "json",
      output: "reports/wac.json",
      runtimeWorkerWit: "examples/rust-moonbit-release/wit/worker.wit",
      timeoutMs: 1000,
    },
  );
  assert.throws(() => parseWacMigrationReportArgs(["--format", "xml"]), /--format must be json or markdown/);
  assert.deepEqual(parseWacMigrationReportArgs(["--runtime-worker-wit", "worker.wit"]), {
    format: "markdown",
    runtimeWorkerWit: "worker.wit",
    timeoutMs: 120000,
  });
});

test("WAC migration probe runs canary and runtime worker probe", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: CommandRunner = {
    async run(command, args) {
      calls.push({ command, args });
      if (command === "wac") {
        return { exitCode: 0, stdout: "wac-cli 0.10.1\n", stderr: "" };
      }
      if (args[0] === "sample-rust-moonbit-wac-smoke") {
        return { exitCode: 0, stdout: "42\n", stderr: "" };
      }
      return {
        exitCode: 101,
        stdout: "",
        stderr: "wac-graph-0.10.1/src/encoding.rs:653:42:\nno entry found for key",
      };
    },
  };

  const report = await runWacMigrationProbe({
    generatedAt: "2026-07-04T00:00:00.000Z",
    runtimeWorkerWitText: "world worker { export handle: async func() }",
    runner,
    timeoutMs: 1000,
  });

  assert.deepEqual(calls, [
    { command: "wac", args: ["--version"] },
    { command: "just", args: ["sample-rust-moonbit-wac-smoke"] },
    { command: "just", args: ["sample-rust-moonbit-wac-probe"] },
  ]);
  assert.equal(report.status, "blocked");
  assert.equal(report.runtimeWorld.hasAsyncExport, true);
});
