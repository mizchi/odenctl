import { spawn } from "node:child_process";
import { mkdtemp, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlaneError } from "./errors.ts";

export interface LocalArtifactValidationInput {
  path: string;
  digest: string;
  location: string;
}

export interface LocalArtifactValidator {
  validate(input: LocalArtifactValidationInput): Promise<void>;
}

export interface Wasip3HostArtifactValidatorOptions {
  hostBin?: string;
}

export function createWasip3HostArtifactValidator(
  options: Wasip3HostArtifactValidatorOptions = {},
): LocalArtifactValidator {
  const hostBin = options.hostBin ?? "target/debug/oden-host";
  return {
    async validate(input) {
      const dir = await mkdtemp(join(tmpdir(), "odenctl-artifact-validation-"));
      const out = join(dir, "component.cwasm");
      try {
        await run(hostBin, ["compile", "--component", input.path, "--out", out]);
      } finally {
        await unlink(out).catch(() => undefined);
      }
    },
  };
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      reject(new ControlPlaneError("validation", `${command} failed to start: ${error.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new ControlPlaneError(
          "validation",
          `${command} rejected local artifact: ${Buffer.concat(stderr).toString("utf8")}`,
        ),
      );
    });
  });
}
