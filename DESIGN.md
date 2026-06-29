# wasmplane design

この文書は、wasmplane の現時点の設計をまとめる。前提は WASIp3 と
Wasmtime component model で、WIT をプラットフォーム API の契約として扱う。

## Goal

wasmplane は、Cloudflare Workers に近い運用モデルを Wasmtime 上で構成するための
Wasm hosting control plane である。主な目標は次の通り。

- Worker artifact は immutable deployment として登録する
- route は deployment への mutable pointer として扱い、rollback は pointer update にする
- hot path は DB を読まず、runtime-local の compact route snapshot で処理する
- host capability は deny-by-default にし、WIT 経由で明示的に許可する
- `.cwasm` と embedded Wasmtime daemon で cold compile と process spawn のコストを避ける
- control plane と runtime node を分離し、runtime node は水平スケール可能にする

## Architecture

主要コンポーネントは 5 つ。

| component | role |
| --- | --- |
| Control Plane | project, deployment, route, secret, KV namespace, runtime node registry を管理する |
| Artifact Store | Wasm component bytes を digest-addressed に保存する。local file と S3/R2 互換 store を持つ |
| Snapshot Publisher | route graph を compact route snapshot に変換し、runtime node へ配布する |
| Runtime Node | snapshot を保持し、HTTP request を route/deployment に解決し、prepared component を呼ぶ |
| Wasmtime Host Daemon | Rust embedded Wasmtime runtime。`.cwasm` deserialize、component instantiate、WIT host API を実行する |

概念的な request path:

```text
client
  -> runtime node HTTP endpoint
  -> route snapshot lookup
  -> prepared deployment cache
  -> local .cwasm artifact
  -> Wasmtime host daemon POST /invoke
  -> guest component handle(request)
```

control path:

```text
operator/API
  -> control plane
  -> artifact validation/upload
  -> immutable deployment
  -> route pointer update
  -> route snapshot publish
  -> runtime node warmup/materialize/precompile
```

## Contract Layer

WIT が worker と host の境界であり、control plane の deployment contract はこの境界を
破らない。runtime は deployment を受け取る前に、最低限次を検証する。

- runtime backend は Wasmtime
- WASI profile は WASIp3
- world は worker world
- artifact digest は `sha256:*`
- privileged capabilities は false

deployment は次の情報を immutable に持つ。

- project id
- artifact id, location, digest
- WIT world
- runtime backend/version/WASI profile
- resource limits
- capability policy
- secret/KV bindings

route は mutable pointer であり、単一 deployment または weighted targets を指す。
canary と rollback は route target の変更として表現する。

## Control Plane

control plane は write-heavy ではなく、正しさと監査性を優先する。

Repository backend:

- local/dev: SQLite
- production: Postgres

主要データ:

- projects
- deployments
- routes
- artifacts
- secrets
- kv_namespaces
- runtime_nodes
- route_snapshot_publications
- audit events

API token は scoped bearer token を使う。legacy `WASMPLANE_API_TOKEN` は全権限として残し、
production では `WASMPLANE_API_TOKENS` で `read`, `write`, `publish`, `*` を分ける。
mutation は JSONL audit sink に記録できる。

## Artifact Design

artifact は content digest で識別する。local artifact ingestion では component bytes を保存し、
Rust host で Wasm component として validation する。production では S3/R2 互換 store を使う。

runtime node は `file://`, `http://`, `https://`, private `s3://` の materialize に対応している。
private S3/R2 artifact は runtime node が SigV4 GET で取得し、digest 検証後に cache する。
`WASMPLANE_ARTIFACT_BUCKET` が設定されている場合は、異なる bucket の `s3://` artifact を拒否する。

`.cwasm` は user artifact ではない。node-local cache artifact であり、次に強く依存する。

- host binary
- Wasmtime version
- Wasmtime Engine config
- pooling allocator config
- target machine

そのため `.cwasm` cache key には deployment id, artifact digest, Engine variant を含める。
Engine variant は長い config string ではなく短い hash にする。

## Runtime Node

runtime node は snapshot-driven に動く。通常 request path では control plane DB を読まない。

