# Standalone runtime

初めて使う場合は [利用者ガイド](README.md) と [クイックスタート](getting-started.md)を参照。
このページは実行基盤、control-plane adapter、検証の詳細を扱う。

Wasmtime 48.0.2 を Rust crate `wasmplane-runtime-core` に組み込み、control plane や DB なしで
Wasm component を実行する。runtime node は同じ crate の `node` adapter から標準 WASI HTTP を呼ぶ。
常駐 service、application manifest、watch/rebuild は [service runtime](service-runtime.md) を参照。
JS/TS エンジン、npm module loader、Node.js API 互換層は未実装。

## 起動

Rust stable（Wasmtime 48 の最低要件は 1.95）、Node.js 24+、pnpm、just を使う。
guest の生成・component のテストには次の固定版ツールを使う。

```sh
pnpm install --frozen-lockfile
bash scripts/install-wasm-ci-tools.sh
export PATH="$HOME/.local/bin:$PATH"
just rust-build
target/debug/wasmplane --version
target/debug/wasmplane run ./app.wasm -- arg1 arg2
target/debug/wasmplane run examples/minimal-command/command.wat
target/debug/wasmplane serve ./http.wasm --addr 127.0.0.1:8080 --config runtime.json
```

installer は Wasmtime 48.0.2 / wasm-tools 1.259.0 / wit-bindgen 0.62.0 を導入する。
standalone binary 自体は外部の Wasmtime CLI を呼び出さない。
`just run ./app.wasm` / `just serve ./http.wasm` でも起動できる。

`run` / `serve` は `.wat` の `(component ...)` も直接読み込む。事前のバイナリ変換や
外部ツールは不要。`run` 用には WASI CLI、`serve` 用には WASI HTTP の export が必要。

最小の `.wat` / `.mbt` から試す場合は [minimal-command](../examples/minimal-command/README.md)。
`just minimal-smoke` で両方を `.wasm` component にビルドし、`wasmplane run` で検証できる。

`run` は `wasi:cli/run@0.2` / `@0.3`、`serve` は WASIp2 HTTP proxy / WASIp3 HTTP service を
判別して実行する。command の成功・失敗と `wasi:cli/exit` の終了コードを返す。
SIGINT / SIGTERM で command をキャンセルし、HTTP server は要求と接続を停止して終了する。
component の読み込み・コンパイルは実行 deadline の対象外。command の instance 作成は期限に含む。

## 権限と制限

設定ファイルは任意。省略すると環境変数・preopen directory・outbound HTTP・Durable Object binding
を付与しない。標準入出力はホストから継承する。

```json
{
  "timeout_ms": 30000,
  "memory_mb": 128,
  "max_body_bytes": 1048576,
  "max_concurrent_requests": 64,
  "env": { "APP_MODE": "development" },
  "directories": [{ "host": "./data", "guest": "/data", "write": false }],
  "outbound_origins": ["https://example.com"],
  "durable": {
    "counter": {
      "endpoint": "http://127.0.0.1:9876",
      "namespace": "COUNTER",
      "token_env": "WASMPLANE_GATEWAY_TOKEN"
    }
  }
}
```

- `directories[].host` は実行時の作業ディレクトリを基準に解決する。`write` の既定値は false。
  application manifest 内の `runtime.directories[].host` は manifest の親ディレクトリを基準にする。
- `outbound_origins` は scheme・host・port の一致で認可し、path や認証情報は指定できない。
  redirect は追跡しない。WASI の任意 socket は許可しない。
- `memory_mb` は Wasmtime の **linear memory ごとの上限**。プロセス全体の RSS 制限ではない。
- `timeout_ms` は command または HTTP request 全体（body の送信を含む）の壁時計時間。
  CPU を占有する guest も epoch ごとに yield するため、キャンセルと deadline が進む。
- `max_body_bytes` は入出力それぞれの累積上限。通常の HTTP は全 body を蓄積せず stream として処理する。
  Content-Length 超過は 413、stream 中の超過は body error になる。
