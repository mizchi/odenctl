import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

export type WacMigrationStatus = "ready" | "blocked" | "failed";
export type WacCheckStatus = "ok" | "ready" | "blocked" | "failed";
export type WacMigrationFormat = "markdown" | "json";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: string[], options?: { timeoutMs?: number }): Promise<CommandResult>;
}

export interface WacMigrationReportInput {
  generatedAt: string;
  wacVersion: string;
  wacSource?: WacSource;
  runtimeWorld?: WacRuntimeWorkerWitAnalysis;
  canary: CommandResult;
  runtimeProbe: CommandResult;
}

export interface WacRuntimeWorkerWitAnalysis {
  path: string;
  hasAsyncExport: boolean;
  hasAsyncFunctions: boolean;
  hasResources: boolean;
  importedInterfaces: string[];
  risk: "compatible" | "wasip3-async-resource";
  notes: string[];
}

export interface WacMigrationCheck {
  status: WacCheckStatus;
  exitCode: number;
  reason: string;
  detail: string;
}

export interface WacMigrationReport {
  generatedAt: string;
  ok: boolean;
  status: WacMigrationStatus;
  defaultBuildCanSwitch: boolean;
  wacVersion: string;
  wacSource: WacSource;
  issueUrl: string;
  runtimeWorld: WacRuntimeWorkerWitAnalysis;
  canary: WacMigrationCheck;
  runtimeWorker: WacMigrationCheck;
  nextAction: string;
}

