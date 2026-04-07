# Screen Graph Generator — 仕様書

GitHub リポジトリの Web フロントエンドコードを解析し、画面一覧・状態バリエーション・画面遷移をグラフとして可視化するサービス。

## 1. プロダクト概要

ユーザーが GitHub アカウントでログインし、対象リポジトリを選択すると、Copilot SDK を用いた LLM 解析によって画面構造を抽出し、インタラクティブなグラフとして表示する。

### 1.1 想定ユーザー

GitHub Copilot のサブスクリプション（Pro 以上）を持つフロントエンド開発者・テックリード。

### 1.2 ユースケース

- 既存プロジェクトの画面構造を俯瞰的に把握する
- 新メンバーのオンボーディング資料として活用する
- リファクタリング前の影響範囲調査に利用する

## 2. 技術スタック

| レイヤー | 技術 |
|---|---|
| フロントエンド | Angular 19+ (standalone components), Angular Material |
| グラフ描画 | Cytoscape.js（Angular ラッパー: ngx-cytoscape or 直接統合） |
| バックエンド | Node.js (Express) |
| LLM 解析 | GitHub Copilot SDK (`@github/copilot-sdk`) |
| 認証 | GitHub OAuth App |
| デプロイ | コンテナ（Docker）、Copilot CLI をサーバーにインストール |

## 3. モデル選定

ユーザーの Copilot プレミアムリクエストクォータを消費するため、コストパフォーマンスを重視して選定する。

| モデル | multiplier | 備考 |
|---|---|---|
| GPT-4.1 | 0x（included） | 有料プランで無制限。プレミアムリクエストを消費しない |
| Claude Sonnet 4 | 1x | コード理解の精度が高い |
| Gemini 2.0 Flash | 0.25x | 最安。単純なルーティング解析向き |

**デフォルトモデル: `gpt-4.1`**

GPT-4.1 は有料 Copilot プランに含まれるモデルであり、プレミアムリクエストを一切消費しない。コード解析タスクに十分な性能を持つため、デフォルトとして採用する。ユーザーが精度を優先したい場合は Claude Sonnet 4 を選択できるオプションを提供する。

## 4. 認証フロー

GitHub OAuth App を利用し、ユーザーのアクセストークンで Copilot SDK と GitHub API の両方を認証する。

```
ブラウザ                      サーバー                    GitHub
  │                             │                          │
  │  ① /auth/github へ遷移      │                          │
  │ ──────────────────────────► │                          │
  │                             │  ② OAuth authorize URL   │
  │ ◄────── redirect ────────── │ ─────────────────────►  │
  │                             │                          │
  │  ③ ユーザーが authorize      │                          │
  │ ─────────────────────────────────────────────────────► │
  │                             │                          │
  │                             │  ④ callback (code)       │
  │ ──────────── redirect ──────────────────────────────── │
  │                             │                          │
  │                             │  ⑤ code → access_token   │
  │                             │ ─────────────────────►  │
  │                             │  ◄── gho_xxxx ────────  │
  │                             │                          │
  │  ⑥ JWT or session 発行      │                          │
  │ ◄────────────────────────── │                          │
```

### 4.1 OAuth App 設定

- Authorization callback URL: `https://{DOMAIN}/api/auth/callback`
- Required scopes: `repo`（private リポジトリ読み取り用）
- トークンプレフィックス `gho_` または `ghu_` が Copilot SDK で使用可能

### 4.2 Copilot SDK 認証

```typescript
import { CopilotClient } from "@github/copilot-sdk";

const client = new CopilotClient({
  githubToken: userAccessToken,   // OAuth で取得したトークン
  useLoggedInUser: false,         // サーバーの CLI credentials を使わない
});
```

ユーザー自身の Copilot サブスクリプションに紐づくクォータが消費される。Copilot サブスクリプションを持たないユーザーには認証後にエラーを返し、サブスクリプションが必要である旨を表示する。

## 5. 解析パイプライン

### 5.1 全体フロー

```
POST /api/analyze
  ├─ ① GitHub API でファイルツリー取得
  ├─ ② フレームワーク検出
  ├─ ③ ルーティング関連ファイルの絞り込み
  ├─ ④ ファイル内容取得
  ├─ ⑤ Copilot SDK セッションで解析（マルチターン）
  └─ ⑥ 構造化 JSON レスポンス返却
```

