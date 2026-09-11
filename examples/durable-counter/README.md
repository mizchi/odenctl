# WIT から celld Durable Objects を呼ぶ

[`wasmplane:durable/objects@0.1.0`](../../wit/durable/objects.wit) を import し、
`open("counter", name)` → `object.fetch(request)` で celld の Counter を呼ぶ。
WIT は guest とホストの契約で、[Rust ホスト実装](../../crates/runtime-core/src/durable.rs) が
認証付き HTTP に変換し、[celld gateway](../celld-gateway/index.js) が対象の actor に転送する。
actor 本体は celld 上の JavaScript。Wasm は standalone runtime 上で動く。

## 起動

リポジトリルートで実行する。Rust、Node.js 24+、pnpm、just と celld 0.4.1 が必要。
`celld` を PATH に入れ、`pnpm install --frozen-lockfile` と `just rust-build` を済ませておく。
celld が使う esbuild は `pnpm exec` 経由で解決する。

初回だけ、token を含むローカル gateway 設定を生成する。
このファイルと celld の `.celld/` は Git 管理対象外。設定が既にあれば再利用する。

```sh
node --input-type=module <<'JS'
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const dir = 'examples/celld-gateway';
const config = JSON.parse(await readFile(`${dir}/wrangler.jsonc`, 'utf8'));
config.vars.WASMPLANE_GATEWAY_TOKEN = randomBytes(32).toString('hex');
await writeFile(`${dir}/wrangler.local.json`, JSON.stringify(config, null, 2), {
  mode: 0o600, flag: 'wx',
});
JS
pnpm exec celld dev examples/celld-gateway/wrangler.local.json --port 9876 --no-watch
```

別ターミナルで、ホスト用 token を同じ設定から読む。guest の環境変数への付与は不要。

```sh
export WASMPLANE_GATEWAY_TOKEN="$(node -p 'require("./examples/celld-gateway/wrangler.local.json").vars.WASMPLANE_GATEWAY_TOKEN')"
```

## WAT を直接実行

```sh
just run examples/durable-counter/counter.wat --config examples/durable-counter/runtime.example.json
echo $? # 0
```

[`counter.wat`](counter.wat) は binding `counter`、object 名 `wat-counter` を使い、
`POST /increment` を request ID `wat-request-1` で送る。何度実行しても同じ更新を再適用しない。
成功時は出力なし・終了コード `0`、adapter エラーまたは actor の HTTP 200 以外は `1`。
名前と request ID は WAT の data segment に固定してある。

このサンプルは WASI CLI 0.3 の非同期エントリを export する。
stackful async と同期 canonical lowering を組み合わせ、ホストの非同期 `fetch` を待つ。
WAT 内の型宣言は上記 WIT の表現で、メモリは例を小さく保つため 64 KiB 固定。
事前の `.wasm` 変換や wasm-tools は不要。

## Rust から同じ WIT を呼ぶ

[`src/lib.rs`](src/lib.rs) は wit-bindgen で生成した `objects::open` と
`object.fetch(...).await` を呼ぶ。binding、object 名、request ID を引数で指定できる。

```sh
just durable-counter-build
target/debug/wasmplane run examples/durable-counter/target/wasm32-wasip2/debug/durable_counter_example.wasm --config examples/durable-counter/runtime.example.json -- counter wat-counter
# {"n":1} — WAT が更新した値。request ID 省略時は GET /。

target/debug/wasmplane run examples/durable-counter/target/wasm32-wasip2/debug/durable_counter_example.wasm --config examples/durable-counter/runtime.example.json -- counter room-1 increment-1
# {"n":1} — ID を変えると次の更新、同じ ID なら保存済みの結果。
```

送信後の応答喪失は `outcome-unknown`。自動再送は行わず、重複排除は actor 側の契約に従う。
この Counter は request ID と結果を更新と同じ SQLite transaction で保存する。

## 結合テスト

```sh
WASMPLANE_CELLD_BIN=/absolute/path/to/celld just celld-test
```

一時環境で実 celld を起動し、WAT と Rust の WIT 呼び出し、並行更新、binding/object の分離、
再起動後の保存、応答喪失時の結果不明と重複排除を検証する。
対象は `open` / `fetch`。alarm、WebSocket、fleet の移動・remote durability は未検証。

## ベンチマーク

```sh
WASMPLANE_CELLD_BIN=/absolute/path/to/celld just celld-bench \
  --iterations 1000 --warmup 100 --concurrency 1,8,32 \
  --output perf-results/celld.json
```

専用ゲストを release ビルドし、一時環境の実 celld に対して直接 HTTP と WIT の読み取り・更新を比較する。
並行数、object 数、計測範囲、結果の解釈は [ベンチマークガイド](../../docs/celld-benchmark.md) を参照。
