# 常駐 service・manifest・SDK

導入手順は [クイックスタート](getting-started.md)、アプリの実装例は [アプリの作り方](writing-services.md)、
設定項目は [CLI・設定リファレンス](configuration.md)を参照してください。
このページは常駐実行の契約と検証の詳細を説明します。

1つの Wasm instance を保持し、起動時の初期化、要求間で共有するメモリ上の状態、
待機中の非同期処理、終了処理を持つアプリを実行する。
契約は [wasmplane:app/service@0.1.0](../wit/app/lifecycle.wit)。HTTP は標準 WASI 0.3、
独自の追加 interface は `lifecycle.start` と `lifecycle.stop` の2関数である。

## 試す

```sh
just service-test
just app-dev examples/service-rust/app.json
# 別ターミナルから繰り返すと count が増える
curl http://127.0.0.1:8080
```

MoonBit は `just app-dev examples/service-moonbit/app.json`。
両サンプルは `{ "starts": 1, "count": 1, "ticks": 12 }` のような JSON を返す。
`count` は要求ごと、`ticks` は待機中も20msごとのタイマーで増加する。
Ctrl-C で受付を止め、処理済みの応答を送り、`lifecycle:stop` を出力して終了する。

ビルドには Rust の `wasm32-wasip2` target、wit-bindgen 0.62.0、wasm-tools 1.259.0、
MoonBit の async 対応 compiler が必要。MoonBit は `moon 0.1.20260904` で検証した。
Wasm ツールは [installer](../scripts/install-wasm-ci-tools.sh) で導入できる。

## ライフサイクル

```text
load → instantiate → start → [HTTP handler → response body 完了] × N → stop → Store 破棄
                        └──── 待機中も guest の非同期タスクを駆動 ────┘
```

- `start` の成功後に ready を通知する。初期化は世代ごとに1回。
- HTTP handler は body 完了まで直列に呼ぶ。background task は await 点で interleave できる。
- `SIGINT` / `SIGTERM` では新規受付を止め、受信中の body と待機列を含む受付済み要求を処理して `stop` を1回呼ぶ。
- 起動と終了の期限は既定で各10秒。起動期限は instantiate と start の合計で、component の読み込み・コンパイルを含まない。
  終了期限は要求の drain と stop の合計。期限を超えると Store を破棄して非ゼロで終了する。
- handler の trap、実行期限超過、応答 body の失敗は世代全体を終了させる。壊れた Store では stop を呼ばない。
- 要求の期限は受信開始から body 受信、待機列、guest 実行、応答 body 生成を含む。
  待機列で期限切れになった要求と切断済みの未実行要求は guest に渡さない。
  実行を開始した要求はクライアントが切断しても期限内で完了させる。
- 待機中にアプリ全体の要求タイムアウトは掛けない。guest が意図的に待ち続けるサービスを維持できる。

初版の常駐モードは HTTP の要求・応答 body を `runtime.max_body_bytes` の上限内で蓄積する。
SSE、WebSocket、無期限の streaming 応答には対応していない。
`runtime.max_concurrent_requests` は実行中・待機中・body 受信中の要求を制限し、超過は503。
要求 body 超過は413、受信期限超過は408、guest 失敗は500または接続終了になる。
HTTP trailer はこのモードでは転送しない。

通常の `serve` と control-plane node は要求ごとに Store を作る。
常駐モードは `serve --resident`、または manifest の `"mode": "service"` で選ぶ。
メモリ上の状態は再起動で消える。永続化には既存の [celld binding](../examples/durable-counter/README.md)
などを明示的に使う。常駐 instance 自体を Durable Object として永続化する機能は含まない。

## Application manifest v1

```json
{
  "version": 1,
  "mode": "service",
  "component": "target/service.wasm",
  "listen": "127.0.0.1:8080",
  "build": [["just", "build"]],
  "watch": ["src", "wit", "justfile"],
  "runtime": {
    "timeout_ms": 2000,
    "max_concurrent_requests": 64,
    "directories": [{ "host": "data", "guest": "/data", "write": true }]
  },
  "service": { "startup_timeout_ms": 10000, "shutdown_timeout_ms": 10000 }
}
```

`version`、`mode`、`component` は必須。未知のフィールド、未対応の version、空の build argv、
不正な実行制限は起動前に拒否する。`mode` は `command` / `http` / `service`。
`listen` の既定値は `127.0.0.1:8080`。`args` は command に渡す文字列配列。
`runtime` は [RuntimeConfig](standalone-runtime.md#権限と制限) と同じ設定、
`service` の期限は1〜86400000ms。service 以外では lifecycle 設定を使用しない。

component、watch、directory grant の host path は **manifest の親ディレクトリ基準**。
`.wat` component も指定できる。build は argv 配列を順番にそのディレクトリで実行する。
シェル展開は行わない。build はホストの環境を継承し、`runtime.env` は guest に渡す値を指定する。

```sh
wasmplane build app.json  # build commands を実行し、component の存在を確認
wasmplane start app.json  # 既にある component を起動
wasmplane dev app.json    # build → start → 変更検出 → build → stop → start
```

`dev` は manifest を常に監視する。`watch` 省略時は component 自体を監視する。
ファイル内容を100ms間隔で確認し、200ms安定してから再ビルドする。
ディレクトリは再帰的に監視し、`target` / `_build` / `.git` / `node_modules` を除外する。
symlink の参照先は追跡しないため、必要な参照先は `watch` に追加する。

manifest の編集ミスやビルド失敗では旧世代を継続する。ビルド中の編集も次のビルド対象になる。
ビルド成功後は旧世代を停止して新しい instance を起動するため、切り替えには停止時間がある。
新 component のリンク・初期化が失敗した場合はエラーを出し、次の編集を待つ。
guest が異常終了した場合も自動再試行せず、変更を待つ。
終了時はビルドを中断し、Unix ではその process group の子プロセスも終了する。

この manifest は単一のローカル component の実行契約である。
パッケージ取得、registry、dependency resolution、複数 component の composition は含まない。

## SDK と検証

[Rust SDK](../sdk/rust/src/lib.rs) は `Lifecycle` / `HttpHandler`、`export!`、
`json` / `sleep_ms` と WASIp3 API を提供する。サンプルは [service-rust](../examples/service-rust/src/lib.rs)。
標準 HTTP と独自 lifecycle の export を組み合わせ、共有 world と同じ契約を満たす。

[MoonBit SDK](../sdk/moonbit/service.mbt) は JSON 応答、sleep、標準出力の補助関数を提供する。
[build script](../scripts/build-service-moonbit.mjs) が共有 WIT から async bindings を `target/generated` に生成し、
SDK と [app.mbt](../examples/service-moonbit/app.mbt) を接続する。生成済み ABI コードは編集しない。
アプリは `start` / `stop` / `handle` を実装し、バックグラウンド処理には export に渡される TaskGroup を使う。

`just service-test` は両言語のビルドと共通 conformance test を実行する。
初期化回数、状態保持、idle timer、body 受信中を含む drain、直列処理、受付制限、trap、
CPU ループの中断、manifest、dev の再起動とビルド失敗からの回復を検証する。
