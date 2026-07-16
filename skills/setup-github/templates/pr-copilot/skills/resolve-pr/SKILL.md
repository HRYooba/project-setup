---
name: resolve-pr
description: >
  このスキルは、ユーザーが「レビュー対応」「レビュー修正」「レビューコメント対応」
  「PRレビュー解決」「レビュー自動対応」「/resolve-pr」と依頼した場合に使用される。
  PRレビューコメントの取得・修正実装・コミット・Push・リプライ送信・
  Copilotコメントの自動Resolveまでを一括自動実行する。
  PR番号またはURLを指定。
version: 1.0.0
argument-hint: [PR番号 or URL]
context: fork
agent: review-responder
---

# PRレビュー対応（即時実行）

**PR指定**: $ARGUMENTS

引数がPR番号またはURLの場合はそのPRを対象に、引数なしの場合は現在ブランチのPRを自動検出する。

## Step 1: PR特定 + レビューコメント取得

1. **PR特定**: `gh pr view --json number,url,headRefName,baseRefName` で自動検出、または引数から抽出
2. **リポジトリ情報取得**: `gh repo view --json owner,name`
3. **未解決レビュースレッド取得**:
```bash
gh api graphql -f query="query {
  repository(owner: \"OWNER\", name: \"REPO\") {
    pullRequest(number: PR_NUM) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          comments(first: 10) {
            nodes {
              databaseId
              author { login }
              body
              path
              line
            }
          }
        }
      }
    }
  }
}"
```
4. **一般PRコメント取得**: `gh api repos/{owner}/{repo}/issues/{pr_number}/comments`
   - Bot 除外（ただし `copilot-pull-request-reviewer` は対象。REST の `user.login` は
     `copilot-pull-request-reviewer[bot]` と末尾 `[bot]` が付くため、前方一致で判定する）
5. **0件** → 「未解決コメントなし」で終了

**保持データ:** id, comment_type, author, file, line, body, thread_id

---

## Step 2: コメント対応（修正実装）

1. 対象ファイルを Read でコンテキスト確認
2. Edit で修正
3. 各コメントのリプライ文を準備

### リプライ文テンプレート

| 状況 | テンプレート |
|---|---|
| 修正した | `✅ 対応しました。\n{変更内容}` |
| スキップ | `⚠️ スキップしました。\n理由: {理由}` |
| 質問回答 | `✅ {回答}` |
| 賞賛 | `ありがとうございます。` |
| 情報提供 | `承知しました。` |

---

## Step 3: コミット・Push

変更がある場合のみ:
```bash
git add <変更ファイル>
git commit -m "fix: レビュー指摘対応"
git push
```

コミット subject に `(#PR番号)` を付けないこと（`.claude/rules/git-conventions.md`: Issue 参照は
subject でなく footer に書く。squash merge 時は PR 番号が subject 末尾へ自動付与されるため手書きは重複する）。

---

## Step 4: リプライ送信

**レビューコメント:**
```bash
gh api repos/{owner}/{repo}/pulls/{pr_number}/comments/{comment_id}/replies -f body="リプライ本文"
```

**イシューコメント:**
```bash
gh api repos/{owner}/{repo}/issues/{pr_number}/comments -f body="$(printf '> 元コメント引用\n\nリプライ本文')"
```

改行を含める場合は `-f body="$(printf '...\n...')"` のように printf で実改行を生成する
（`-f` は値をそのまま送るため、二重引用符内の `\n` はリテラルの 2 文字として投稿され改行にならない）。
独立した送信は並列実行。

---

## Step 5: Copilot コメント自動 Resolve

- `author` が `copilot-pull-request-reviewer`（末尾 `[bot]` が付く形式も同一視・前方一致）
  かつ `isResolved: false` のスレッドのみ
- **人間レビュアーのコメントは Resolve しない**

```bash
gh api graphql -f query="mutation { resolveReviewThread(input: {threadId: \"THREAD_ID\"}) { thread { isResolved } } }"
```

Resolve 失敗はベストエフォート。