runtime node の責務:

- route snapshot を受け取って validation する
- artifact を materialize し、digest を検証する
- `.cwasm` を node-local cache に precompile する
- HTTP request を route snapshot で deployment に解決する
- deployment capability/limits を host invocation に渡す
- request metrics, structured events, OTLP traces を出す
- concurrency limit を超える request を拒否する
- snapshot warmup の materialize/precompile concurrency を制限する

`RUNTIME_SNAPSHOT_WARMUP=1` の場合、snapshot ACK 前に target deployments を materialize/precompile
する。これにより deploy switch 後の初回 request latency を抑える。warmup work は
`RUNTIME_SNAPSHOT_WARMUP_CONCURRENCY` で bounded queue 化し、snapshot 内の deployment 数が多い時に
runtime node が一斉 compile で詰まるのを避ける。

## Embedded Wasmtime Host Daemon

初期実装は request ごとに Rust CLI process を spawn していた。この方式は単純だが、
process spawn が hot path の支配的なコストになる。現在の production-oriented path は
Rust embedded Wasmtime host daemon である。

daemon の責務:

- shared Wasmtime `Engine` を保持する
- LRU-bounded prepared component cache を保持する
- `.cwasm` を deserialize して instantiate する
- request ごとに fresh `Store` を作る
- WIT host imports を提供する
- admission control で in-flight invoke 数を制御する
- `/stats` と `/metrics` を公開する

意図的に Store/Instance の再利用はまだしない。guest state の漏れを避けるため、
まずは `WorkerPre` cache + fresh Store/Instance per request を基準にしている。
高密度化は Wasmtime pooling allocator で行う。

daemon endpoints:

- `GET /healthz`
- `POST /invoke`
- `GET /stats`
- `GET /metrics`

主な設定:

- `WASMPLANE_WASIP3_HOST_DAEMON=1`
- `WASMPLANE_WASIP3_HOST_DAEMON_PORT`
- `WASMPLANE_WASIP3_HOST_DAEMON_URL`
- `WASMPLANE_WASIP3_HOST_MAX_PREPARED_COMPONENTS`
- `WASMPLANE_WASIP3_HOST_MAX_CONCURRENT_INVOCATIONS`
- `WASMPLANE_WASIP3_POOLING_TOTAL_COMPONENT_INSTANCES`
- `WASMPLANE_WASIP3_POOLING_MEMORY_MB`
- `WASMPLANE_WASIP3_POOLING_TOTAL_CORE_INSTANCES`
- `WASMPLANE_WASIP3_POOLING_TOTAL_MEMORIES`
- `WASMPLANE_WASIP3_POOLING_TOTAL_TABLES`

重要な制約として、pooling allocator を使う daemon に渡す `.cwasm` は、同じ pooling config の
Engine で precompile されている必要がある。runtime backend は daemon mode の compile args と
cache variant を揃える。

## Capability Model

worker は arbitrary filesystem, arbitrary sockets, process spawn, arbitrary env を受け取らない。
host capability は deployment policy として明示的に渡す。

現在の capability:

- outbound HTTP allowlist
- KV namespace binding
- secret binding

outbound HTTP は URL scheme/host/port/path prefix で検証し、redirect 先も再検証する。
private/loopback/link-local address への DNS rebinding は拒否する。HTTPS から HTTP への downgrade
redirect も拒否する。

KV は binding name から physical namespace へ解決する。secret は binding name から secret handle
を開き、`reveal` で host-loaded value を返す。secret value は route snapshot に載せず、API response
にも出さない。

## Limits

deployment limits は runtime と host に渡される。

- wall clock deadline
- memory MB
- request bytes
- response bytes
- subrequest count
- host call count
- cpuMs

`cpuMs` は contract には存在するが、現時点では精密な CPU-time meter ではない。Wasmtime epoch
deadline による wall clock interruption が主な実行時間制御である。

## Deployment And Rollback

deployment flow:

1. artifact bytes を upload/record する
2. artifact digest と component validity を検証する
3. immutable deployment を作る
4. route pointer を deployment に向ける
5. route snapshot を runtime nodes に publish する
6. runtime node が materialize/precompile する

