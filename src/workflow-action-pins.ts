import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type WorkflowActionPinCommand = "check" | "update";

export interface WorkflowActionPinCliOptions {
  command: WorkflowActionPinCommand;
  verifyRemote: boolean;
  write: boolean;
  workflowDir: string;
}

export interface WorkflowActionPin {
  file: string;
  line: number;
  action: string;
  ref: string;
  versionComment?: string;
}

export interface WorkflowActionPinIssue {
  file: string;
  line: number;
  action: string;
  message: string;
}

export interface WorkflowActionPinAudit {
  ok: boolean;
  pins: WorkflowActionPin[];
  issues: WorkflowActionPinIssue[];
}

export interface WorkflowActionPinChange {
  file: string;
  line: number;
  action: string;
  tag: string;
  before: string;
  after: string;
}

export interface WorkflowActionPinUpdate {
  files: Record<string, string>;
  changes: WorkflowActionPinChange[];
}

export type WorkflowActionPinResolver = (action: string, tag: string) => Promise<string>;

const DEFAULT_WORKFLOW_DIR = ".github/workflows";
const SHA_RE = /^[0-9a-f]{40}$/;
const VERSION_COMMENT_RE = /^v[0-9][^\s]*$/;
const USES_RE = /^(\s*(?:-\s*)?uses:\s*)([^@\s#]+)@([^\s#]+)(?:\s+#\s*(\S+))?(.*)$/;

export function auditWorkflowActionPins(files: Record<string, string>): WorkflowActionPinAudit {
  const pins = parseWorkflowActionPins(files);
  const issues: WorkflowActionPinIssue[] = [];

  for (const pin of pins) {
    if (!SHA_RE.test(pin.ref)) {
      issues.push({
        file: pin.file,
        line: pin.line,
        action: pin.action,
        message: `${pin.action} must be pinned to a full 40-character commit SHA, not ${pin.ref}`,
      });
      continue;
    }
    if (!pin.versionComment || !VERSION_COMMENT_RE.test(pin.versionComment)) {
      issues.push({
        file: pin.file,
        line: pin.line,
        action: pin.action,
        message: `${pin.action} must keep a human-readable version comment like # v6`,
      });
    }
  }

  return { ok: issues.length === 0, pins, issues };
}

export async function verifyWorkflowActionPins(
  files: Record<string, string>,
  resolver: WorkflowActionPinResolver = resolveGitHubActionTagSha,
): Promise<WorkflowActionPinAudit> {
  const audit = auditWorkflowActionPins(files);
  const issues = [...audit.issues];

  if (!audit.ok) {
    return audit;
  }

  for (const pin of audit.pins) {
    const tag = pin.versionComment;
    if (!tag) {
      continue;
    }
    const latestSha = await resolver(pin.action, tag);
    if (latestSha !== pin.ref) {
      issues.push({
        file: pin.file,
        line: pin.line,
        action: pin.action,
        message: `${pin.action}@${tag} moved from ${pin.ref} to ${latestSha}`,
      });
    }
  }

  return { ok: issues.length === 0, pins: audit.pins, issues };
}

export async function updateWorkflowActionPins(
  files: Record<string, string>,
  resolver: WorkflowActionPinResolver = resolveGitHubActionTagSha,
): Promise<WorkflowActionPinUpdate> {
  const audit = auditWorkflowActionPins(files);
  if (!audit.ok) {
    throw new Error(formatWorkflowActionPinIssues(audit.issues));
  }

  const updatedFiles: Record<string, string> = { ...files };
  const changes: WorkflowActionPinChange[] = [];

  for (const pin of audit.pins) {
    const tag = pin.versionComment;
    if (!tag) {
      continue;
    }
    const nextSha = await resolver(pin.action, tag);
    if (nextSha === pin.ref) {
      continue;
    }
    updatedFiles[pin.file] = replacePinLine(updatedFiles[pin.file], pin.line, nextSha);
    changes.push({
      file: pin.file,
      line: pin.line,
      action: pin.action,
      tag,
      before: pin.ref,
      after: nextSha,
    });
  }

  return { files: updatedFiles, changes };
}

export function parseWorkflowActionPinArgs(args: string[]): WorkflowActionPinCliOptions {
  const options: WorkflowActionPinCliOptions = {
    command: "check",
    verifyRemote: false,
    write: false,
    workflowDir: DEFAULT_WORKFLOW_DIR,
  };

  if (args[0] === "check" || args[0] === "update") {
    options.command = args[0];
    args = args.slice(1);
  }

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    switch (flag) {
      case "--verify-remote":
        options.verifyRemote = true;
        break;
      case "--write":
        options.write = true;
        break;
      case "--workflow-dir":
        options.workflowDir = requiredValue(flag, value);
        index += 1;
        break;
      default:
        throw new Error(`unknown workflow action pin option: ${flag}`);
    }
  }

  if (options.command === "update" && !options.write) {
    throw new Error("update requires --write");
  }

  return options;
}

export function formatWorkflowActionPinIssues(issues: WorkflowActionPinIssue[]): string {
  return issues.map((issue) => `${issue.file}:${issue.line}: ${issue.message}`).join("\n");
}

function parseWorkflowActionPins(files: Record<string, string>): WorkflowActionPin[] {
  const pins: WorkflowActionPin[] = [];
  for (const [file, content] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) {
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(USES_RE);
      if (!match) {
        continue;
      }
      const [, , action, ref, versionComment] = match;
      pins.push({
        file,
        line: index + 1,
        action,
        ref,
        versionComment,
      });
    }
  }
  return pins;
}

