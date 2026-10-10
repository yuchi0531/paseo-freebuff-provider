# paseo-freebuff-provider

Paseo の provider として [Freebuff](https://freebuff.com) を使うプラグイン。サブスク不要の無料コーディングエージェントを、Paseo のエージェントとして起動できる。

## できること

- provider 一覧に `freebuff` が増え、無料枠のモデル 8 種から選べる
  - MiMo 2.6 Flash / GLM 5.3 Flash / DeepSeek V4.1 Flash (+ Fast) / GPT-6 Luna / MiMo 2.6 Pro / Solar Mini 4 / Solar Pro 4
- テキストプロンプト・画像添付・会話の永続化（リフレッシュ後の復元）に対応
- freebuff CLI と同じ Buffy ハーネスで実行される（ファイル編集・シェル・コード検索・todo 追跡つき）

## 必要なもの

- Paseo daemon >= 0.11.2（`requirements.paseo` 参照）
- daemon 側マシンでの freebuff ログイン。優先順位は以下の通り
  1. プラグイン設定画面の API キー上書き
  2. セッション環境変数 `CODEBUFF_API_KEY`
  3. freebuff CLI のログイン（`~/.config/manicode/credentials.json` の `authToken`）
- OS キーチェーン参照型のログインは daemon から読めないため、上記 1 か 2 を使うこと

## インストール

```bash
paseo plugin install /absolute/path/to/paseo-freebuff-provider
paseo plugin reload freebuff
```

Git から直接入れる場合:

```bash
paseo plugin add git:yuchi0531/paseo-freebuff-provider
```

インストール時に `npm ci --omit=dev` と `node scripts/patch-sdk.cjs` が実行される（`paseo-plugin.json` の `build` 参照）。

## 設定

Paseo アプリの Settings → Plugins → Freebuff から変更できる。

| 項目 | 内容 |
| --- | --- |
| API key override | 空なら CLI ログイン / `CODEBUFF_API_KEY` を使う |
| Default model | 新規セッションの既定モデル |
| Max agent steps | 1 ターンあたりの上限（1–100） |

## 仕組み

- `server/provider.ts` が Paseo の `ProviderRegistration` を実装し、カタログ・セッション・プロンプト・中断・再開を受け持つ。
- 実実行は `@codebuff/sdk` を使う別プロセス `server/runner.cjs` に投げる。Paseo の eval バンドルに SDK を同梱すると Node 専用初期化（tree-sitter wasm、`createRequire(import.meta.url)`、OIDC 相互運用）で壊れるため、分離している。親子間は NDJSON over stdio。
- `server/bridge.ts` が runner プロセスの起動・再起動・リクエスト中継を担当。
- `shared/models.ts` がモデルカタログ、`server/auth.ts` が認証解決、`server/events.ts` が SDK イベント→タイムライン変換。
- `scripts/patch-sdk.cjs` は postinstall / build 時に SDK 内のバンドル破壊箇所へパッチを当てる。`@codebuff/sdk` 更新時は要再確認。

## 開発

```bash
npm install
npm run typecheck
paseo plugin reload freebuff
paseo provider models freebuff
```

ユーザー向け説明は `OVERVIEW.md` を参照。
