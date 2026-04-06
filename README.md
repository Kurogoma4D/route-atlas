# claude-code-kickstarter

Claude Code の `.claude/` ディレクトリのテンプレート集。GitHub Issue の自動実装・レビュー・マージを行うエージェントとスキルを提供します。

## 含まれるファイル

```
.claude/
├── agents/
│   ├── code-reviewer.md       # PR コードレビューエージェント
│   └── issue-implementer.md   # GitHub Issue 実装エージェント
└── skills/
    └── auto-issue-worker/
        └── SKILL.md            # Issue 自動消化スキル
```

## セットアップ

1. `.claude/` ディレクトリをプロジェクトルートにコピー
2. 各ファイル内のプレースホルダを自分のプロジェクトに合わせて置換

## プレースホルダ一覧

| プレースホルダ | 説明 | 記入例 |
|---|---|---|
| `{{PROJECT_NAME}}` | プロジェクト名 | `my-app` |
| `{{PROJECT_DESCRIPTION}}` | プロジェクトの簡潔な説明 | `a web application built with Next.js` |
| `{{PROJECT_SHORT_DESCRIPTION}}` | 1行のプロジェクト概要（auto-issue-worker 用） | `my-app is a Next.js web application for task management.` |
| `{{GITHUB_OWNER}}` | GitHub オーナー名（ユーザー or 組織） | `octocat` |
| `{{GITHUB_REPO}}` | GitHub リポジトリ名 | `my-app` |
| `{{PROJECT_STRUCTURE}}` | プロジェクトのディレクトリ構造やモジュール構成の説明 | 下記参照 |
| `{{KEY_DEPENDENCIES}}` | 主要な依存ライブラリのリスト | `React, Next.js, Prisma, Tailwind CSS` |
| `{{LANGUAGE_VERSION_NOTE}}` | 言語バージョンや特筆すべき言語機能の説明 | `**TypeScript**: 5.4+ with strict mode enabled.` |
| `{{TECH_STACK}}` | 技術スタックの箇条書き（issue-implementer 用） | 下記参照 |
| `{{LANGUAGE_SPECIFIC_REVIEW_CRITERIA}}` | 言語固有のレビュー観点（code-reviewer 用） | 下記参照 |
| `{{LANGUAGE_SPECIFIC_REVIEW_RULES}}` | 言語固有のレビュールール（code-reviewer 用） | 下記参照 |
| `{{LANGUAGE_SPECIFIC_IMPLEMENTATION_GUIDELINES}}` | 言語固有の実装ガイドライン（issue-implementer 用） | 下記参照 |
| `{{QA_COMMANDS}}` | QA で実行するコマンド一覧（issue-implementer 用） | 下記参照 |

## プレースホルダの記入例

### `{{PROJECT_STRUCTURE}}`

```markdown
Cargo workspace project with the following crate structure:
- `crates/core/` — Core business logic
- `crates/api/` — REST API server
- `crates/db/` — Database access layer
- `src/` — Binary entry point
```

### `{{TECH_STACK}}`

```markdown
- **Language**: TypeScript 5.4+
- **Framework**: Next.js 14 (App Router)
- **Database**: PostgreSQL + Prisma ORM
- **Styling**: Tailwind CSS
- **Testing**: Vitest + Playwright
- **Package manager**: pnpm
```

### `{{LANGUAGE_SPECIFIC_REVIEW_CRITERIA}}`

TypeScript の場合:

```markdown
- **Type safety**: Are types properly defined? No `any` unless justified. Prefer `unknown` over `any`.
- **Null handling**: Are nullable values handled with optional chaining or null checks?
- **Async correctness**: Are Promises properly awaited? No floating promises.
- **React patterns** (if applicable): Are hooks rules followed? Are effects properly cleaned up?
```

Rust の場合:

```markdown
- **Ownership & lifetimes**: Are there unnecessary clones, lifetime issues, or potential use-after-move bugs?
- **Error handling**: Are errors propagated properly using `?` with context?
- **Async correctness**: Are `Send`/`Sync` bounds satisfied? No blocking on async runtime?
```

### `{{LANGUAGE_SPECIFIC_REVIEW_RULES}}`

Rust の場合:

```markdown
- Pay special attention to `unsafe` blocks — they must have a `// SAFETY:` comment.
- Flag any use of `#[allow(...)]` — `#[expect(lint, reason = "...")]` is preferred.
- Flag `.unwrap()` / `.expect()` outside of tests — suggest `?` with context instead.
```

TypeScript の場合:

```markdown
- Flag `any` types — suggest proper typing or `unknown`.
- Flag `console.log` in production code — use the project's logger.
- Verify `async` functions are properly `await`ed at call sites.
```

### `{{LANGUAGE_SPECIFIC_IMPLEMENTATION_GUIDELINES}}`

```markdown
- **Error handling**: Use Result types or proper try-catch with typed errors
- **Testing**: Write unit tests for business logic, integration tests for API endpoints
- **Code style**: Follow the project's ESLint/Prettier/formatter configuration
```

### `{{QA_COMMANDS}}`

TypeScript (Next.js) の場合:

```markdown
- **Type check**: `npx tsc --noEmit` — ensure no type errors
- **Lint**: `pnpm lint` — no lint warnings
- **Format**: `pnpm format:check` — verify formatting
- **Test**: `pnpm test` — run the full test suite
- **Build**: `pnpm build` — ensure the project builds successfully
```

Rust の場合:

```markdown
- **Build**: `cargo build --workspace` — ensure compilation
- **Lint**: `cargo clippy --all-targets --all-features -- -D warnings` — no clippy warnings
- **Format**: `cargo fmt --all -- --check` — verify formatting
- **Test**: `cargo test --workspace` — run the full test suite
```

## ワークフロー概要

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
