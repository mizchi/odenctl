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

schema migration は `schema_migrations` で管理する。startup は repository initialization で
known migrations を apply し、その後 compiled migration catalog と照合して current/latest version を
検査する。DB が pending migration を持つ場合や、binary が知らない future migration を持つ場合は
startup/check で検出する。

運用コマンドは `pnpm wasmplane migrate check|apply` と `just db-migrate-check|db-migrate-apply`
に集約する。production rollout 前は `just pg-backup` で custom-format `pg_dump` を取得し、
rollback は writer を止めて `just pg-restore` で backup を戻してから前 version の app image を
再 deploy する。down migration は自動化しない。

## Artifact Design

artifact は content digest で識別する。local artifact ingestion では component bytes を保存し、
Rust host で Wasm component として validation する。production では S3/R2 互換 store を使う。

artifact は optional な signature と provenance を持つ。control plane は deployment 作成時に
設定済み verifier で signature を検証し、署名がない/不正な artifact から deployment を作らない。
現実装は digest に対する `sha256-hmac` verifier を内蔵し、将来は KMS-backed signing や Sigstore
verification に差し替えられる contract にしている。provenance は builder, source, revision,
build id を保持し、artifact response と route snapshot に露出する。

runtime node は `file://`, `http://`, `https://`, private `s3://`, `oci://` の materialize に対応している。
private S3/R2 artifact は runtime node が SigV4 GET で取得し、digest 検証後に cache する。
`WASMPLANE_ARTIFACT_BUCKET` が設定されている場合は、異なる bucket の `s3://` artifact を拒否する。
OCI artifact は registry v2 API で manifest を取得し、control plane artifact digest と一致する
layer だけを blob として取得する。`oci://registry/repo@sha256:<digest>` は digest-addressed blob pull
として扱い、private registry は static bearer token または basic auth で接続する。

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
- project-specific concurrency budget を超える request を拒否する
- snapshot warmup の materialize/precompile concurrency を制限する
- node-local artifact / `.cwasm` cache を retention policy で GC する

runtime node registry は node URL/status に加えて region, labels, capacity, current load を持つ。
heartbeat は capacity と active request load を更新する。operator は control-plane API または Admin UI
から node status を `active`, `draining`, `offline` に切り替えられる。status update は last heartbeat
metadata を保持し、maintenance/scale-down 前の drain に使う。control plane は active かつ TTL 内の node
から、draining/offline/stale/saturated node を publish target から除外する。snapshot publish は project
placement policy で region/label rule を評価し、snapshot 内 project の rule に合う registered runtime
nodes の union へ publish できる。
placement rule は ordered `failover` tiers を持てる。primary tier が active target を返す限り fallback
region には publish しない。primary region の node が offline/stale/saturated などで target にならない
場合のみ、failover tiers を順に評価して最初に target を持つ tier へ publish する。
runtime node は Wasmtime backend, WASI profile, runtime version, host version, Engine variant も
registration/heartbeat で広告する。Admin UI はこの metadata を表示し、Wasmtime upgrade 時に
新旧 Engine variant が混在していないか確認できる。

registry の肥大化を避けるため、operator は status と age を指定して古い runtime node entry を GC できる。
default cleanup は offline node のみを対象にし、active node の削除は明示的な status 指定を必要とする。
削除判定の時刻は `lastSeenAt ?? registeredAt` を使う。

runtime node identity は registry に公開 metadata として保存する。node は `keyId` と任意の
transport certificate SHA-256 fingerprint を heartbeat/registration で広告し、control plane は手元の
runtime identity keyring から対応する secret を選んで snapshot publish を HMAC-SHA256 で署名する。
runtime node 側に identity keyring が設定されている場合、`PUT /__runtime/snapshots/routes` は bearer
token だけでなく署名も検証する。key rotation は multi-key keyring 前提で、新 key を両側に追加し、
node の active `keyId` を切り替え、heartbeat 反映後に旧 key を外す。実際の mTLS は Fly private
network や edge proxy の TLS 終端で行い、ここでは application-level proof-of-possession と
certificate fingerprint pinning のための contract を提供する。

