# アプリの作り方

[利用者ガイド](README.md) / アプリの作り方

[クイックスタート](getting-started.md)のサンプルを、自分の HTTP ハンドラーに置き換えます。
ここでは常駐する `service` モードを使います。
SDK は現在このリポジトリ内のものを参照する構成です。

## アプリが実装する3つの処理

| 処理 | 呼ばれるタイミング | 主な用途 |
| --- | --- | --- |
| `start` | サーバーの準備完了を通知する前に1回 | 初期化、バックグラウンド処理の開始 |
| `handle` | HTTP 要求ごと | 要求の処理、応答の生成 |
| `stop` | 通常終了時、受付済みの要求を処理した後に1回 | アプリが管理する処理の終了、後片付け |

`start` がエラーを返すとサービスは起動しません。
`stop` は強制終了や guest の trap 後には呼ばれないため、永続化が必要な更新は
要求の処理中に完了させてください。メモリ上の状態は開発時の再起動でも失われます。

HTTP 要求は1つずつ処理します。ただしバックグラウンドタスクはハンドラーの await 中にも進みます。
await をまたいだ共有状態の変更には、アプリ側で整合性を保つ設計が必要です。

## Rust

[`examples/service-rust/src/lib.rs`](../examples/service-rust/src/lib.rs) を次の内容にすると、
アクセス回数を返す最小の常駐サービスになります。
既存の `Cargo.toml` と `app.json` をそのまま使えます。

```rust
use std::cell::Cell;
use wasmplane_service_sdk::{HttpHandler, Lifecycle, json};
use wasmplane_service_sdk::types::{ErrorCode, Request, Response};

struct App;
wasmplane_service_sdk::export!(App);

thread_local! {
    static COUNT: Cell<u32> = const { Cell::new(0) };
}

impl Lifecycle for App {
    async fn start() -> Result<(), String> {
        println!("started");
        Ok(())
    }

    async fn stop() -> Result<(), String> {
        println!("stopped");
        Ok(())
    }
}

impl HttpHandler for App {
    async fn handle(_request: Request) -> Result<Response, ErrorCode> {
        COUNT.set(COUNT.get() + 1);
        Ok(json(format!("{{\"count\":{}}}", COUNT.get())))
    }
}
```

```sh
wasmplane dev examples/service-rust/app.json
```

`json` は JSON 文字列を応答 body に設定し、`content-type: application/json` を付けます。
値を JSON に変換する関数ではないので、文字列の組み立てやシリアライズはアプリで行います。

パスを使った処理には `request.get_path_with_query()`、応答ステータスの指定には
`response.set_status_code(...)` を使います。標準 WASIp3 の型と API は
`wasmplane_service_sdk::wasip3` と `wasmplane_service_sdk::types` から参照できます。

サンプルの Cargo 設定は次の構成です。

```toml
[lib]
crate-type = ["cdylib"]

[dependencies]
wasmplane-service-sdk = { path = "../../sdk/rust" }
```

`wasm32-wasip2` target で生成された component を実行します。
target 名は `wasip2` ですが、SDK は WASIp3 HTTP と async lifecycle を公開します。
別のディレクトリへ移す場合は SDK の相対パス、manifest の component と watch を合わせて変更します。
リポジトリ内に独立した Cargo パッケージを作る場合は、その `Cargo.toml` に空の `[workspace]` を追加するか、
ルート workspace の `exclude` に追加してください。

## MoonBit

[`examples/service-moonbit/app.mbt`](../examples/service-moonbit/app.mbt) を次の内容に置き換えます。
`moon.pkg.json` と `app.json` はそのまま使えます。

```moonbit
let count : Ref[Int] = { val: 0 }

pub async fn start(_background_group : @async-core.TaskGroup[Unit]) -> Result[Unit, String] {
  @service.log("started")
  Ok(())
}

pub async fn stop(_background_group : @async-core.TaskGroup[Unit]) -> Result[Unit, String] {
  @service.log("stopped")
  Ok(())
}

pub async fn handle(request : @types.Request, _background_group : @async-core.TaskGroup[Unit]) -> Result[@types.Response, @types.ErrorCode] {
  request.drop()
  count.val += 1
  Ok(@service.json("{\"count\":\{count.val}}"))
}
```

```sh
wasmplane dev examples/service-moonbit/app.json
```

`@service` は SDK の補助関数、`@types` は WASI HTTP の型、`@async-core` は
生成された async 実行用の型です。これらの import は既存の `moon.pkg.json` に定義されています。
WASI の resource は使用後に解放します。この例は要求を参照しないため、冒頭で `request.drop()` を呼びます。

ビルド時は `app.mbt` と `moon.pkg.json` を生成先へコピーし、共有 WIT のハンドラーへ接続します。
現在の [build script](../scripts/build-service-moonbit.mjs) がコピーするアプリのファイルはこの2つです。
アプリを複数ファイル・パッケージに分割する場合は、コピー対象と import を含むビルド手順も拡張してください。
実行する成果物は `examples/service-moonbit/target/service.wasm` です。

## タイマーとバックグラウンド処理

Rust は `wasmplane_service_sdk::sleep_ms(100).await`、MoonBit は `@service.sleep_ms(100UL)` で待機できます。
待機中は他の非同期処理を進められます。CPU を回す待ちループは使わず、タイマーを利用してください。

Rust では `wasmplane_service_sdk::wasip3::wit_bindgen::spawn_local`、
MoonBit では `start` に渡された `background_group.spawn_bg` でバックグラウンドタスクを開始します。
共有の終了フラグを `stop` で設定する例は、元の [Rust](../examples/service-rust/src/lib.rs) /
[MoonBit](../examples/service-moonbit/app.mbt) サンプルにあります。
ランタイムは要求のない間もタスクを駆動しますが、アプリが終了するとタスクも破棄されます。

## ファイル・環境変数・外部サービスを使う

ファイル、環境変数、外部への HTTP 接続は [manifest の runtime 設定](configuration.md#権限を設定する)で許可します。
設定で権限を与えたうえで、アプリ側でも必要な WASI interface を import してください。
MoonBit で新しい WASI interface の binding が必要な場合は、
[共有 WIT](../wit/app/lifecycle.wit) と生成手順の変更が必要です。
設定を追加するだけでは、SDK に新しい関数は生成されません。

再起動をまたぐ状態には [celld Durable Objects](durable-objects.md) を利用できます。
Durable Object 用 WIT の import とホストの binding 設定を両方用意します。
現在のサービス用 SDK に Durable Object の補助 API は含まれていません。

## 動作を確認する

```sh
curl http://127.0.0.1:8080
curl http://127.0.0.1:8080
```

上の最小アプリでは、それぞれ `{"count":1}`、`{"count":2}` を返します。
Ctrl-C で `stopped` が出力され、起動し直すと count は1から始まります。

リポジトリに付属する元のサンプルを検証するコマンドは `just service-test` です。
両言語のツールが必要で、元の JSON 形式や検証用エンドポイントを前提にしています。
このページの最小アプリに置き換えた後は、そのアプリに合わせたテストを用意してください。
