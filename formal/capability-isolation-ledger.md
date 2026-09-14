# Capability Isolation Formal Ledger

Scope update: guest service/state bindings were removed with the custom WIT. This ledger covers
control-plane policy relations only. Use runtime integration tests for standard WASI capability enforcement.

source:
  docs / code / tests:
  - Cloudflare Workers isolate/security model: isolates share a runtime process but rely on memory isolation and API-level capability design.
  - Control-plane policy only; the custom guest service/state imports were removed.
  - `src/control-plane/contracts.ts`: `CapabilityPolicy` and capability normalization.
  - `src/control-plane/service.ts`, `src/control-plane/async-service.ts`: deployment-time target validation.
  - `src/control-plane/admission.ts`: production admission guardrails.
  - `crates/oden/src/lib.rs`: Wasmtime host policy enforcement.

tool:
  bounded TypeScript capability relation model

command:
  `pnpm formal:capability-isolation`

model question:
  Can a worker reach another worker/project, state resource, or privileged process capability without an explicit capability binding?

machine result:
  0 current counterexamples. 5 isolation properties are locked as regression checks.

## CI-001 Service Binding Required

expected claim:
  A worker cannot call another worker/project unless `capabilities.services` contains an explicit binding for the target project.

decision:
  design invariant.

implementation:
  The control plane models explicit service grants. The standard WASI node rejects these removed bindings; this model does not establish runtime service reachability.

lock:
  `regression-service-binding-required` and `deployment service bindings explicitly grant cross-project worker calls`.

## CI-002 Explicit Cross-Project Service Binding

expected claim:
  Cross-project worker calls are allowed only when the deployment contract names the target project and service URL.

decision:
  intended capability mechanism.

implementation:
  `CapabilityPolicy.services[]` stores `{ binding, targetProjectId, url }`; control-plane validates the target project exists and admission policy can allowlist project IDs and URL prefixes.

lock:
  `sanity-service-binding-allows-explicit-cross-project-call`.

## CI-003 Outbound HTTP Is Not Worker Access

expected claim:
  Ambient outbound HTTP allowlists do not grant service/worker access in the isolation model.

decision:
  security boundary.

implementation:
  The formal relation ignores `outboundHttp.allow` when deciding service access. This is a control-plane policy relation, not a network isolation proof: WASI HTTP can reach any permitted origin.

lock:
  `regression-outbound-http-is-not-service-access`.

## CI-004 State Resources Stay Project-Scoped

expected claim:
  KV, secret, and durable object bindings cannot become cross-project handles by guessing IDs.

decision:
  tenant isolation invariant.

implementation:
  control-plane deployment validation checks project ownership for KV namespaces, secrets, and durable object namespaces.

lock:
  `regression-state-bindings-remain-project-scoped` and existing cross-project KV/secret/durable tests.

## CI-005 Process Capabilities Denied

expected claim:
  Workers cannot request process spawning, arbitrary sockets, or arbitrary filesystem access.

decision:
  host security invariant.

implementation:
  TypeScript and Rust capability parsers reject privileged capability flags.

lock:
  `regression-privileged-process-capabilities-denied` and `parse_host_policy_rejects_privileged_capabilities`.
