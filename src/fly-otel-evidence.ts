import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

export interface FlyOtelEvidenceOptions {
  collectorApp: string;
  format: "markdown" | "json";
  output?: string;
  commandRunner?: FlyOtelEvidenceCommandRunner;
}

export interface FlyOtelEvidenceReport {
  schemaVersion: 1;
  generatedAt: string;
  ok: boolean;
  collectorApp: string;
  checks: FlyOtelEvidenceCheck[];
  excerpt: string;
}

export interface FlyOtelEvidenceCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export type FlyOtelEvidenceCommandRunner = (
  command: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

export function parseFlyOtelEvidenceArgs(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): FlyOtelEvidenceOptions {
  const options: FlyOtelEvidenceOptions = {
    collectorApp: env.FLY_COLLECTOR_APP ?? "mz-wasmplane-otel-collector",
    format: "markdown",
  };

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--") {
      continue;
    }
    switch (flag) {
      case "--collector-app":
        options.collectorApp = requiredValue(flag, value);
        index += 1;
        break;
      case "--output":
        options.output = requiredValue(flag, value);
        index += 1;
        break;
      case "--format":
        options.format = parseFormat(requiredValue(flag, value));
        index += 1;
        break;
      case "--json":
        options.format = "json";
        break;
      default:
        throw new Error(`unknown fly otel evidence argument ${flag}`);
    }
  }

  return options;
}

export async function runFlyOtelEvidence(options: FlyOtelEvidenceOptions): Promise<FlyOtelEvidenceReport> {
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  let text = "";
  let commandError: string | undefined;
  try {
    const result = await commandRunner("fly", ["logs", "-a", options.collectorApp, "--no-tail"]);
    text = `${result.stdout}\n${result.stderr}`.trim();
  } catch (error) {
    commandError = errorMessage(error);
  }

  const hasEvidence = commandError === undefined && hasOtelRuntimeSpanEvidence(text);
  const checks: FlyOtelEvidenceCheck[] = [
    {
      name: "collector logs include OTEL runtime spans",
      ok: hasEvidence,
      detail: commandError ?? (hasEvidence ? undefined : "no oden runtime span evidence found in collector logs"),
    },
  ];
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ok: checks.every((check) => check.ok),
    collectorApp: options.collectorApp,
    checks,
    excerpt: excerpt(text),
  };
}

export function formatFlyOtelEvidenceMarkdown(report: FlyOtelEvidenceReport): string {
  const lines = [
    "# odenctl Fly OTEL evidence",
    "",
    `generated: ${report.generatedAt}`,
    `collector app: ${report.collectorApp}`,
    `ok: ${report.ok}`,
    "",
    "| check | status | detail |",
    "| --- | --- | --- |",
  ];
  for (const check of report.checks) {
    lines.push(`| ${check.name} | ${check.ok ? "ok" : "failed"} | ${check.detail ?? ""} |`);
  }
  if (report.excerpt) {
    lines.push("", "## Log excerpt", "", "```text", report.excerpt, "```");
  }
  return `${lines.join("\n")}\n`;
}

function hasOtelRuntimeSpanEvidence(text: string): boolean {
  return /(ResourceSpans|ScopeSpans|trace[_ ]?id|Trace ID|Span)/i.test(text)
    && /(oden-runtime|odenctl\.)/i.test(text);
}

function excerpt(text: string): string {
  return text.split(/\r?\n/).slice(-80).join("\n").slice(-4000);
}

async function defaultCommandRunner(command: string, args: string[]) {
  const { stdout, stderr } = await execFileAsync(command, args, { maxBuffer: 8 * 1024 * 1024 });
  return { stdout, stderr };
}

function parseFormat(value: string): "markdown" | "json" {
  if (value === "markdown" || value === "json") {
    return value;
  }
  throw new Error("--format must be markdown or json");
}

function requiredValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`expected value after ${flag}`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const options = parseFlyOtelEvidenceArgs(process.argv.slice(2));
  const report = await runFlyOtelEvidence(options);
  const output = options.format === "json"
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatFlyOtelEvidenceMarkdown(report);
  if (options.output) {
    await writeFile(options.output, output);
  } else {
    process.stdout.write(output);
  }
  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