- `max_concurrent_requests` は応答 body の消費完了まで占有する。満杯なら 503。
  idle 接続も最大 `max(32, max_concurrent_requests * 2)` に制限する。
- 通常の HTTP は要求ごとに Store を作り、trap 後も他の要求は継続する。応答前の guest failure は 500。
  handler return 後も WASIp3 の body producer を動かし、切断・停止・deadline で回収する。

常駐モードでは body と同時要求枠の扱い、trap 後の終了動作が異なる。
[モードごとの実行制限](configuration.md#実行制限)を参照。

## Control plane からの実行

旧独自 worker WIT と host imports を削除した。deployment の world は
`wasi:http/service@0.3.0`、worldVersion は `0.3.0`。
旧 component と route snapshot は再利用せず、新しい component を build・deploy する。

`wasmplane-wasip3-host` の `compile` / `invoke` / `serve` は標準 WASI HTTP component を扱う
node protocol adapter として継続する。Rust embedding は `node::Wasip3Runtime` の
`*_async` メソッドを使う。同期の自由関数は Tokio の外から呼ぶ CLI 用 wrapper。

- compile 時に標準 HTTP export と全 import を linker で検証する。prepared component の LRU と
  pooling allocator は維持し、request ごとに fresh Store を作る。
- 独自 KV / Secrets / Durable storage / service binding、`--kv-store-dir`、`hostCalls`、
  instance reuse / reset 契約を削除した。旧設定の有効化はエラーになる。
  control-plane 自体の resource 管理 API は残るが、Wasm へのこれらの binding は付与できない。
- outbound allowlist は標準 runtime と同じ HTTP(S) origin 単位。path prefix は受け付けず、
  redirect は追跡しない。`subrequests` は実行ごとの WASI HTTP send 回数を制限する。
- request / response は `requestBytes` / `responseBytes`（省略時は各 1 MiB）で制限する。
  outbound の各 body には両者の小さい方を適用する。
- guest の HTTP body は WASI stream。既存 node JSON protocol と route adapter は応答全体を
  上限内で蓄積する。JSON protocol の body は UTF-8 テキスト。ネットワーク終端まで streaming
  する用途には `wasmplane serve` を使う。
- `cpuMs` / `wallMs` の小さい方を body 完了までの経過時間に適用する。両方未指定なら 30 秒。
  `cpuMs` は I/O 待ちも含む保守的な上限で、kernel CPU 時間ではない。
- キャンセル・trap・deadline で Store と通信を破棄する。cold load/compile は deadline の対象外。
  JSON 出力を保つため node の guest stdout/stdin は継承せず、stderr のみ継承する。

`pnpm wasmplane new --language rust` は `wasip3` crate を使う標準 WASI 雛形を生成する。
独自 WIT の生成は不要。旧 TypeScript component 雛形は削除した。
celld への新しい `wasmplane:durable/objects@0.1.0` は standalone の設定経由で利用する。

## celld Durable Objects

`wit/durable/objects.wit` が `wasmplane:durable/objects@0.1.0` を定義する。
`open(binding, name)` で実行内の resource を取得し、`object.fetch(request)` で actor を呼ぶ。
endpoint、namespace、認証 token はホスト設定で決定し、guest に渡すのは binding 名だけ。
`token_env` はホスト環境から読む。guest の `env` に追加する必要はない。

[durable-counter](../examples/durable-counter/README.md) に接続設定と WAT / Rust の呼び出し例がある。
`counter.wat` は WASI CLI 0.3 の非同期エントリから `fetch` を待ち、直接実行できる。

```sh
just run examples/durable-counter/counter.wat --config examples/durable-counter/runtime.example.json
```

上のコマンドは gateway 起動とホストの `WASMPLANE_GATEWAY_TOKEN` 設定後に実行する。

gateway は celld の公開 Worker listener 上で動き、認証後に
`namespace.get(namespace.idFromName(name)).fetch(...)` を呼ぶ。
`examples/celld-gateway/index.js` は binding allowlist と bearer token を検証する。
fleet の内部 `/do/<ID>` は使わない。別アプリには別 gateway / namespace の割り当てが必要。

gateway protocol は `POST /v1/objects/{namespace}/{encoded-name}/fetch`。
JSON request は `{method, path, headers, body, requestId?}`、response は `{status, headers, body}`。
body は base64、headers は `[name, value][]`。actor の status は外側 200 の envelope に入れ、
gateway の認証エラーと区別する。request / response body はそれぞれ最大 1 MiB。

エラーは binding 拒否、入力不正、接続不可、送信前の deadline、送信後の結果不明に分ける。
送信後の timeout・応答喪失では `outcome-unknown` を返し、自動再送しない。
キャンセルによって actor の更新が rollback される保証はない。
sample counter は request ID と結果を更新と同一 transaction に保存して重複更新を防ぐ。
sample の dedup record は削除しないため、本運用では保持期間と再送期限の契約を追加する。

### ローカル評価

[celld 0.4.1](https://github.com/denoland/celld/releases/tag/v0.4.1) の binary を用意する。
テストは一時ディレクトリ内に認証情報を生成し、celld dev を起動・停止して検証する。

```sh
WASMPLANE_CELLD_BIN=/absolute/path/to/celld just celld-test
```

性能計測は `just celld-bench`。実 celld に対する直接 HTTP / WIT の比較、p50/p95/p99、
RPS と CLI 全体時間を出力する。[測定条件と使い方](celld-benchmark.md)を参照。

手動で試す場合は `examples/celld-gateway/wrangler.jsonc` を同じディレクトリ内の
`wrangler.local.json` に複製し、`vars.WASMPLANE_GATEWAY_TOKEN` にローカル用 token を設定する。
ホストにも同じ token を `WASMPLANE_GATEWAY_TOKEN` として設定する。
`wrangler.local.json` と `.celld/` は Git 管理対象外。

```sh
chmod 600 examples/celld-gateway/wrangler.local.json
pnpm exec celld dev examples/celld-gateway/wrangler.local.json --no-watch
# 別ターミナルで、上記 JSON の durable 設定を runtime.json に保存して実行
just durable-counter-build
target/debug/wasmplane run examples/durable-counter/target/wasm32-wasip2/debug/durable_counter_example.wasm --config runtime.json -- counter room-1 increment-1
# 同じ ID なら同じ結果。ID 省略時は現在の値を読む。
```

確認済み: WAT 直接実行 / Rust の実 WIT 経由の更新、異なる binding/object の分離、並行 increment、
celld dev 再起動後の保存、更新後に応答だけを破棄した場合の結果不明と再送 deduplication。
ここでの永続性はローカル dev storage の検証。fleet の ownership 移動、remote durability gate、
alarm/WebSocket、Wasmtime actor を celld の中で直接実行する構成は未検証。

## 検証コマンド

```sh
just test                        # Node / Rust unit + component contract tests
just standalone-test             # 実 WASIp2 / WASIp3 HTTP、I/O、権限、stream cancellation
just worker-async-test           # 標準 WASI node / daemon の並行 I/O、キャンセル、deadline
just e2e                         # control plane → 標準 WASI HTTP
just sample-rust-moonbit-smoke    # Rust/MoonBit composition（MoonBit と forked wac が必要）
WASMPLANE_CELLD_BIN=/absolute/path/to/celld just celld-test
```

`.cwasm` はローカルの信頼済み compiler が生成した native artifact 専用。
Node 側の binary/config hash に加え、engine が source・lockfile・target・compiler・build flags の
fingerprint を検証する。Wasmtime 42 や異なる host build の cache は再コンパイルする。
standalone CLI は `.wasm` / `.wat` component を読み、任意 `.cwasm` を deserialize しない。
