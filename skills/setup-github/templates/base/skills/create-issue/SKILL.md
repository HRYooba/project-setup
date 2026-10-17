---
name: create-issue
description: >
  ユーザーが Issue 化を求めたとき（「Issue作成」「Issue起票」「バグ報告」「機能要望」
  「タスク化」「Issueにして」）に使う。会話やプランの内容から GitHub Issue を作成する。
  引数なしなら直前の会話から起こし、`/create-issue タイトル` で明示指定もできる。
  外向きの成果物を作るので、依頼されていないのに起票しない。
version: 0.6.0
allowed-tools: Bash(gh *), AskUserQuestion
---

# Create Issue

会話コンテキストからGitHub Issueを作成する。
プランモード（`EnterPlanMode`）には入らず、このワークフローを直接実行する。

## ワークフロー

### Step 1: コンテキスト分析

直前の会話内容（プラン、バグ議論、機能要望など）を分析し以下を判定する:

- **type**: `feat` / `fix` / `docs` / `style` / `refactor` / `perf` / `test` / `build` / `ci` / `chore` から選ぶ（`revert` は Issue として起票しない）
- **タイトル**: 変更内容の簡潔な要約（日本語）。引数でタイトルが渡された場合はそれを優先する
- **スコープ**: どこまで含めるか
- **分割の要否**: 変更ファイルが多い / 複数の機能にまたがるなら分割候補を出す
- **未決の論点**: 会話で決まっていないスコープ・アプローチの選択肢

### Step 2: 既存 Issue の確認

タイトルの主要語で既存 Issue を探す:

```bash
gh issue list --state all --search "<主要語>" --limit 10 --json number,title,state,url
```

同じ内容らしいものがあれば Step 6 の確認に候補として添える。

### Step 3: 未決の論点を聞く

Step 1 で未決の論点が残ったときだけ `AskUserQuestion` で決める（設計判断や方針は一方的に決めない）。
会話で決まりきっていれば聞かずに進む。分割する場合は、各 Issue について Step 4〜7 を繰り返す。

### Step 4: 本文の生成

本文の節構成は**リポジトリの `.github/ISSUE_TEMPLATE/` が正本**。実行時に読んで決める:

1. `.github/ISSUE_TEMPLATE/` の `*.yml` / `*.yaml` / `*.md`（`config.yml` を除く）を読む
2. type に合うテンプレートを選ぶ。`labels` に type と同名のラベルを持つものを優先し、
   無ければ `name` / `description` から判断する（バグ報告 → `fix`、機能要望 → `feat`、
   それ以外の作業 → 残りの type）
3. 選んだテンプレートの各入力を、順に `## <label>` の節として本文に組み立てる
   （yml なら `body` の `textarea` / `input` / `dropdown` / `checkboxes`。`markdown` 要素は説明文なので写さない。
   md テンプレートは front matter を除いた本文の節構成に従う）。
   `required` の節は必ず埋める。任意の節で書くことが無ければ「なし」と書く

テンプレートが無い、または type に合うものが無いときは `## 概要` / `## 背景・目的` / `## 完了条件` / `## 参考` で組み立てる。

`--body` で渡した本文には Issue フォームが適用されないため、本文はこの段で完成させる。

### Step 5: ラベル決定

Step 1 で判定した type と**同名のラベル**を付与する（1 Issue に付ける type ラベルは原則1つ）。
`gh label list --search <type>` で有無を確かめる。無ければ Step 6 の確認に「ラベル `<type>` を新規作成する」を含め、
承認されたら起票前に `gh label create <type>` で作る（別の質問にしない）。

### Step 6: ユーザー確認

まず Issue の内容をテキスト出力で表示する:

- **タイトル**
- **種別 + ラベル**（新規作成するラベルがあればその旨）
- **本文**（markdown のまま plain text で出力）
- **似た既存 Issue**（Step 2 で見つかった場合）

その後 `AskUserQuestion` で「この内容で作成してよいか？修正があれば指摘してください」と確認のみ取る。
似た既存 Issue があるときは「作成する / 既存 Issue にコメントする / やめる」を選択肢にする。

ユーザーが修正を求めた場合は調整して再確認する。

### Step 7: Issue 作成

承認後 `gh issue create` で起票し、Issue URL をユーザーに返す。
