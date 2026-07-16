---
name: create-issue
description: >
  このスキルは、ユーザーが「Issue作成」「Issue起票」「バグ報告」「機能要望」「タスク化」
  「Issueにして」「/create-issue」と依頼した場合に使用される。
  会話やプランの内容からGitHub Issueを作成する。
  引数なしで直前の会話コンテキストから自動生成、または `/create-issue タイトル` で明示指定も可。
version: 0.2.0
model: opus
allowed-tools: Bash(gh *), AskUserQuestion
references:
  - references/templates.md
user-invocable: false
---

# Create Issue

会話コンテキストからGitHub Issueを作成する。

## CRITICAL

- **プランモードに入らないこと**。`EnterPlanMode` を使用せず、直接ワークフローを実行する。

## ワークフロー

### Step 1: 方針の対話

`AskUserQuestion` でユーザーと対話して以下を決定する（設計判断や方針は一方的に決めない）:

- スコープ（どこまで含めるか）
- アプローチに複数の選択肢がある場合はその選定
- 分割の要否（変更ファイルが多い / 複数の機能にまたがる場合）
分割する場合は、各 Issue について Step 2〜6 を繰り返す。

### Step 2: コンテキスト分析

直前の会話内容（プラン、バグ議論、機能要望など）を分析し以下を判定する:

- **type**: `feat` / `fix` / `docs` / `style` / `refactor` / `perf` / `test` / `build` / `ci` / `chore`（`rules/git-conventions.md` の type 体系と同一）
- **タイトル**: 変更内容の簡潔な要約（日本語）
- **本文**: Step 3 のテンプレートに従って生成

引数でタイトルが渡された場合はそれを優先する。

### Step 3: テンプレート適用

type に応じて `templates.md` のテンプレートで本文を生成する。

### Step 4: ラベル決定

コミット type と同名のラベルを付与する（`rules/git-conventions.md` 参照）。

| type | label |
|:-----|:------|
| feat | `feat` |
| fix | `fix` |
| docs | `docs` |
| style | `style` |
| refactor | `refactor` |
| perf | `perf` |
| test | `test` |
| build | `build` |
| ci | `ci` |
| chore | `chore` |

### Step 5: ユーザー確認

まず Issue の内容をテキスト出力で表示する:

- **タイトル**
- **種別 + ラベル**
- **本文**（markdown のまま plain text で出力）

その後 `AskUserQuestion` で「この内容で作成してよいか？修正があれば指摘してください」と確認のみ取る。

ユーザーが修正を求めた場合は調整して再確認する。

### Step 6: Issue 作成

承認後 `gh issue create` を実行する:

```bash
gh issue create --title "<タイトル>" --label "<label>" --body "$(cat <<'EOF'
<本文>
EOF
)"
```

作成後、Issue URL をユーザーに返す。

## 参照ファイル

- **テンプレート**: `references/templates.md` — type別のIssue本文テンプレート集
