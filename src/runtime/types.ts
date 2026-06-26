import type {
  CapabilityPolicy,
  RouteSnapshot,
  RouteSnapshotEntry,
  RuntimeLimits,
  RuntimeSpec,
} from "../control-plane/contracts.ts";

export type { RouteSnapshot, RouteSnapshotEntry };

export interface ArtifactReference {
  id: string;
  digest: string;
  location: string;
}

export interface MaterializedArtifact {
  path: string;
  digest: string;
  location: string;
  verified: boolean;
}

export interface ArtifactStore {
  materialize(artifact: ArtifactReference): Promise<MaterializedArtifact>;
}

export interface CompileComponentRequest {
  deploymentId: string;
  projectId: string;
  world: RouteSnapshotEntry["world"];
  runtime: RuntimeSpec;
  limits: RuntimeLimits;
  capabilities: CapabilityPolicy;
  artifact: MaterializedArtifact;
}

export interface CompiledComponent {
  deploymentId: string;
  backend: "wasmtime";
  componentPath: string;
  precompiledPath: string;
  cached: boolean;
}

export interface RuntimeBackend {
  compileComponent(request: CompileComponentRequest): Promise<CompiledComponent>;
}

export interface InvokeComponentRequest {
  deploymentId: string;
  component: CompiledComponent;
  method: string;
  uri: string;
  headers: RuntimeHeader[];
  body: Uint8Array;
}

export interface InvokeComponentResponse {
  status: number;
  headers: RuntimeHeader[];
  body: Uint8Array;
}

export interface RuntimeHeader {
  name: string;
  value: string;
}

export interface RuntimeInvoker {
  invoke(request: InvokeComponentRequest): Promise<InvokeComponentResponse>;
}

export interface RouteMatchInput {
  host: string;
  path: string;
}

export interface CommandRunner {
  run(command: string, args: string[], options?: CommandOptions): Promise<CommandResult>;
}

export interface CommandOptions {
  timeoutMs?: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}