export interface WacMigrationProbeOptions {
  generatedAt?: string;
  runner?: CommandRunner;
  runtimeWorkerWit?: string;
  runtimeWorkerWitText?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface WacMigrationReportCliOptions {
  format: WacMigrationFormat;
  output?: string;
  runtimeWorkerWit: string;
  timeoutMs: number;
}

export const WAC_WASIP3_ASYNC_ISSUE_URL = "https://github.com/bytecodealliance/wac/issues/180";
export const WAC_FORK_GIT_URL = "https://github.com/mizchi/wac";
export const WAC_FORK_REF = "wasmplane-wac-0.10.1-p1";
export const WAC_FORK_REF_ARG = `--tag ${WAC_FORK_REF}`;

export interface WacSource {
  label: string;
  url: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RUNTIME_WORKER_WIT = "examples/rust-moonbit-release/wit/worker.wit";

export function evaluateWacMigrationReport(input: WacMigrationReportInput): WacMigrationReport {
  const runtimeWorld = input.runtimeWorld ?? unknownRuntimeWorkerWitAnalysis(DEFAULT_RUNTIME_WORKER_WIT);
  const wacSource = input.wacSource ?? resolveWacSource();
  const canaryOk = input.canary.exitCode === 0 && /\b42\b/.test(input.canary.stdout);
  const canary: WacMigrationCheck = canaryOk
    ? {
      status: "ok",
      exitCode: input.canary.exitCode,
      reason: "WAC can compose the synchronous Rust socket component with the MoonBit provider.",
      detail: summarizeCommandResult(input.canary),
    }
    : {
      status: "failed",
      exitCode: input.canary.exitCode,
      reason: "WAC canary failed before the runtime worker migration probe could be trusted.",
      detail: summarizeCommandResult(input.canary),
    };

  const runtimeWorker = classifyRuntimeWorkerProbe(input.runtimeProbe);
  const failed = !canaryOk || runtimeWorker.status === "failed";
  const status: WacMigrationStatus = failed
    ? "failed"
    : runtimeWorker.status === "ready"
    ? "ready"
    : "blocked";

  return {
    generatedAt: input.generatedAt,
    ok: !failed,
    status,
    defaultBuildCanSwitch: status === "ready",
    wacVersion: input.wacVersion.trim(),
    wacSource,
    issueUrl: WAC_WASIP3_ASYNC_ISSUE_URL,
    runtimeWorld,
    canary,
    runtimeWorker,
    nextAction: nextActionForStatus(status),
  };
}

export async function runWacMigrationProbe(options: WacMigrationProbeOptions = {}): Promise<WacMigrationReport> {
  const runner = options.runner ?? nodeCommandRunner;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = options.env ?? process.env;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const runtimeWorkerWit = options.runtimeWorkerWit ?? DEFAULT_RUNTIME_WORKER_WIT;
  const runtimeWorkerWitText = options.runtimeWorkerWitText ?? await readFile(runtimeWorkerWit, "utf8");
  const runtimeWorld = analyzeWacRuntimeWorkerWit(runtimeWorkerWit, runtimeWorkerWitText);
  const version = await runner.run("wac", ["--version"], { timeoutMs: 10_000 });
  const canary = await runner.run("just", ["sample-rust-moonbit-wac-smoke"], { timeoutMs });
  const runtimeProbe = await runner.run("just", ["sample-rust-moonbit-wac-probe"], { timeoutMs });

  return evaluateWacMigrationReport({
    generatedAt,
    wacVersion: version.exitCode === 0 ? version.stdout : summarizeCommandResult(version),
    wacSource: resolveWacSource(env),
    runtimeWorld,
    canary,
    runtimeProbe,
  });
}

export function formatWacMigrationMarkdown(report: WacMigrationReport): string {
  const lines = [
    "# wasmplane WAC migration",
    "",
    `status: ${report.status}`,
    `tracking ok: ${report.ok ? "yes" : "no"}`,
    `default build can switch: ${report.defaultBuildCanSwitch ? "yes" : "no"}`,
    `wac version: \`${report.wacVersion}\``,
    `wac source: [${report.wacSource.label}](${report.wacSource.url})`,
    `generated: \`${report.generatedAt}\``,
    `upstream: [WAC upstream issue #180](${report.issueUrl})`,
    "",
    "## runtime worker WIT",
    "",
    `path: \`${report.runtimeWorld.path}\``,
    `risk: ${report.runtimeWorld.risk}`,
    `async export: ${report.runtimeWorld.hasAsyncExport ? "yes" : "no"}`,
    `async functions: ${report.runtimeWorld.hasAsyncFunctions ? "yes" : "no"}`,
    `resources: ${report.runtimeWorld.hasResources ? "yes" : "no"}`,
    `imports: ${
      report.runtimeWorld.importedInterfaces.length > 0
        ? report.runtimeWorld.importedInterfaces.map((name) => `\`${name}\``).join(", ")
        : "none"
    }`,
    ...report.runtimeWorld.notes.map((note) => `- ${note}`),
    "",
    "| check | result | exit code | reason | detail |",
    "| --- | --- | --- | --- | --- |",
    checkRow("wac canary", report.canary),
    checkRow("runtime worker probe", report.runtimeWorker),
    "",
    `next action: ${report.nextAction}`,
    "",
  ];
  return lines.join("\n");
}

export function resolveWacSource(env: NodeJS.ProcessEnv = process.env): WacSource {
  const gitUrl = env.WASMPLANE_WAC_GIT_URL ?? WAC_FORK_GIT_URL;
  const refArg = env.WASMPLANE_WAC_GIT_REF_ARG ?? WAC_FORK_REF_ARG;
  const ownerRepo = gitUrl.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/)?.[1] ?? gitUrl;
  const ref = parseCargoGitRefArg(refArg) ?? WAC_FORK_REF;
  const url = gitUrl.startsWith("https://github.com/")
    ? `${gitUrl.replace(/\.git$/, "")}/tree/${encodeURIComponent(ref)}`
    : gitUrl;

  return {
    label: `${ownerRepo}@${ref}`,
    url,
  };
}

function parseCargoGitRefArg(refArg: string): string | undefined {
  const parts = refArg.trim().split(/\s+/).filter(Boolean);
  const index = parts.findIndex((part) => part === "--rev" || part === "--tag" || part === "--branch");
  return index >= 0 ? parts[index + 1] : undefined;
}

export function parseWacMigrationReportArgs(args: string[]): WacMigrationReportCliOptions {
  const options: WacMigrationReportCliOptions = {
    format: "markdown",
    runtimeWorkerWit: DEFAULT_RUNTIME_WORKER_WIT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--format") {
      options.format = parseFormat(requiredValue(arg, args[++index]));
    } else if (arg === "--output") {
      options.output = requiredValue(arg, args[++index]);
    } else if (arg === "--runtime-worker-wit") {
      options.runtimeWorkerWit = requiredValue(arg, args[++index]);
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = positiveInteger(requiredValue(arg, args[++index]), arg);
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }

  return options;
}

export function analyzeWacRuntimeWorkerWit(path: string, wit: string): WacRuntimeWorkerWitAnalysis {
  const hasAsyncExport = /\bexport\s+\w+\s*:\s*async\s+func\b/.test(wit);
  const hasAsyncFunctions = /\basync\s+func\b/.test(wit);
  const hasResources = /\bresource\s+\w[\w-]*\b/.test(wit);
  const importedInterfaces = [...wit.matchAll(/^\s*import\s+([\w:-]+)\s*;/gm)]
    .map((match) => match[1])
    .filter((name): name is string => Boolean(name))
    .sort();
  const notes: string[] = [];

  if (hasAsyncExport) {
    notes.push("The worker exports an async function, which is the stock WAC runtime-worker blocker shape.");
  }
  if (hasAsyncFunctions) {
    notes.push("The WIT includes async functions, so the probe should keep tracking stock WAC issue #180.");
  }
  if (hasResources) {
    notes.push("The WIT includes resources, matching the resource-heavy worker shape used by wasmplane.");
  }

  return {
    path,
    hasAsyncExport,
    hasAsyncFunctions,
    hasResources,
    importedInterfaces,
    risk: hasAsyncExport || hasAsyncFunctions || hasResources ? "wasip3-async-resource" : "compatible",
    notes,
  };
}

const nodeCommandRunner: CommandRunner = {
  run(command, args, options) {
    return runCommand(command, args, options?.timeoutMs);
  },
};

function classifyRuntimeWorkerProbe(result: CommandResult): WacMigrationCheck {
  if (result.exitCode === 0) {
    return {
      status: "ready",
      exitCode: result.exitCode,
      reason: "WAC composed the deployable WASIp3 runtime worker successfully.",
      detail: summarizeCommandResult(result),
    };
  }

  if (isKnownWasip3AsyncBlocker(result)) {
    return {
      status: "blocked",
      exitCode: result.exitCode,
      reason: "WAC still blocks on the WASIp3 async worker world tracked by WAC upstream issue #180.",
      detail: summarizeCommandResult(result),
    };
  }

  return {
    status: "failed",
    exitCode: result.exitCode,
    reason: "WAC runtime worker probe failed with an unexpected error.",
    detail: summarizeCommandResult(result),
  };
}

function unknownRuntimeWorkerWitAnalysis(path: string): WacRuntimeWorkerWitAnalysis {
  return {
    path,
    hasAsyncExport: false,
    hasAsyncFunctions: false,
    hasResources: false,
    importedInterfaces: [],
    risk: "compatible",
    notes: ["Runtime worker WIT was not analyzed for this report."],
  };
}

function isKnownWasip3AsyncBlocker(result: CommandResult): boolean {
  const output = `${result.stdout}\n${result.stderr}`;
  return /wac-graph[\s\S]*no entry found for key/.test(output)
    || /no entry found for key/.test(output);
}

function nextActionForStatus(status: WacMigrationStatus): string {
  if (status === "ready") {
    return "Keep the deployable Rust + MoonBit runtime worker on forked `wac plug` and retain `wasm-tools compose` only as a rollback fallback.";
  }
  if (status === "blocked") {
    return "Keep `wasm-tools compose` for the runtime worker and rerun this report after WAC issue #180 changes land.";
  }
  return "Fix the failed WAC canary or unexpected runtime worker probe error before changing the default build.";
}

function summarizeCommandResult(result: CommandResult): string {
  const output = `${result.stdout}\n${result.stderr}`
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-4)
    .join(" | ");
  return output || "no output";
}

function checkRow(name: string, check: WacMigrationCheck): string {
  return `| ${markdownCell(name)} | ${check.status} | ${check.exitCode} | ${markdownCell(check.reason)} | ${
    markdownCell(check.detail)
  } |`;
}

function markdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function parseFormat(value: string): WacMigrationFormat {
  if (value === "json" || value === "markdown") {
    return value;
  }
  throw new Error("--format must be json or markdown");
}

function requiredValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`expected ${flag} <value>`);
  }
  return value;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function runCommand(command: string, args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const exitCode = error ? exitCodeFromError(error) : 0;
      resolve({
        exitCode,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      });
    });
  });
}

function exitCodeFromError(error: unknown): number {
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : 1;
}

async function writeTextFileCreatingParents(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function main(): Promise<void> {
  const options = parseWacMigrationReportArgs(process.argv.slice(2));
  const report = await runWacMigrationProbe({
    runtimeWorkerWit: options.runtimeWorkerWit,
    timeoutMs: options.timeoutMs,
  });
  const output = options.format === "json"
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatWacMigrationMarkdown(report);

  if (options.output) {
    await writeTextFileCreatingParents(options.output, output);
  } else {
    process.stdout.write(output);
  }

  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
