# route-atlas

GitHub リポジトリの Web フロントエンドコードを解析し、画面一覧・状態バリエーション・画面遷移をグラフとして可視化するサービス。

## 概要

ユーザーが GitHub アカウントでログインし、対象リポジトリを選択すると、Copilot SDK を用いた LLM 解析によって画面構造を抽出し、インタラクティブなグラフとして表示します。

詳細な仕様は [SPEC.md](./SPEC.md) を参照してください。

## 技術スタック

| レイヤー       | 技術                                                        |
| -------------- | ----------------------------------------------------------- |
| フロントエンド | Angular 19+ (standalone components), Angular Material       |
| グラフ描画     | Cytoscape.js                                                |
| バックエンド   | Hono + Node.js 22 (GCP Cloud Run)                           |
| LLM 解析       | GitHub Copilot SDK (`@github/copilot-sdk`)                  |
| 認証           | GitHub OAuth App                                            |
| パッケージ管理 | pnpm workspaces (monorepo)                                  |

## プロジェクト構成

```
route-atlas/
├── frontend/    # Angular SPA
├── backend/     # Hono API サーバー (Node.js)
├── shared/      # 共有 TypeScript 型定義
├── functions/   # Cloudflare Pages Functions (API プロキシ)
└── .claude/     # Claude Code エージェント・スキル
```

## セットアップ

```bash
# 依存関係のインストール
pnpm install

# 開発サーバーの起動 (frontend + backend 同時起動)
pnpm dev

# ビルド
pnpm build

# テスト
pnpm test

# Lint
pnpm lint
```

### 環境変数

`.env.example` を `.env` にコピーし、必要な値を設定してください。

| 変数名                 | 説明                                        |
| ---------------------- | ------------------------------------------- |
| `GITHUB_CLIENT_ID`     | GitHub OAuth App のクライアント ID          |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App のクライアントシークレット |
| `SESSION_SECRET`       | セッション暗号化キー (強力なランダム文字列) |
| `OAUTH_CALLBACK_URL`   | OAuth コールバック URL                      |
| `FRONTEND_ORIGIN`      | フロントエンドのオリジン URL                |
| `ALLOWED_ORIGINS`      | CORS 許可オリジン                           |
| `PORT`                 | バックエンドのポート番号 (デフォルト: 3000) |

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
