# wasmplane 利用者ガイド

wasmplane は Wasm component を実行するランタイムです。Rust や MoonBit で書いたアプリを、
コマンド、HTTP サーバー、状態を保持する常駐サービスとして動かせます。
ローカルで使うときは control plane やデータベースの準備は不要です。

初めて使う場合は **[クイックスタート](getting-started.md)** から進めてください。
ランタイムをビルドし、最小の WAT と常駐 HTTP サービスを実行します。

## 目的から探す

| やりたいこと | 読むページ |
| --- | --- |
| インストールしてサンプルを動かす | [クイックスタート](getting-started.md) |
| Rust / MoonBit でサービスを書く | [アプリの作り方](writing-services.md) |
| 起動コマンド、ポート、環境変数、権限を設定する | [CLI・設定リファレンス](configuration.md) |
| 再起動しても残る状態を扱う | [celld Durable Objects を使う](durable-objects.md) |
| 起動できない、変更が反映されない、要求が失敗する | [トラブルシューティング](troubleshooting.md) |
| celld 呼び出しの性能を測る | [ベンチマーク](celld-benchmark.md) |

## 実行モードを選ぶ

| 用途 | コマンド | manifest の mode | 状態と寿命 |
| --- | --- | --- | --- |
| バッチや CLI ツール | `wasmplane run app.wasm` | `command` | 実行して終了します |
| 要求ごとに独立した HTTP 処理 | `wasmplane serve app.wasm` | `http` | 要求ごとに新しい instance を作ります |
| 状態やバックグラウンド処理を持つ HTTP アプリ | `wasmplane serve app.wasm --resident` | `service` | 起動から終了まで1つの instance を保持します |

開発中は `wasmplane dev app.json` でビルドと変更監視をまとめて実行できます。
`app.json` は component の場所、実行モード、ビルドコマンド、権限を記述するファイルです。

ここでいう *component* は、標準 WASI や WIT で定義した関数を公開・利用する Wasm の実行単位です。
ランタイムに渡すのは `.wasm` または `(component ...)` 形式の `.wat` です。
`.rs` / `.mbt` は各言語のツールで component にビルドしてから実行します。
現在、JavaScript / TypeScript の直接実行や Node.js API / npm パッケージの互換機能はありません。

常駐サービスのメモリ上の状態は、再起動すると初期化されます。
HTTP は直列に処理し、要求・応答 body は設定上限内に蓄積します。
継続的な streaming が必要な場合は、要求ごとに独立した `http` モードを検討してください。
その場合も要求の実行期限が適用されます。詳細は [モードごとの制限](configuration.md#実行制限)を参照してください。

## このガイドの範囲

リポジトリ内の Rust バイナリ `wasmplane` を使う手順を説明します。
`pnpm wasmplane` は control plane を操作する別の CLI です。
このガイドのコマンドは、特記しない限りリポジトリのルートで実行してください。

実行エンジンはリポジトリで固定している Wasmtime 48.0.2 です。
利用可能な機能と制限は現在の実装に合わせて記載しています。
内部の動作を調べる場合は [standalone runtime](standalone-runtime.md)、
[service runtime](service-runtime.md)、[設計方針](runtime-direction.md)を参照してください。
