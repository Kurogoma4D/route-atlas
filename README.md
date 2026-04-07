# route-atlas

GitHub リポジトリの Web フロントエンドコードを解析し、画面一覧・状態バリエーション・画面遷移をグラフとして可視化するサービス。

## 概要

ユーザーが GitHub アカウントでログインし、対象リポジトリを選択すると、Copilot SDK を用いた LLM 解析によって画面構造を抽出し、インタラクティブなグラフとして表示します。

詳細な仕様は [SPEC.md](./SPEC.md) を参照してください。

## 技術スタック

| レイヤー       | 技術                                                  |
| -------------- | ----------------------------------------------------- |
| フロントエンド | Angular 19+ (standalone components), Angular Material |
| グラフ描画     | Cytoscape.js                                          |
| バックエンド   | Hono (Cloudflare Workers)                             |
| LLM 解析       | GitHub Copilot SDK (`@github/copilot-sdk`)            |
| 認証           | GitHub OAuth App                                      |
| デプロイ       | Cloudflare Pages (frontend) + Workers (backend)       |

## セットアップ

```bash
# 依存関係のインストール
pnpm install

# 開発サーバーの起動
pnpm dev

# ビルド
pnpm build
```

## デプロイ

本プロジェクトは Cloudflare にデプロイされます。GitHub Actions による自動デプロイが設定されており、`main` ブランチへの push 時に自動でデプロイされます。

- **フロントエンド**: Cloudflare Pages (`deploy-frontend.yml`)
- **バックエンド**: Cloudflare Workers (`deploy-backend.yml`)

### 必要な GitHub Secrets

| シークレット名          | 説明                                                 |
| ----------------------- | ---------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Cloudflare API トークン (Pages/Workers デプロイ権限) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare アカウント ID                             |

### Cloudflare 側の環境変数 (Workers)

| 変数名                 | 説明                                        |
| ---------------------- | ------------------------------------------- |
| `GITHUB_CLIENT_ID`     | GitHub OAuth App のクライアント ID          |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App のクライアントシークレット |
| `SESSION_SECRET`       | セッション暗号化キー (強力なランダム文字列) |
| `OAUTH_CALLBACK_URL`   | OAuth コールバック URL                      |

これらは `wrangler secret put <変数名>` コマンドまたは Cloudflare ダッシュボードから設定してください。

## Claude Code エージェント

`.claude/` ディレクトリに GitHub Issue の自動実装・レビュー・マージを行うエージェントとスキルが含まれています。

```
.claude/
├── agents/
│   ├── code-reviewer.md       # PR コードレビューエージェント
│   └── issue-implementer.md   # GitHub Issue 実装エージェント
└── skills/
    └── auto-issue-worker/
        └── SKILL.md            # Issue 自動消化スキル
```

### ワークフロー

```
Issue 起票
  ↓
/auto-issue-worker 実行
  ↓
issue-implementer が worktree で実装 → PR 作成
  ↓
code-reviewer がレビュー
  ↓
指摘あり → issue-implementer が修正 → 再レビュー（最大3回）
  ↓
LGTM → squash merge → 次の Issue へ
```

## ライセンス

MIT