function replacePinLine(content: string, lineNumber: number, nextSha: string): string {
  const lines = content.split("\n");
  const line = lines[lineNumber - 1];
  const match = line.match(USES_RE);
  if (!match) {
    throw new Error(`cannot replace action pin at line ${lineNumber}`);
  }
  const [, prefix, action, , tag, suffix] = match;
  lines[lineNumber - 1] = `${prefix}${action}@${nextSha} # ${tag}${suffix}`;
  return lines.join("\n");
}

export async function resolveGitHubActionTagSha(action: string, tag: string): Promise<string> {
  const url = `https://github.com/${action}`;
  const { stdout } = await execFileText("git", [
    "ls-remote",
    url,
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  ]);
  const lines = stdout.trim().split("\n").filter(Boolean);
  const peeled = lines.find((line) => line.endsWith(`refs/tags/${tag}^{}`));
  const selected = peeled ?? lines.find((line) => line.endsWith(`refs/tags/${tag}`));
  const sha = selected?.split(/\s+/)[0];
  if (!sha || !SHA_RE.test(sha)) {
    throw new Error(`could not resolve ${action}@${tag}`);
  }
  return sha;
}

async function readWorkflowFiles(workflowDir: string): Promise<Record<string, string>> {
  const entries = await readdir(workflowDir, { withFileTypes: true });
  const files: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(ya?ml)$/.test(entry.name)) {
      continue;
    }
    const path = join(workflowDir, entry.name);
    files[path] = await readFile(path, "utf8");
  }
  return files;
}

async function writeChangedWorkflowFiles(
  currentFiles: Record<string, string>,
  nextFiles: Record<string, string>,
): Promise<void> {
  for (const [file, nextContent] of Object.entries(nextFiles)) {
    if (currentFiles[file] !== nextContent) {
      await writeFile(file, nextContent);
    }
  }
}

function execFileText(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function requiredValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`expected ${flag} <value>`);
  }
  return value;
}

async function main(): Promise<void> {
  const options = parseWorkflowActionPinArgs(process.argv.slice(2));
  const files = await readWorkflowFiles(options.workflowDir);

  if (options.command === "check") {
    const audit = options.verifyRemote
      ? await verifyWorkflowActionPins(files)
      : auditWorkflowActionPins(files);
    if (!audit.ok) {
      console.error(formatWorkflowActionPinIssues(audit.issues));
      process.exitCode = 1;
      return;
    }
    console.log(`checked ${audit.pins.length} pinned workflow action uses`);
    return;
  }

  const update = await updateWorkflowActionPins(files);
  await writeChangedWorkflowFiles(files, update.files);
  if (update.changes.length === 0) {
    console.log("workflow action pins are already up to date");
    return;
  }
  for (const change of update.changes) {
    console.log(`${change.file}:${change.line}: ${change.action}@${change.tag} ${change.before} -> ${change.after}`);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
