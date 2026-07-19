# project-setup

Claude Code 用のプロジェクト初期セットアップ plugin。2 つの skill を提供する。

| skill | 内容 |
|:------|:-----|
| `setup-github` | GitHub 開発フロー一式を導入する。ブランチ保護（pre-push）、PR 前 code-review / security-review 門番 hook、git 運用規約（Git Flow / Conventional Commits）、create-issue skill。任意で Copilot PR 自動レビュー（自動アサイン / watch-pr / resolve-pr）と AGENTS.md 自動生成 |
| `setup-unity` | Unity 開発規約一式を導入する。rules（フォルダ構成 / Hierarchy / アセット命名 / コーディング規約 / テスト）、skills（test-unity / lint-unity）、agents（unity-tester / unity-linter）。任意でレイヤードアーキテクチャ規約と MCP バインディング |

どちらも**冪等**（再実行安全）で、導入オプションは実行時に対話で確認する。配置物は対象リポジトリの `.claude/` などにコミットされるため、plugin を持たないチームメイトにもそのまま効く。

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

hook（PR 前門番・effort nudge）と apply.mjs の冪等性は `tests/` のユニットテストで検証する（Node 標準の test runner のみ・依存なし）:

```
node --test "tests/*.test.mjs"
```

CI（`.github/workflows/test.yml`）が PR ごとに同じテストを実行する。
