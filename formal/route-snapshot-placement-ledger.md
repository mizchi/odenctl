# Route Snapshot Placement Formal Ledger

source:
  docs / code / tests:
  - `README.md`: runtime placement, Fly production posture, snapshot publication
  - `TODO.md`: runtime node placement, drain, cross-region snapshot consistency
  - `src/http/app.ts`: `publishTargets`
  - `src/control-plane/placement.ts`: placement and tenant isolation filtering
  - `src/control-plane/service.ts`: runtime-node active predicate
  - `tests/placement.test.ts`, `tests/http-api.test.ts`: behavioral locks

tool:
  bounded TypeScript relation/state model

command:
  `pnpm formal:route-placement`

model question:
  Can route snapshot publication preserve placement, tenant isolation, runtime lifecycle, and failover intent for all small configurations in the modeled scope?

machine result:
  0 current counterexamples. 4 historical counterexamples are locked as regression checks.

## RP-001 Static Duplicate Drops Isolated Route

expected claim:
  An isolated project route should be published to the isolation pool runtime selected by placement.

historical witness:
  A static target and the selected isolation node shared `http://runtime.local`. The static target received the default filtered snapshot with no routes, then URL dedupe dropped the registered isolation target that carried `prj_isolated`.

decision:
  bug.

fix:
  `publishTargets` now orders registered placement results before static targets, so URL dedupe keeps the node-specific snapshot.

lock:
  `regression-static-duplicate-keeps-registered-snapshot` and `route snapshot publish keeps registered node snapshot when static target shares its URL`.

## RP-002 Static Target Bypasses Placement

expected claim:
  Project placement policy should constrain all snapshot publish targets for that project.

historical witness:
  `prj_place` was configured for `region=nrt,pool=default`, but static target `http://iad.runtime.local` still received `prj_place` routes.

decision:
  bug.

fix:
  Static targets now receive `staticRouteSnapshotForPlacement`, which removes routes governed by project/default placement or tenant isolation/drain rules.

lock:
  `regression-static-target-filtered-by-placement` and `route snapshot publish filters static targets through placement policy`.

## RP-003 Never-Heartbeated Node Active Under TTL

expected claim:
  When `runtimeNodeActiveTtlMs` is configured, publish targets should have a fresh heartbeat.

historical witness:
  A node registered at `2026-06-26T10:00:00.000Z` with no `lastSeenAt` stayed active at `2026-06-26T12:00:00.000Z` with TTL `60000`.

decision:
  bug.

fix:
  TTL mode now requires `lastSeenAt` in both sync and async control-plane active-node predicates.

lock:
  `regression-ttl-mode-requires-heartbeat` and `runtime node active TTL requires a heartbeat before publish eligibility`.

## RP-004 maxTargets Zero Uses Failover

expected claim:
  A placement tier with `maxTargets: 0` is invalid configuration.

historical witness:
  `prj_zero` had primary `region=nrt,maxTargets=0` and failover `region=iad`; both regions had active nodes, but the model published to `rt_iad`.

decision:
  bug.

fix:
  Placement selection now rejects non-positive `maxTargets` with a validation error before failover can run.

lock:
  `regression-max-targets-zero-rejected` and `placement policy rejects non-positive maxTargets instead of falling through to failover`.

## Sanity Checks

- isolated routes are delivered to an isolation node when there is no duplicate static target.
- drained tenants publish empty snapshots to every active node.
- primary placement is used before failover when a primary target exists.
- saturated runtime nodes are excluded by the active-node predicate.