### 5.2 フレームワーク検出

`package.json` の dependencies から対象フレームワークを判定する。

| フレームワーク | 検出キー | ルーティングファイルパターン |
|---|---|---|
| Next.js (App Router) | `next` | `app/**/page.{tsx,jsx,ts,js}`, `app/**/layout.*` |
| Next.js (Pages Router) | `next` | `pages/**/*.{tsx,jsx,ts,js}` |
| Nuxt | `nuxt` | `pages/**/*.vue` |
| Angular | `@angular/core` | `**/*-routing.module.ts`, `app.routes.ts` |
| React Router | `react-router-dom` | ルーティング定義を含むファイルを走査 |
| Vue Router | `vue-router` | `router/index.{ts,js}` |
| Remix | `@remix-run/react` | `app/routes/**/*` |
| SvelteKit | `@sveltejs/kit` | `src/routes/**/+page.svelte` |

### 5.3 ファイル取得

GitHub REST API を使用してファイル内容を取得する。

```
GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1
GET /repos/{owner}/{repo}/contents/{path}
```

大規模リポジトリへの対応として以下を実施する。

- ツリー API の truncated フラグを検知し、Blob API にフォールバック
- ルーティング関連ファイルのみを絞り込み、不要なファイルを除外
- 1 ファイル 1MB の Contents API 制限を超える場合は Blob API を使用

### 5.4 LLM 解析（マルチターン）

Copilot SDK のセッションを使い、段階的に解析を行う。

**Turn 1: ルート・画面一覧の抽出**

ルーティング定義ファイルを入力し、全ルートの一覧を抽出する。

**Turn 2: 各画面のバリエーション抽出**

各画面コンポーネントのソースコードを入力し、以下の状態バリエーションを特定する。

- ローディング状態
- エラー状態
- 空状態（データなし）
- 認証状態による出し分け（ログイン済み / 未ログイン）
- 権限による出し分け（admin / member 等）
- レスポンシブバリエーション（モバイル / デスクトップ）
- その他の条件分岐レンダリング

**Turn 3: 画面遷移の抽出**

全画面コンポーネントから遷移に関わるコードを特定する。

- `<Link>`, `<a>`, `routerLink`
- `router.push()`, `router.navigate()`, `navigate()`
- `redirect()`, `useNavigate()`
- `window.location` 操作
- フォーム submit 後の遷移

### 5.5 出力スキーマ

```typescript
interface AnalysisResult {
  framework: string;
  screens: Screen[];
  transitions: Transition[];
}

interface Screen {
  id: string;                    // 一意識別子（例: "screen_dashboard"）
  path: string;                  // ルートパス（例: "/dashboard"）
  componentFile: string;         // コンポーネントファイルパス
  label: string;                 // 表示名（例: "ダッシュボード"）
  description: string;           // 画面の説明
  variants: Variant[];           // 状態バリエーション
}

interface Variant {
  id: string;                    // 一意識別子
  label: string;                 // バリエーション名（例: "ローディング中"）
  condition: string;             // 発生条件の説明
  type: VariantType;
}

type VariantType =
  | "loading"
  | "error"
  | "empty"
  | "auth_required"
  | "permission"
  | "responsive"
  | "conditional";

interface Transition {
  id: string;
  from: string;                  // 遷移元 Screen.id
  to: string;                    // 遷移先 Screen.id
  trigger: string;               // トリガーの説明（例: "ログインボタン押下"）
  method: string;                // 遷移方法（例: "router.navigate"）
  condition?: string;            // 遷移条件（任意）
}
```

## 6. API 設計

### 6.1 エンドポイント

| Method | Path | 説明 |
|---|---|---|
| GET | `/api/auth/github` | GitHub OAuth 開始 |
| GET | `/api/auth/callback` | OAuth コールバック |
| GET | `/api/auth/me` | 現在のユーザー情報取得 |
| POST | `/api/auth/logout` | ログアウト |
| GET | `/api/repos` | ユーザーのリポジトリ一覧取得 |
| POST | `/api/analyze` | リポジトリ解析の開始 |
| GET | `/api/analyze/:jobId` | 解析ジョブの状態取得（SSE） |

### 6.2 解析リクエスト

```json
{
  "owner": "octocat",
  "repo": "my-app",
  "branch": "main",
  "model": "gpt-4.1"
}
```

