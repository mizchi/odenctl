import type { CapabilityPolicy } from "../control-plane/contracts.ts";
import { RuntimeError } from "./errors.ts";

export function enforceRuntimeCapabilities(capabilities: CapabilityPolicy | undefined) {
  if (!capabilities) {
    throw new RuntimeError("policy", "runtime capabilities are required");
  }
  rejectFlag(capabilities.arbitraryFilesystem, "arbitraryFilesystem");
  rejectFlag(capabilities.arbitrarySockets, "arbitrarySockets");
  rejectFlag(capabilities.processSpawn, "processSpawn");

  if (!capabilities.outboundHttp.enabled && capabilities.outboundHttp.allow.length > 0) {
    throw new RuntimeError("policy", "outbound allowlist requires outboundHttp.enabled");
  }
}

function rejectFlag(value: boolean, name: string) {
  if (value !== false) {
    throw new RuntimeError("policy", `${name} is not allowed for workers`);
  }
}