runtime cache retention は `WASMPLANE_ARTIFACT_CACHE_DIR` と `WASMPLANE_CACHE_DIR` を対象にする。
GC は max age を超えた file を先に消し、次に directory ごとの max bytes を超えていれば古い file から
削除する。現在 prepared deployment が参照している materialized artifact と `.cwasm` は keep path として
保護し、snapshot switch や warmup 中の hot path を壊さない。GC は runtime management endpoint から
手動実行でき、interval env が設定されている場合は runtime node 内で定期実行する。
`.cwasm` は Engine variant 付き cache key で保存する。variant は host version label, host binary stat,
precompile に使う Wasmtime Engine config から作る。Wasmtime/Cranelift upgrade 後は
`POST /__runtime/cache/invalidate-cwasm` で現在 variant 以外の `.cwasm` を削除できる。prepared component
が参照している `.cwasm` は keep path として保護されるため、drain 中の node で安全に実行できる。

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
- default では request ごとに fresh `Store` / Instance を作る
- WIT host imports を提供する
- admission control で in-flight invoke 数を制御する
- `/stats` と `/metrics` を公開する

Store/Instance reuse は `--experimental-instance-reuse` / `WASMPLANE_WASIP3_EXPERIMENTAL_INSTANCE_REUSE`
で明示的に有効化する実験機能である。成功した invocation の Store/Instance だけを idle pool に戻し、
trap/timeout/error した instance は破棄する。component model は guest memory/global state を自動 reset
しないため、production default は `WorkerPre` cache + fresh Store/Instance per request のままとし、
reuse は stateless worker benchmark 用に限定する。高密度化の標準 path は Wasmtime pooling allocator で行う。

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
にも出さない。control plane は configured secret cipher がある場合、repository persistence 前に
secret value を AES-256-GCM envelope に暗号化する。runtime が repository-backed secrets を読む場合は、
同じ KMS key 設定で envelope を復号してから worker binding に渡す。既存 plaintext secret は移行のため
runtime 側でそのまま読める。envelope には key id を持たせ、復号は configured keyring から key id で
選ぶ。online rotation では新 primary key で暗号化しつつ、旧 key を decrypt-only keyring に残す。
external KMS は command provider 契約で接続し、provider は primary key id と decrypt keyring の JSON を
返す。AWS KMS adapter は KMS ciphertext blob として wrap された data key を起動時に `Decrypt` で
unwrap し、以後は in-memory data keyring で AES-GCM envelope を処理する。

## Limits

deployment limits は runtime と host に渡される。

- wall clock deadline
- memory MB
- request bytes
- response bytes
- subrequest count
- host call count
- cpuMs

`cpuMs` は Wasmtime epoch interruption で enforce する compute budget である。runtime は
`wallMs` と `cpuMs` の短い方を epoch deadline として host に渡し、CPU budget 側で止まった場合は
`cpu_limit` として wall timeout と区別して返す。ただし、これは kernel の CPU time ではなく
epoch tick ベースの協調的な中断なので、厳密な課金単位にはしない。

control plane は project ごとに artifacts, deployments, routes, secrets, KV namespaces の resource
quota を write 前に検査できる。runtime node は global `RUNTIME_CONCURRENCY` に加えて
`RUNTIME_PROJECT_CONCURRENCY_LIMITS=project=count,...` で project ごとの同時実行 budget を持てる。
project budget を超えた request は `503 overloaded` として即時拒否し、他 project の request は同じ
node 上で継続して受け付ける。`RUNTIME_PROJECT_RATE_LIMITS=project=rps[:burst],...` は project ごとの
token bucket request rate limit で、超過 request は `429 rate_limited` として即時拒否する。

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
route mutation として実装する。automatic canary analysis は runtime worker request events を
deployment id で集計し、candidate deployment の sample count, p95 latency, error rate, reject count を
threshold と比較する。threshold を超えた場合は stable target へ rollback し、continue/rollback の
decision を `canary_decisions` history に保存する。

WIT worker world は `world` と明示的な `worldVersion` の両方で deployment と route snapshot に保存する。
runtime node は snapshot load 前に world と worldVersion を検証し、host が対応しない upgrade/downgrade
world を拒否する。

## Observability

runtime node:

- worker request metrics endpoint
- structured worker request events
- bounded worker logs by request/project/deployment
- saturation signals for autoscaling
- OTLP/HTTP JSON trace exporter
- heartbeat capacity reporting
- configured host daemon `/stats` payload embedded under runtime metrics `hostDaemon`

