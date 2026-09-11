# celld / WIT ベンチマーク

実 celld に対して、gateway への直接 HTTP と Wasm 内からの WIT 呼び出しを比較する。
`just` がホストと専用ゲストを **release** ビルドし、一時ディレクトリに celld を起動する。
既存 gateway の起動や token 設定は不要。終了・失敗時はプロセスと一時データを削除する。

```sh
pnpm install --frozen-lockfile
WASMPLANE_CELLD_BIN=/absolute/path/to/celld just celld-bench

# 各ケース 1000 回、warmup 100 回、同時実行数 1 / 8 / 32
WASMPLANE_CELLD_BIN=/absolute/path/to/celld just celld-bench \
  --iterations 1000 --warmup 100 --concurrency 1,8,32 \
  --output perf-results/celld-single-object.json

# 同じ負荷を 8 個の object に分散
WASMPLANE_CELLD_BIN=/absolute/path/to/celld just celld-bench \
  --iterations 1000 --warmup 100 --concurrency 1,8 --objects 8 \
  --output perf-results/celld-eight-objects.json
```

celld 0.4.1、Rust（wasm32-wasip2）、Node.js 24+、pnpm、just を使う。
初回は Wasmtime の release ビルドに時間がかかる。ビルド時間と celld 起動時間は計測対象外。

## ケース

| 名前 | 経路 | 操作 |
| --- | --- | --- |
| `gateway.read` | Node.js fetch → gateway → actor | `GET /`、値の読み取り |
| `wit.read` | Wasm → WIT → Rust ホスト → gateway → actor | 同じ読み取り |
| `gateway.increment` | Node.js fetch → gateway → actor | `POST /increment`、transaction による更新 |
| `wit.increment` | Wasm → WIT → Rust ホスト → gateway → actor | 同じ更新 |

すべて同じ `COUNTER` namespace、認証、JSON/base64 envelope と空の request body を使う。
各ケースには新しい object 名を割り当てる。`--objects 1` では単一 actor への集中、
`--objects N` では index 順に N 個へ分散する。指定並行数は待機中を含む最大呼び出し数。
到着率を固定する負荷ではなく、応答が完了したら次を送る方式で測る。
warmup はケース全体の合計回数で、object ごとの回数ではない。

更新の request ID はケース・warmup/本計測・リクエスト index ごとに異なる。
重複排除 record への書き込みも更新コストに含める。
最後に各 object の値を読み、warmup と本計測の更新がすべて反映されたことを確認する。
HTTP/WIT エラー、応答不正、件数不一致はベンチマークを失敗させる。
失敗時は終了コード `1` とエラー詳細を返し、成功レポートは出力しない。自動再送はしない。

## 時間の範囲

- p50/p95/p99・平均・最小・最大: request の組み立てから actor 応答 body の JSON 検証まで。
  WIT 側はゲストの `Instant`、直接 HTTP 側は Node.js の `performance.now()` を使う。
  WIT handle は batch 開始前に `open` して使い回す。
  percentile は nearest rank で求め、小数第3位まで表示する。
- RPS: 成功した本計測リクエスト数 / batch 全体の経過秒数。並行数を掛けた推定値ではない。
  warmup と最後の状態検証は含めない。
- `warmupElapsedMs`: warmup batch の経過時間。p50 等には含めない。
- `processElapsedMs` / 表の `CLI total ms`: WIT ケース全体のプロセス実行時間。
  起動・engine 作成・component 読み込み/コンパイル・instantiate・warmup・本計測・
  状態検証・標準出力・終了を含む。純粋な起動時間や 1 リクエストの latency ではない。

WIT 側はケースごとに Wasm を一度起動し、その中で複数の async `fetch` を進める。
呼び出しごとの CLI 起動や component 再コンパイルは行わない。
ゲストの測定ループは [benchmark.rs](../examples/durable-counter/src/benchmark.rs)、
集計と実行制御は [celld-bench.ts](../src/celld-bench.ts)。

直接 HTTP は Node.js fetch、WIT ホストは reqwest なので、両者の差には HTTP クライアントや
ゲストの JSON 処理・時計呼び出しの差も入る。**WIT だけのオーバーヘッドを測るものではない。**
また、celld dev のローカル SQLite を対象としており、fleet、remote durability、障害時の性能は含まない。

2026-09-11 の celld 0.4.1 / macOS arm64 では、8 object・並行数32・warmup 100・本計測1000の
`wit.read` で HTTP 503 `cell request limit reached` を2回観測した。
celld ログは `cell_overload_refused` / `in_flight=64, limit=64`。クライアントの並行数32に対して
celld の計数が64に達する理由はこのベンチマークでは調査していない。
この条件のスコアは採用せず、成功した単一 object の結果とは分けて扱う。

## オプションと結果

| オプション | 既定値 | 内容 |
| --- | --- | --- |
| `--iterations` | `100` | 各ケースの本計測回数 |
| `--warmup` | `10` | 各ケースの除外する呼び出し回数。`0` も可 |
| `--concurrency` | `1,8` | 同時実行数のリスト |
| `--objects` | `1` | 各ケースで使う object 数 |
| `--timeout-ms` | `60000` | 各ケースの実行期限。WIT のプロセス監視はさらに起動猶予 30 秒 |
| `--format` | `markdown` | 標準出力の `markdown` / `json` |
| `--output` | なし | JSON レポートの保存先。標準出力形式とは独立 |
| `--celld-bin` | 環境変数または `celld` | celld 実行ファイル |
| `--host-bin` | `target/release/wasmplane` | ホスト実行ファイル |
| `--component` | 専用 release ゲスト | ベンチマーク feature でビルドした component |

JSON は schemaVersion `1`。測定条件・件数・エラー数・各統計に加えて Node / Wasmtime / celld の
バージョン、CPU/OS、ホストパス、ゲスト SHA-256 を保存する。token は出力しない。
`perf-results/` は Git 管理外。

通常の Counter サンプルは変更せず使える。ベンチマーク版は Cargo feature `benchmark` を有効にし、
`examples/durable-counter/target/benchmark/` に分けて生成する。
ビルド済みなら `pnpm celld-bench ...` でも実行できる。

## テスト

```sh
# 集計・入力検証・HTTP エラー・warmup/更新 ID の検証
node --experimental-strip-types --test tests/celld-bench.test.ts

# 実 celld + Wasm による小規模な全ケース検証（所要時間の閾値は設けない）
WASMPLANE_CELLD_BIN=/absolute/path/to/celld just celld-bench-test
```
