# celld Durable Objects を使う

[利用者ガイド](README.md) / celld Durable Objects

アプリの再起動後も残したい状態を、別プロセスの celld に保存できます。
Wasm アプリは `wasmplane:durable/objects@0.1.0` の WIT interface から
名前付きの object を開き、非同期の `fetch` で呼び出します。

現在は Wasm が wasmplane 上で動き、Durable Object 本体は celld 上の JavaScript で動きます。
Wasm のメモリをそのまま永続化する機能ではありません。

## Counter を試す

[クイックスタート](getting-started.md)のランタイムに加えて Node.js 24 以上、pnpm 10.33.0、
celld 0.4.1 を PATH に用意します。以下はリポジトリのルートで実行します。

```sh
pnpm install --frozen-lockfile
celld --version
```

初回だけ、gateway の認証情報を含むローカル設定を作ります。
設定済みならこの生成コマンドは省略してください。既存ファイルがある場合は上書きせずエラーになります。

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
```

`wrangler.local.json` と celld のローカルデータ `.celld/` は Git 管理対象外です。
次に gateway を起動します。`pnpm exec` はインストール済みの celld を実行し、ビルドに必要な esbuild も解決します。

```sh
pnpm exec celld dev examples/celld-gateway/wrangler.local.json --port 9876 --no-watch
```

別ターミナルでリポジトリのルートへ移動し、同じ認証情報をホストに設定します。

```sh
export WASMPLANE_GATEWAY_TOKEN="$(node -p 'require("./examples/celld-gateway/wrangler.local.json").vars.WASMPLANE_GATEWAY_TOKEN')"
just durable-counter-build
target/debug/wasmplane run examples/durable-counter/target/wasm32-wasip2/debug/durable_counter_example.wasm \
  --config examples/durable-counter/runtime.example.json -- counter docs-counter increment-1
```

初めて使う object では `{"n":1}` を返します。
同じ引数でもう一度実行すると、同じ request ID の保存済み結果を返し、二重に加算しません。
最後の引数を `increment-2` にすると次の更新になります。
現在の値を読むだけなら request ID を省略します。

```sh
target/debug/wasmplane run examples/durable-counter/target/wasm32-wasip2/debug/durable_counter_example.wasm \
  --config examples/durable-counter/runtime.example.json -- counter docs-counter
```

celld を Ctrl-C で停止し、同じ設定とローカルデータで起動し直しても値が残ります。
WAT からの直接呼び出しも [Counter サンプル](../examples/durable-counter/README.md)で試せます。

## 自分のアプリから呼ぶ

アプリは [Durable Object 用 WIT](../wit/durable/objects.wit) を import し、
`open("counter", "docs-counter")` で handle を取得して `fetch` を呼びます。
Rust の生成設定と呼び出しは [サンプル実装](../examples/durable-counter/src/lib.rs)を参照してください。
現在の Rust / MoonBit サービス用 SDK には、この interface の補助 API は含まれていません。

ホスト側は manifest の `runtime` に次の設定を追加します。
`--config` で使う場合も、これを runtime 設定として保存できます。

```json
{
  "durable": {
    "counter": {
      "endpoint": "http://127.0.0.1:9876",
      "namespace": "COUNTER",
      "token_env": "WASMPLANE_GATEWAY_TOKEN"
    }
  }
}
```

| 名前 | 役割 |
| --- | --- |
| `counter` | Wasm アプリが `open` に渡す binding 名 |
| `docs-counter` | アプリが指定する object 名。同じ binding と名前なら同じ object を呼び出します |
| `endpoint` | gateway の接続先 |
| `namespace` | gateway に登録した Durable Object binding。この例では `COUNTER` |
| `token_env` | ホストが認証 token を読む環境変数名 |

`token_env` の値はホスト環境から読みます。guest 用の `runtime.env` に token を渡す必要はありません。
gateway 宛ての接続は `durable` の設定で許可され、`outbound_origins` への追加は不要です。
複数アプリで状態を分離する場合は、gateway / namespace の割り当ても分けてください。

## 更新の再送と制限

送信後に応答だけが失われると、更新が済んだか分からない `outcome-unknown` になる場合があります。
ランタイムは自動で再送しません。再送するときは object 側で重複排除する契約が必要です。
サンプル Counter は request ID と結果を更新と同じ transaction に保存しています。
単に request ID を付ければ、任意の object で重複排除されるわけではありません。

body の上限は入出力それぞれ `runtime.max_body_bytes` と1 MiBの小さい方です。
接続の期限と同時呼び出し数には runtime の設定を使います。
ローカルの永続化・並行更新・再送時の重複排除は検証しています。
alarm / WebSocket、fleet の所有権移動、remote storage への durability はこのガイドの対象外です。

動作確認は `WASMPLANE_CELLD_BIN=/absolute/path/to/celld just celld-test`、
性能計測は [ベンチマークガイド](celld-benchmark.md)を参照してください。
