# 最小の CLI component

`wasmplane run` で成功終了するだけのサンプル。標準 `wasi:cli/run@0.2.0` を export し、
host import・環境設定・control plane は不要。標準出力は空、終了コードは `0`。
HTTP service ではないので、`serve` ではなく `run` を使う。

リポジトリのルートで実行する。

## WAT を直接実行

```sh
just run examples/minimal-command/command.wat
```

ビルド済みのランタイムなら、次のコマンドだけで実行できる。

```sh
target/debug/wasmplane run examples/minimal-command/command.wat
echo $? # 0
```

`.wat` はランタイム内で解析するため、事前の `.wasm` 変換や wasm-tools、MoonBit は不要。
入力は `(component ...)` 形式。通常の `(module ...)` だけでは CLI component の契約を満たさない。

## 両サンプルのビルド・実行確認

```sh
just minimal-smoke
```

Rust、Node.js 24+、just、MoonBit、wasm-tools、wit-bindgen が必要。
wasm-tools / wit-bindgen は `scripts/install-wasm-ci-tools.sh` の固定版を PATH に入れる。
MoonBit は `moon 0.1.20260904`、wit-bindgen は `0.62.0` で確認している。

## WAT → Wasm（バイナリを保存する場合）

[`command.wat`](command.wat) は core module を含む Component Model のテキスト形式。

```sh
just rust-build minimal-wat-build
target/debug/wasmplane run examples/minimal-command/target/wat.wasm
echo $? # 0
```

core 関数の `i32.const 0` は WIT `result` の `ok(())` を表す。

## MoonBit → Wasm

アプリ本体は [`command.mbt`](command.mbt) の3行。
[`command.wit`](command.wit) は標準 WASI CLI entry point の最小定義。
binding と MoonBit の package 設定はビルド時に `target/moonbit/` に生成する。

```sh
just rust-build minimal-moonbit-build
target/debug/wasmplane run examples/minimal-command/target/moonbit.wasm
echo $? # 0
```

処理は `.mbt → core Wasm → WIT metadata の付与 → component Wasm`。
実行対象は最後の `target/moonbit.wasm`。Rust guest や WAC は不要。
生成物はすべて Git 管理外の `target/` に置く。