worker logs は runtime node-local の bounded ring buffer に保存する。log entry は timestamp,
request id, host, path, project id, deployment id, level, message を持つ。runtime は invocation
response の optional logs を保存する前に、解決済み secret value と `authorization`, `cookie`,
`token`, `password`, `secret` などの key-value を `[REDACTED]` に置換する。control plane は
`GET /runtime-nodes/:id/logs` を read-scope API として提供し、runtime management token 付きで
対象 node の `GET /__runtime/logs` を proxy する。

autoscaling は runtime heartbeat の `capacity.concurrentRequests` と `load.activeRequests` から
per-node load ratio を計算する。control plane は `GET /autoscaling/signals` で signals を返し、
policy helper が min/max nodes, scale-up threshold, scale-down threshold から desired node count を
決める。scale-up では新 node を `draining` として登録し、current route snapshot を直接 publish/warmup
してから heartbeat で `active` にする。scale-down では低 load node を candidate として選び、route
snapshot publish target から外してから Fly Machines stop などの provider action を実行する。

Fly Machines controller は provider prototype として分離する。Fly Machines API の public base は
`https://api.machines.dev/v1` で、scale-up は `POST /apps/{app}/machines`、scale-down は
`POST /apps/{app}/machines/{id}/stop` を使う。実 production では API rate limit と deploy/update
競合を避けるため、controller は coordination store を通して lease と cooldown を使う。lease は
複数 controller instance の同時 reconcile を防ぎ、cooldown は成功した provider action 後の連続
scale-up/down を抑える。in-memory store は single-process 用で、production では SQLite/Postgres の
durable store に差し替え、`fly_autoscaler_coordination` に lease/cooldown state を残す。
idempotency metadata と provider-side reconciliation audit は次段階の課題である。

## Admin UI

control plane は `GET /admin` で server-rendered HTML の admin UI を提供する。UI は独自の state
model を持たず、active route snapshot, runtime node registry, route snapshot publications,
canary decisions, autoscaling signals を既存 API contract から組み立てる。

画面は projects, routes, deployments, canaries, runtime nodes, autoscaling signals を表示する。
canary start と rollback は HTML form から `POST /admin/routes/canary` と
`POST /admin/routes/rollback` に送られ、control plane の既存 `startRouteCanary` /
`rollbackRoute` を呼ぶ。auth boundary は API と同じで、`GET /admin` は `read` scope、
admin action は `write` scope を要求する。

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

cross-region では route snapshot を primary control plane から regional control-plane replica へ
`PUT /replication/snapshots/routes` で複製する。replica は最新 `generatedAt` の snapshot だけを保持し、
古い snapshot は stale として拒否する。primary の `POST /snapshots/routes/publish` は runtime publish
後に configured replicas へ同じ snapshot を送り、replica ACK の `snapshotId` と `generatedAt` が一致
しない場合は consistency failure として response に含める。これは hot path 用 state の整合性検証であり、
DB multi-writer replication ではない。

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
- `cpuMs` は Wasmtime epoch tick ベースであり、精密な kernel CPU time enforcement ではない
- secret value は local/env KMS envelope encryption、command-provider keyring、AWS KMS wrapped data key adapter に対応したが、GCP/Azure KMS adapter は未実装
- multi-region は route snapshot replication と ACK consistency check に対応したが、durable replica
  snapshot store と DB multi-writer consistency は未実装
- daemon は local HTTP interface で、runtime node と同一 trust boundary 前提
- Wasmtime upgrade は Engine variant hash と runtime cache invalidation で分離するが、multi-node
  rolling upgrade の自動 orchestration は未実装
- snapshot publish は target ごとの retry/timeout と attempt 記録に対応したが、永続 queue と
  dead-letter/replay UI は未実装
- Fly autoscaler lease/cooldown は in-memory/SQLite/Postgres store に対応したが、provider idempotency
  metadata は未実装
- Store/Instance reuse は experimental flag のみで、guest state reset contract は未実装
- weekly perf regression は fixed budget check で、履歴ベースの trend/regression 分析は未実装

## Next Implementation Priorities

1. GCP/Azure KMS adapter
2. Historical perf trend analysis
3. Safe guest reset contract for instance reuse
4. Provider idempotency metadata for autoscaling
5. Durable route snapshot replica store
