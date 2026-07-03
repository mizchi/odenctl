# Cloudflare Containers control-plane POC

This POC checks whether the existing wasmplane Docker image can run the control-plane process inside
Cloudflare Containers, with a Worker acting as the public front door.

Cloudflare Containers are configured from Wrangler. The official model binds a `Container` subclass
as a Durable Object and routes requests with `getContainer(...).fetch(request)`. Wrangler builds and
pushes a local Dockerfile during `wrangler deploy`.

## Run

```sh
cd cloudflare/containers-control
pnpm install
pnpm wrangler login
pnpm dev
pnpm deploy
```

After deploy:

```sh
curl https://wasmplane-control-container-poc.<workers-subdomain>.workers.dev/__poc/edge-health
curl https://wasmplane-control-container-poc.<workers-subdomain>.workers.dev/healthz
```

From the repository root, run the smoke harness against the deployed Worker/container pair:

```sh
WASMPLANE_CLOUDFLARE_CONTROL_URL=https://wasmplane-control-container-poc.<workers-subdomain>.workers.dev \
  WASMPLANE_CONTROL_PLANE_TOKEN=... \
  pnpm cloudflare-control-smoke -- \
    --json-output reports/cloudflare-control-smoke.json \
    --markdown-output reports/cloudflare-control-smoke.md
```

The harness verifies the Worker edge health endpoint, container `/healthz` cold-start latency,
local SQLite fallback through `/ops/config`, project/artifact/deployment writes, generated edge
worker release persistence/delete, optional log retrieval with `--logs-url`, report persistence with
`--json-output` and `--markdown-output`, and optional sleep/wakeup persistence with
`--wake-delay-ms`.

The default container config keeps edge-worker deployment in mock mode. It is enough to verify that
the control plane can generate a Cloudflare Worker release record for a wasm deployment without
mutating the Cloudflare account:

```sh
BASE=https://wasmplane-control-container-poc.<workers-subdomain>.workers.dev

curl -sS -X POST "$BASE/projects" \
  -H "content-type: application/json" \
  -d '{"id":"prj_edge","name":"edge"}'

curl -sS -X POST "$BASE/artifacts" \
  -H "content-type: application/json" \
  -d '{
    "id":"art_edge",
    "projectId":"prj_edge",
    "digest":"sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "location":"https://artifacts.example.com/edge.component.wasm",
    "sizeBytes":128
  }'

curl -sS -X POST "$BASE/deployments" \
  -H "content-type: application/json" \
  -d '{
    "id":"dep_edge",
    "projectId":"prj_edge",
    "artifactId":"art_edge",
    "world":"myedge:runtime/worker@0.1.0",
    "runtime":{"backend":"wasmtime","version":"wasmtime-43","wasi":"wasip3"},
    "limits":{"cpuMs":50,"memoryMb":64,"wallMs":1000,"requestBytes":1048576,"subrequests":20,"hostCalls":100,"responseBytes":1048576},
    "capabilities":{"outboundHttp":{"enabled":false,"allow":[]},"kv":[],"durableObjects":[],"secrets":[],"services":[]}
  }'

curl -sS -X POST "$BASE/edge-workers/releases" \
  -H "content-type: application/json" \
  -d '{"projectId":"prj_edge","deploymentId":"dep_edge","scriptName":"wasmplane-edge-demo"}'

curl -sS "$BASE/projects/prj_edge/edge-worker-releases"
curl -sS "$BASE/edge-workers/releases/ewr_..."
curl -sS -X DELETE "$BASE/edge-workers/releases/ewr_...?provider=1&force=1"
```

To upload the generated script for real, set these as Worker/container secrets before deploy:

```sh
WASMPLANE_EDGE_WORKER_DEPLOYER=cloudflare-api
WASMPLANE_CLOUDFLARE_ACCOUNT_ID=...
WASMPLANE_CLOUDFLARE_API_TOKEN=...
WASMPLANE_CLOUDFLARE_WORKERS_DEV_SUBDOMAIN=...
```

Use an account-scoped token limited to Workers script editing for the target account. The generated
Worker currently exposes only `GET /__wasmplane/manifest` and a `501` response for other requests;
WASIp3 execution remains on Wasmtime runtime nodes. Live `mode: "api"` release creation requires a
`publish`-scoped wasmplane API token and is written to the configured audit sink.

## Expected POC results

- `/__poc/edge-health` proves the Worker front door is alive without entering the container.
- `/healthz` proves the container booted the existing `node --experimental-strip-types src/main.ts`.
- `POST /edge-workers/releases` proves the control plane can synthesize a Worker release for a wasm
  deployment, while mock mode keeps provider mutations disabled.
- Local SQLite and local artifact files are under `/tmp`; this is not production-persistent.
- If this works, the next production shape is Workers + Containers + R2/S3-compatible artifacts +
  external Postgres, or a Cloudflare-native rewrite using Workers, Durable Objects, R2, and D1.

## Known gaps

- Container disk should be treated as ephemeral.
- `WASMPLANE_API_TOKEN`, `DATABASE_URL`, and artifact credentials must be configured as Worker
  secrets before this is exposed.
- Live Cloudflare Workers uploads still need a production token-rotation process and provider-side
  rollback policy before they are suitable for production.
- Runtime-node direct snapshot publishing is not solved here; this is control-plane-only.
- The existing Dockerfile is `linux/amd64` compatible but should be measured for cold-start time and
  image size before using this as a production target.
