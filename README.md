# project-setup

Claude Code 用のプロジェクト初期セットアップ plugin。2 つの skill を提供する。

| skill | 内容 |
|:------|:-----|
| `setup-github` | GitHub 開発フロー一式を導入する。ブランチ保護（pre-push）、PR 前レビュー運用（`/simplify` + `/security-review` のソフト指示）、git 運用規約（Git Flow / Conventional Commits）、create-issue skill。任意で Copilot PR 自動レビュー（自動アサイン / watch-pr / resolve-pr）と AGENTS.md 自動生成 |
| `setup-unity` | Unity 開発規約一式を導入する。rules（フォルダ構成 / Hierarchy / アセット命名 / コーディング規約 / テスト）、skills（test-unity / lint-unity）、agents（unity-tester / unity-linter）。任意でレイヤードアーキテクチャ規約と MCP バインディング |

どちらも**冪等**（再実行安全）で、導入オプションは実行時に対話で確認する。配置物は対象リポジトリの `.claude/` などにコミットされるため、plugin を持たないチームメイトにもそのまま効く。

## テンプレート自動追随

プラグインのテンプレートを更新すると、展開済みの各プロジェクトへ手作業で「更新を適用して」と個別依頼する運用になりがちだった。これを自動化する:

- apply.mjs は適用時のプラグイン版と有効フラグを `.claude/setup-sync-state.json` に記録する（setup-github / setup-unity が同じファイルへ各自のキーでマージ）。
- setup-github が配る SessionStart hook `setup-sync-check.mjs` が、セッション開始時にこの記録版と現行プラグイン版を比較する（差が無ければ即終了）。
- 現行版が新しければ、`isolation: worktree` のバックグラウンドサブエージェントが保存フラグで apply.mjs を無人適用し、commit → push → **PR 作成まで**を自動で行う。**merge は人間が行う**（PR diff で戻し・警告を確認できる）。
- 重複 PR 防止（`gh pr list`）と暴走防止（同一版 最大2回）を備える。無効化は環境変数 `SETUP_SYNC_DISABLE=1`。

既存の展開済みプロジェクトは、一度 setup-github / setup-unity を再実行すれば状態ファイルが生成され、以後の追随対象になる。

## インストール

```
/plugin marketplace add hryooba/project-setup
/plugin install project-setup@hryooba
```

scope は `user`（デフォルト）を推奨。全プロジェクトで skill が使えるようになる。

## 使い方

対象プロジェクトを開いた Claude Code セッションで:

```
/project-setup:setup-github
/project-setup:setup-unity
```

または「GitHub 運用ルールを導入して」「Unity 規約を入れて」のように依頼する。

## 構成

```
skills/
├─ setup-github/
│   ├─ SKILL.md
│   ├─ apply.mjs        … インストーラ本体（Node 標準のみ・依存なし）
│   └─ templates/
│       ├─ base/        … 常時導入分（githooks / hooks / rules / create-issue skill）
│       └─ pr-copilot/  … PR 自動レビュー導入時のみ
└─ setup-unity/
    ├─ SKILL.md
    ├─ apply.mjs
    ├─ bindings/        … Unity MCP サーバー別のバインディング表
    └─ templates/
        ├─ base/        … 常時導入分（rules / skills / agents）
        └─ architecture/ … レイヤードアーキテクチャ規約導入時のみ
```

テンプレートは plugin に同梱されたスナップショットであり、この plugin 単体で完結する（外部ファイルを参照しない）。

## テスト

hook（PR 前レビュー gate・effort nudge。既定は休眠だが本体ロジックは検証する）と apply.mjs の冪等性・登録解除は `tests/` のユニットテストで検証する（Node 標準の test runner のみ・依存なし）:

```
node --test "tests/*.test.mjs"
```

CI（`.github/workflows/test.yml`）が PR ごとに同じテストを実行する。