### 6.3 解析レスポンス（SSE）

解析は時間がかかるため、Server-Sent Events でプログレスを返す。

```
event: progress
data: {"step": "detecting_framework", "message": "フレームワークを検出中..."}

event: progress
data: {"step": "fetching_files", "message": "ファイルを取得中 (12/45)..."}

event: progress
data: {"step": "analyzing_routes", "message": "ルートを解析中..."}

event: progress
data: {"step": "analyzing_variants", "message": "バリエーションを解析中..."}

event: progress
data: {"step": "analyzing_transitions", "message": "画面遷移を解析中..."}

event: complete
data: { "screens": [...], "transitions": [...], "framework": "next" }
```

## 7. フロントエンド設計

### 7.1 画面構成

| 画面 | ルート | 説明 |
|---|---|---|
| ログイン | `/login` | GitHub OAuth ログインボタン |
| リポジトリ選択 | `/repos` | リポジトリ一覧とブランチ選択 |
| 解析中 | `/analyze/:jobId` | プログレス表示 |
| グラフ表示 | `/graph/:jobId` | 解析結果のグラフ |

### 7.2 グラフ表示仕様

Cytoscape.js を使用してインタラクティブなグラフを描画する。

**ノード（画面）**

- 画面名とパスをラベルとして表示
- バリエーションはノード内にバッジまたはサブノードとして表示
- フレームワークのレイアウト構造（layouts, nested routes）を視覚的にグルーピング

**エッジ（遷移）**

- 遷移方法（Link / programmatic / redirect）を線種で区別
- トリガー条件をラベルとして表示
- 条件付き遷移は破線で表示

**操作**

- ズーム・パン
- ノードのドラッグによるレイアウト調整
- ノードクリックで詳細パネルを表示（バリエーション一覧、コンポーネントファイルパス、遷移先一覧）
- フィルタリング（特定の遷移タイプのみ表示、特定のバリエーションを持つ画面のハイライト）
- PNG / SVG エクスポート

### 7.3 レイアウトアルゴリズム

Cytoscape.js の `dagre` レイアウトをデフォルトとする。画面遷移の方向性（通常は上から下、または左から右）を考慮し、有向グラフとして見やすい配置を行う。

## 8. サーバー構成

### 8.1 Copilot CLI インストール

サーバーに Copilot CLI をインストールしておく。SDK がプロセスライフサイクルを管理する。

```dockerfile
FROM node:20-slim

# Copilot CLI インストール
RUN pnpm add -g @anthropic/copilot-cli  # ※正式なインストール方法は公式ドキュメント参照

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .

EXPOSE 3000
CMD ["node", "dist/server.js"]
```

### 8.2 同時接続の管理

ユーザーごとに独立した `CopilotClient` インスタンスを生成する。

```typescript
const clients = new Map<string, CopilotClient>();

function getClientForUser(userId: string, token: string): CopilotClient {
  if (!clients.has(userId)) {
    clients.set(userId, new CopilotClient({
      githubToken: token,
      useLoggedInUser: false,
    }));
  }
  return clients.get(userId)!;
}
```

解析完了後はクライアントを破棄し、リソースを解放する。同時解析数の上限を設け（デフォルト: 10）、超過した場合はキューイングする。

### 8.3 セキュリティ

- ユーザーのアクセストークンはサーバーのセッションストアに保持し、暗号化する
- 解析対象のリポジトリはトークンの権限範囲内のもののみ許可する
- 解析結果はジョブ ID で管理し、他ユーザーからアクセスできないようにする

## 9. 制約事項

- Copilot SDK は Public Preview であり、API が変更される可能性がある
- LLM による解析のため、結果の正確性は 100% ではない。特に動的ルーティングや複雑な条件分岐は見落とす可能性がある
- 大規模リポジトリ（ファイル数 1000 以上）では解析時間が長くなり、LLM のコンテキストウィンドウ制限に達する可能性がある
- ユーザーの Copilot プレミアムリクエストクォータを消費するため、使用量の透明性を確保する必要がある

## 10. 将来的な拡張

- 解析結果の永続化とバージョン間の差分表示
- CI/CD 連携による自動更新（PR マージ時に再解析）
- Mermaid / PlantUML 形式でのエクスポート
- コンポーネント依存関係グラフの追加
- モノレポ対応（workspace 内の特定パッケージ指定）
