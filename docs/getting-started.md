# クイックスタート

[利用者ガイド](README.md) / クイックスタート

まず WAT の最小コマンドを実行し、続いて Rust または MoonBit の HTTP サービスを起動します。
以下は macOS / Linux のシェルでの手順です。

## 必要なツール

| 試す内容 | 必要なもの |
| --- | --- |
| ランタイムのビルドと WAT の直接実行 | Git、Rust / Cargo 1.95 以上、ネイティブビルド用の linker、just |
| Rust のサービス | ランタイムのビルド環境と Rust の `wasm32-wasip2` target |
| MoonBit のサービス | ランタイムのビルド環境と Node.js 24 以上、MoonBit、wit-bindgen、wasm-tools |
| celld 接続・Node を含むテスト | Node.js 24 以上、pnpm 10.33.0、必要に応じて celld 0.4.1 |

Rust と just をインストール済みの環境で始めてください。MoonBit のサンプルは
`moon 0.1.20260904`、wit-bindgen 0.62.0、wasm-tools 1.259.0 で動作を確認しています。
WAT と Rust だけを試す場合、MoonBit や Node.js の準備は不要です。

## 1. ランタイムを用意する

```sh
git clone https://github.com/mizchi/wasmplane.git
cd wasmplane
just rust-build
export PATH="$PWD/target/debug:$PATH"
wasmplane --version
```

バージョン情報に `wasmplane` と `Wasmtime 48.0.2` が表示されれば準備完了です。
初回は Rust の依存関係をビルドするため時間がかかります。
すでに clone している場合は、そのディレクトリで `just rust-build` から実行してください。

`export PATH=...` は現在のターミナルでのみ有効です。
別ターミナルではリポジトリのルートで再実行するか、`target/debug/wasmplane` を指定します。

## 2. 最小の WAT を実行する

```sh
wasmplane run examples/minimal-command/command.wat
echo $?
```

標準出力は空で、終了コード `0` が表示されます。このサンプルは正常終了だけを行います。
`.wat` は直接読めるので、外部の Wasmtime CLI や Wasm 変換ツールは必要ありません。
入力は `(component ...)` 形式です。通常の `(module ...)` だけの WAT は実行対象にできません。

バイナリへの変換や最小の MoonBit コマンドも試す場合は、
[最小サンプルの説明](../examples/minimal-command/README.md)を参照してください。

## 3. Rust の HTTP サービスを起動する

```sh
rustup target add wasm32-wasip2
wasmplane dev examples/service-rust/app.json
```

ビルド後に次のようなログが表示されます。

```text
starting application generation
lifecycle:start
listening on http://127.0.0.1:8080
```

ログは標準出力と標準エラーに分かれるため、表示順は前後する場合があります。
別ターミナルからアクセスします。

```sh
curl http://127.0.0.1:8080
curl http://127.0.0.1:8080
```

応答例です。`ticks` の値は実行時間によって変わります。

```json
{"starts":1,"count":1,"ticks":12}
```

2回目は `count` が `2` になります。`starts` は `1` のままです。
サーバーは同じ instance を保持し、要求のない間もタイマーで `ticks` を増やします。

## 4. 変更して再起動を確認する

[Rust サンプル](../examples/service-rust/src/lib.rs)の応答やログを編集して保存します。
`dev` が変更を検出し、ビルドに成功すると旧サービスを終了して新しいサービスを起動します。
再起動後の最初の要求は `count: 1` に戻ります。

ビルドエラーの場合はログに `build failed; keeping current generation` と表示され、
それまでのサービスは動き続けます。修正して保存すると再びビルドされます。
ビルド成功後の初期化エラーでは新サービスは起動せず、次の変更を待ちます。

終了するにはサーバー側のターミナルで Ctrl-C を押します。
処理中の要求を待ってから `lifecycle:stop` が出力されます。
起動・終了に設定以上の時間がかかった場合の挙動は [実行制限](configuration.md#実行制限)で説明しています。

## MoonBit で同じサービスを動かす

Rust のサーバーを停止してから実行してください。両サンプルの既定ポートは `8080` です。
Node.js 24 以上と MoonBit を PATH に用意し、Wasm ツールを導入します。

```sh
node --version
moon version
bash scripts/install-wasm-ci-tools.sh
export PATH="$HOME/.local/bin:$PATH"
wasmplane dev examples/service-moonbit/app.json
```

installer は Linux x86_64 / macOS arm64 に対応し、固定版の Wasmtime CLI、wasm-tools、
wit-bindgen を `$HOME/.local/bin` に配置します。ランタイム自体は外部の Wasmtime CLI を呼びません。
`moon` は installer に含まれないので、別途用意してください。

Rust と同じ URL、同じ JSON 形式で応答します。
編集するファイルは [app.mbt](../examples/service-moonbit/app.mbt) です。
`target/generated` のファイルはビルドごとに生成するため、直接編集しません。

## ビルド済みのアプリを起動する

変更監視が不要なときは、ビルドと起動を分けます。

```sh
wasmplane build examples/service-rust/app.json
wasmplane start examples/service-rust/app.json
```

`start` はビルドを行いません。ソースを変更した場合は先に `build` を実行してください。
`just app-dev` / `just app-build` / `just app-start` に同じ manifest を渡すこともできます。

次は [アプリの作り方](writing-services.md)でハンドラーを書き、
[CLI・設定リファレンス](configuration.md)でポートや必要な権限を指定します。