rollback flow:

1. route pointer を old stable deployment に戻す
2. route snapshot を publish する
3. runtime nodes が新 snapshot を反映する

canary は weighted route targets として扱う。control plane は route canary start と rollback を
route mutation として実装する。

## Observability

runtime node:

- worker request metrics endpoint
- structured worker request events
- OTLP/HTTP JSON trace exporter
- heartbeat capacity reporting
- configured host daemon `/stats` payload embedded under runtime metrics `hostDaemon`

host daemon:

- `/stats`: prepared components, active invocations, max concurrency, total/fail/reject, avg latency
- `/metrics`: Prometheus text format

collector:

- OTLP/gRPC `4317`
- OTLP/HTTP `4318`
- spanmetrics connector
- Prometheus metrics `:9464/metrics`
- starter alert rules for runtime error rate and p95 latency

## Scaling Model

runtime node は stateless に近いが、node-local cache を持つ。

node-local state:

- materialized artifact cache
- `.cwasm` cache
- host KV store
- daemon prepared component cache

scale-out は runtime node を増やし、control plane から各 node へ route snapshot を publish する。
Fly.io では each Machine が heartbeat で private URL を登録し、control plane は active runtime nodes
へ直接 snapshot を送る。

Cloudflare Workers の 128MB process を高密度に大量収容する設計に近づけるには、次を組み合わせる。

- Wasmtime pooling allocator
- per-deployment memory limit
- daemon admission control
- prepared component LRU
- route snapshot warmup
- node-local `.cwasm` cache

ただし、現在は isolate/process 相当の粒度を OS process ではなく Wasmtime Store/Instance で表現する。
Store reuse はまだしないため、より安全だが極限の latency は残る。

## Measured Local Performance

ローカル測定条件:

- host binary: release build
- guest component: existing debug component
- machine: darwin/arm64, 10 CPU, Node v24.12.0

主な結果:

- CLI spawn + component: 約 12.6 rps, avg 79ms
- CLI spawn + `.cwasm`: concurrency 16 で約 856 rps, avg 16ms
- runtime prepare cold: 約 40ms
- runtime prepare warm cache: 約 2ms
- cluster CLI spawn path: 約 1.1k rps で頭打ち
- cluster daemon + pooling path: 約 5.6k-6.0k rps
- daemon stats: 6028 invokes, failures 0, rejects 0, host avg invoke 約 0.24ms

解釈:

- `.cwasm` は compile skip に効く
- CLI spawn は hot path の上限を約 1k rps 程度に抑える
- embedded daemon + pooling は process spawn を消し、数倍の throughput と低い p95 を出す
- deploy switch の visible latency は snapshot publish ではなく materialize/precompile/first request が支配的

## Production Deployment Shape

最小 production-ish shape:

- control plane app
- runtime app
- OTEL collector
- Postgres
- S3/R2 artifact store
- runtime persistent volume for cache/KV

Fly.io trial では:

- control app
- runtime app
- collector app
- Fly private networking
- runtime Machine heartbeat
- direct snapshot publish to `*.vm.<app>.internal`

single-region estimate は README の cost estimator にまとめる。現状の前提では、最小というより
ある程度アクセスがある前提の構成で、control/runtime/collector/Postgres を常時起動する。

## Current Limitations

- WASIp3/component model 前提だが、guest toolchain と host ABI の安定性には追従が必要
- `cpuMs` は精密な CPU time enforcement ではない
- secret value lifecycle は最小実装で、KMS/rotation は未実装
- Store/Instance pooling reuse は未実装
- multi-region consistency と routing policy は未実装
- daemon は local HTTP interface で、runtime node と同一 trust boundary 前提
- `.cwasm` cache invalidation は Engine variant hash で分離しているが、Wasmtime upgrade policy は運用手順化が必要

## Next Implementation Priorities

1. KMS-backed secret store and rotation
2. deployment switch benchmark を CI/weekly perf job にする
3. multi-region runtime node registry と region-aware publish
4. Wasmtime upgrade / `.cwasm` cache invalidation playbook
5. stricter CPU metering strategy
