# CLI・設定リファレンス

[利用者ガイド](README.md) / CLI・設定リファレンス

[クイックスタート](getting-started.md)でビルドした Rust バイナリ `wasmplane` を使います。

## CLI

| コマンド | 動作 |
| --- | --- |
| `wasmplane --help` | コマンドの概要を表示します |
| `wasmplane --version` | ランタイム、Wasmtime、ビルドの情報を表示します |
| `wasmplane run <component>` | WASI CLI component を1回実行します |
| `wasmplane serve <component>` | 要求ごとに独立した instance で HTTP を処理します |
| `wasmplane serve <component> --resident` | lifecycle を持つ常駐 HTTP サービスを起動します |
| `wasmplane build <app.json>` | manifest のビルドコマンドを順番に実行します |
| `wasmplane start <app.json>` | manifest が指す既存の component を起動します |
| `wasmplane dev <app.json>` | ビルド・起動し、変更を監視して再ビルドします |

`run` / `serve` は `.wasm` と `(component ...)` 形式の `.wat` を受け付けます。
`run` は WASI CLI 0.2 / 0.3、通常の `serve` は WASI HTTP 0.2 / 0.3 に対応します。
`--resident` には追加で `wasmplane:app/lifecycle@0.1.0` の export が必要です。
付属のサービス SDK は WASI HTTP 0.3 を使います。

### component を直接指定するオプション

| オプション | 対象 | 意味 |
| --- | --- | --- |
| `--config runtime.json` | run / serve | 権限と実行制限を指定します |
| `--timeout-ms 5000` | run / serve | 設定ファイルの `timeout_ms` を上書きします |
| `--addr 127.0.0.1:8081` | serve | 待ち受け先。既定は `127.0.0.1:8080` |
| `--resident` | serve | 常駐モードを選びます |
| `-- arg1 arg2` | run | `--` 以降を guest の引数として渡します |

```sh
wasmplane run examples/minimal-command/command.wat --timeout-ms 1000
wasmplane serve examples/service-rust/target/wasm32-wasip2/debug/service_rust.wasm \
  --resident --addr 127.0.0.1:8081
```

`build` / `start` / `dev` は manifest のパスだけを受け付けます。
ポートや実行制限は manifest 内で変更してください。

## Application manifest

JSON ファイルでアプリの実行方法を保存します。たとえばリポジトリのルートに
`command.app.json` を作り、次の内容を保存すると最小 WAT を起動できます。

```json
{
  "version": 1,
  "mode": "command",
  "component": "examples/minimal-command/command.wat"
}
```

```sh
wasmplane start command.app.json
```

| フィールド | 型 | 既定値・用途 |
| --- | --- | --- |
| `version` | 整数 | 必須。現在は `1` |
| `mode` | 文字列 | 必須。`command` / `http` / `service` |
| `component` | 文字列 | 必須。実行する component のパス |
| `listen` | 文字列 | `127.0.0.1:8080`。http / service の待ち受け先 |
| `args` | 文字列配列 | `[]`。command の引数 |
| `build` | 文字列配列の配列 | `[]`。ビルド時に順番に実行する argv |
| `watch` | パスの配列 | 空または省略時は component を監視。manifest 自体は常に監視 |
| `runtime` | オブジェクト | 権限と実行制限。各値の既定値は後述 |
| `service` | オブジェクト | 常駐サービスの起動・終了期限 |

未知のフィールド、未対応の version、不正な実行制限はエラーになります。JSON のコメントは使えません。

### パスとビルド

`component`、`watch`、`runtime.directories[].host` の相対パスは **manifest の親ディレクトリ基準**です。
どのディレクトリから `wasmplane start` を実行しても、同じファイルを参照します。

build コマンドも manifest の親ディレクトリで実行します。たとえば Rust のサンプルは次の設定です。

```json
{
  "version": 1,
  "mode": "service",
  "component": "target/wasm32-wasip2/debug/service_rust.wasm",
  "build": [["cargo", "build", "--locked", "--target", "wasm32-wasip2"]],
  "watch": ["src", "Cargo.toml", "Cargo.lock", "../../sdk/rust"]
}
```

1つの内部配列が1コマンドです。シェルによる `$VAR`、`~`、パイプ、リダイレクトは展開しません。
複数の処理は argv 配列を追加するか、just の recipe / スクリプトにまとめます。
build コマンドはホスト上で動き、ホストの環境変数を継承します。guest の権限設定はビルドには適用されません。

`build` はコマンドの成功と component ファイルの存在を確認します。
component のリンクや guest の初期化は `start` 時に行うため、ビルド成功後に起動が失敗する場合もあります。

### dev の変更監視

`dev` はファイル内容を100ms間隔で確認し、200ms変更がない状態になってから再ビルドします。
`watch` のディレクトリは再帰的に監視しますが、内部の `target` / `_build` / `.git` / `node_modules` は除外します。
symlink の参照先の内容は監視しないため、必要な参照先を `watch` に直接追加してください。

