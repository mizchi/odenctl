# トラブルシューティング

[利用者ガイド](README.md) / トラブルシューティング

まず `wasmplane --version` と、サーバーを起動したターミナルのログを確認してください。
以下は standalone の `wasmplane` バイナリを使う場合の対処です。

## コマンド・ビルド

| 症状 | 確認と対処 |
| --- | --- |
| `wasmplane: command not found` | リポジトリのルートで `just rust-build` を実行し、`target/debug/wasmplane` を使います。PATH はターミナルごとに設定します |
| `dev` / `start` が見つからない | `pnpm wasmplane` は control plane 用です。`target/debug/wasmplane --help` を確認してください |
| Rust が古いというビルドエラー | `rustc --version` を確認し、Rust 1.95 以上を使います |
| `wasm32-wasip2` の標準ライブラリが見つからない | `rustup target add wasm32-wasip2` を実行します |
| `--locked` で Cargo.lock の更新を要求される | 依存を変更した場合は、そのアプリのディレクトリで `cargo build --target wasm32-wasip2` を実行し、更新した lockfile を確認します |
| `moon` / `wit-bindgen` / `wasm-tools` が見つからない | [MoonBit の準備](getting-started.md#moonbit-で同じサービスを動かす)を確認します |
| MoonBit で async の構文・生成コードがコンパイルできない | `moon version` と `wit-bindgen --version` を確認します。検証環境は moon 0.1.20260904 / wit-bindgen 0.62.0 です |

## 起動と manifest

`component does not exist` の場合は、`wasmplane build <app.json>` を先に実行します。
`start` はビルドしません。component のパスは manifest の親ディレクトリを基準に確認してください。
MoonBit の実行対象は `target/service.wasm` であり、生成途中の `gen.wasm` ではありません。

`unknown field` や `unsupported manifest version` は、[設定リファレンス](configuration.md)の名前と型を確認します。
manifest には `version: 1`、`mode`、`component` が必要です。
一方、`--config` 用ファイルには `runtime` の中身だけを保存します。2種類の設定ファイルを混同しないでください。

`component must export wasi:cli/run` は、HTTP component を `run` で実行していないか確認します。
`resident service must export wasmplane:app/lifecycle` は、追加の `start/stop` が必要な常駐モードで
通常の HTTP component を実行している可能性があります。
通常の HTTP component には `serve`、サービス SDK の成果物には `serve --resident` または `mode: service` を使います。

`Address already in use` は別のサーバーが同じポートを使用しています。
先に起動したサンプルを Ctrl-C で停止するか、manifest の `listen` / serve の `--addr` を変更します。
Rust と MoonBit の付属サンプルはどちらも `127.0.0.1:8080` を使います。

## dev で変更が反映されない

`dev` は `watch` の対象と manifest を監視します。
ソースが `watch` に含まれているかを確認してください。省略時は component 自体を監視します。
再帰監視から `target` / `_build` / `.git` / `node_modules` は除外し、symlink の参照先も追跡しません。
MoonBit では生成先のファイルを編集せず、元の `app.mbt` を編集します。

`build failed; keeping current generation` は、変更前のアプリが引き続き応答している状態です。
ビルドログのエラーを修正して保存してください。
ビルドには成功したのに `application exited; waiting for changes` と表示される場合は、
その直前のリンク・初期化・guest のエラーを確認します。`dev` は失敗したアプリを自動再起動しません。

## HTTP と終了処理

| 症状 | 確認と対処 |
| --- | --- |
| 常駐サービスから503 | 実行中・待機中・body 受信中の要求数が上限に達しています。遅いハンドラーやクライアント側の並行数を確認します |
| 通常の HTTP モードから503 | 応答 body を消費中の要求も枠を使います。クライアントが body を読み終えるか、不要な body をキャンセルしているか確認します |
| 常駐サービスから413 / 408 | 要求 body のサイズ超過 / 受信期限超過です。`max_body_bytes` / `timeout_ms` を確認します |
| 500、接続終了、`deadline exceeded` | guest のエラーや実行期限超過です。サーバーログを確認します。常駐モードでは実行中 guest の失敗でサービス全体が終了します |
| 途中の body が見えない | 常駐モードは body 全体を蓄積します。streaming が必要なら通常の HTTP モードを使います |
| count が毎回1になる | 通常の `serve` は要求ごとに instance を作ります。状態保持には `--resident` / `mode: service` を使います |
| 再起動すると状態が消える | メモリ上の状態は保存しません。永続化が必要なら [celld](durable-objects.md) などを利用します |
| Ctrl-C 後もすぐに終了しない | 常駐サービスは受付済み要求と stop を待ちます。`service.shutdown_timeout_ms` が全体の上限です |

常駐モードでは handler を直列に実行するので、同時要求数の上限を増やしても同一 instance の処理が並列になるわけではありません。
通常の HTTP モードでは streaming 中の body 超過は途中の切断・body error として現れる場合があります。

## 権限と celld

ファイルを開けないときは `runtime.directories`、ディレクトリの実在、`guest` のパス、`write` を確認します。
外部 HTTP の拒否では、接続先の scheme・host・port が `outbound_origins` と一致しているかを確認します。
環境変数はホストから自動継承しないので、guest に必要な値を `runtime.env` に指定します。

`gateway secret environment variable is missing` は、`token_env` で指定した環境変数を
**wasmplane を起動するターミナル**に設定します。
`runtime.env` に同名の値を入れる設定ではありません。
binding 拒否は `durable` のキー、認証失敗は gateway とホストの token、接続不可は gateway の起動とポートを確認します。
`outcome-unknown` の扱いは [更新の再送と制限](durable-objects.md#更新の再送と制限)を参照してください。

不具合を報告する場合は、再現コマンド、`wasmplane --version`、言語と生成ツールのバージョン、
失敗直前のログ、token などの認証情報を除いた設定を添えてください。
