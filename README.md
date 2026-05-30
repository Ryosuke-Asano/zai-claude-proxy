# Z.AI Claude Proxy

Claude Desktop / Claude Code で Z.AI の GLM モデルを利用するための最小プロキシ。

Claude Code は Claude 系モデル名（`claude-sonnet-4-6` 等）のみを受け付ける仕様がありますが、このプロキシが **モデル名を透過的に GLM にマッピング** することで、Z.AI の GLM モデルを Claude Code から利用できます。

## 仕組み

```
Claude Code / Claude Desktop
       │
       │  Anthropic Messages API（model: claude-sonnet-4-6）
       ▼
  proxy.mjs (:3334)
       │  ┌ model: claude-sonnet-4-6 → GLM-5.1
       │  └ response の model: GLM-5.1 → claude-sonnet-4-6
       ▼
  api.z.ai/api/anthropic（Z.AI Anthropic 互換エンドポイント）
```

Z.AI はすでに Anthropic Messages API 互換のエンドポイントを提供しているため、**モデル名の置換だけ**を行う透過プロキシで十分です。Command Code Proxy のような複雑な SSE 形式変換は不要です。

## 必要要件

- Node.js 18+
- Z.AI API キー（[z.ai](https://z.ai) で取得）

## クイックスタート

```bash
# 1. プロキシを起動
node proxy.mjs
```

起動すると `http://localhost:3333` でリッスンします。

## Claude Code の設定

`~/.claude/settings.json` に以下を追加:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:3333",
    "ANTHROPIC_AUTH_TOKEN": "<your Z.AI API key>"
  }
}
```

新しいターミナルウィンドウで `claude` を起動し、`/status` でモデルが認識されていることを確認してください。

## モデルマッピング

デフォルトのマッピング:

| Claude モデル名 | Z.AI GLM モデル |
|---|---|
| `claude-opus-4-8` | `GLM-5.1` |
| `claude-opus-4-7` | `GLM-5.1` |
| `claude-opus-4-6` | `GLM-5.1` |
| `claude-sonnet-4-7` | `GLM-5.1` |
| `claude-sonnet-4-6` | `GLM-5.1` |
| `claude-sonnet-4-5-20250929` | `GLM-4.7` |
| `claude-haiku-4-5-20251001` | `GLM-4.5-Air` |

マッピングを変更するには `proxy.mjs` 内の `MODEL_MAP` を編集してください。

## 環境変数

| 変数名 | デフォルト | 説明 |
|---|---|---|
| `ZAI_PROXY_PORT` | `3333` | リッスンポート |
| `ZAI_API_URL` | `https://api.z.ai/api/anthropic` | 上流 API URL |

## エンドポイント

| メソッド | パス | 説明 |
|---|---|---|
| `GET` | `/health` | ヘルスチェック |
| `GET` | `/v1/models` | モデル一覧 |
| `POST` | `/v1/messages` | Anthropic Messages API（SSE ストリーミング対応） |