| 変更後の結果 | 実行中のアプリ |
| --- | --- |
| manifest の編集ミス、ビルド失敗 | 現在のアプリを維持し、次の変更を待ちます |
| ビルド成功 | 現在のアプリを終了し、新しい instance を起動します |
| 新しい component のリンク・初期化エラー | エラーを表示し、次の変更を待ちます |
| アプリ自身が正常終了・異常終了 | 自動再起動せず、次の変更を待ちます |

切り替えには停止時間があり、メモリ上の状態はリセットされます。
ビルド中の変更も次のビルド対象になります。
Ctrl-C で終了すると、実行中のアプリを停止し、ビルド中ならビルドを中断します。
Unix ではビルドの process group 内の子プロセスも終了します。

## 権限を設定する

初期状態では、guest にホストの環境変数・ディレクトリ・外部 HTTP 接続・Durable Object binding を渡しません。
必要なものだけ `runtime` に設定します。標準入出力はホストから継承します。

以下は manifest の `runtime` フィールドの**値**として保存する例です。
`--config runtime.json` を使う場合は、このオブジェクト自体を `runtime.json` に保存します。

```json
{
  "timeout_ms": 5000,
  "memory_mb": 128,
  "max_body_bytes": 1048576,
  "max_concurrent_requests": 32,
  "env": { "APP_MODE": "development" },
  "directories": [{ "host": "./data", "guest": "/data", "write": true }],
  "outbound_origins": ["https://example.com"]
}
```

`data` ディレクトリは自動作成しません。manifest と同じディレクトリで `mkdir -p data` を実行してください。
guest からはホストのパスの代わりに `/data` でアクセスします。
`write` を省略するか `false` にすると読み取り専用です。

`--config` 内の `directories[].host` の相対パスは **コマンド実行時の作業ディレクトリ基準**です。
manifest 内の `runtime.directories[].host` とは基準が異なります。

`runtime.env` の値は JSON の文字列をそのまま渡します。`${TOKEN}` などの変数展開はしません。
標準 WASI の任意 socket とプロセス起動は許可しません。
`outbound_origins` は scheme・host・port を指定し、パス、ユーザー情報、query、fragment は含めません。
外部 HTTP の redirect は追跡しません。

## 実行制限

| runtime フィールド | 既定値 | 有効範囲・意味 |
| --- | --- | --- |
| `timeout_ms` | `30000` | 1〜86400000ms。command / HTTP 要求の実行期限 |
| `memory_mb` | `128` | 1〜65536。linear memory ごとの上限（MiB） |
| `max_body_bytes` | `1048576` | 正の整数。要求・応答それぞれの body 上限（byte） |
| `max_concurrent_requests` | `64` | 1〜65536。同時に受け付ける HTTP 要求数 |

`memory_mb` はプロセス全体のメモリ使用量の上限ではありません。
HTTP 接続数も `max(32, max_concurrent_requests * 2)` に制限します。

| 動作 | http / 通常の serve | service / serve --resident |
| --- | --- | --- |
| HTTP handler | 要求ごとの instance で並行実行 | 同一 instance で直列実行 |
| body | 上限付きで stream として転送 | 上限内で全体を蓄積して応答 |
| 要求期限 | instance 作成と処理、応答 body の消費完了まで | body 受信、待機列、実行、応答 body の生成まで |
| 同時要求数の枠 | 応答 body の消費完了まで保持 | body 受信、待機列、実行、応答生成まで保持 |
| guest の trap・実行期限超過 | 当該要求が失敗。他の要求は継続 | 実行中の guest が失敗するとサービス全体を終了 |
| 通常終了 | 要求と接続をキャンセル | 受付を止め、受付済みの要求を処理して stop を呼ぶ |

読み込み・コンパイルは guest の実行期限に含みません。
常駐サービスは待機中に要求タイムアウトでは終了しません。
常駐モードは SSE、WebSocket、無期限の streaming 応答に対応せず、HTTP trailer も転送しません。

常駐サービスの起動と終了は、manifest の `service` に別の期限を指定できます。

```json
{
  "startup_timeout_ms": 10000,
  "shutdown_timeout_ms": 10000
}
```

このオブジェクトを `service` の値として保存します。どちらも既定値は10000ms、有効範囲は1〜86400000msです。
起動期限は instance 作成と start の合計、終了期限は受付済み要求の処理と stop の合計です。
期限超過ではアプリを破棄し、非ゼロの終了コードを返します。
`serve --resident` で直接起動する場合は、これら2つの期限は既定値になります。

Durable Object の設定は [celld Durable Objects を使う](durable-objects.md)、
エラー別の対処は [トラブルシューティング](troubleshooting.md)を参照してください。
