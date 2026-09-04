---
name: resolve-pr
description: >
  PR に未対応のレビュー指摘または失敗した CI チェックがあるとき、ユーザーの依頼を待たずに
  実行する（watch-pr が検知したときの起動先でもある）。指摘と CI 失敗の取得・修正・コミット・
  Push・リプライ送信・Copilot コメントの Resolve までを 1 巡で行う。PR 番号または URL を指定。
version: 1.2.0
argument-hint: [PR番号 or URL]
context: fork
agent: review-responder
# 背景で走らせない。コードを直して commit / push するので、
# メインセッションの git 操作と競合し、/rewind の対象からも外れる。
background: false
---

# PR の指摘・CI 失敗への対応（即時実行）

**PR指定**: $ARGUMENTS

対応する入力は 2 系統ある。**どちらも「PR をマージできる状態にするために直すもの」**なので、
修正 → commit → push の胴体は共有する。違うのは取得のしかたと返しかただけ。

| 系統 | 取得元 | 返しかた |
|:---|:---|:---|
| レビュー指摘 | 未解決レビュースレッド + PR コメント | 各スレッドへリプライ、Copilot のスレッドは Resolve |
| CI の失敗 | 失敗した check とその実行ログ | 返信先が無いので PR コメント 1 本にまとめる |

**このスキルは 1 巡で終える。** push で CI が回り直した結果は待たない
（待つと監視が入れ子になる）。最後の報告に「push 後の CI は未確認」と明記する。

## Step 1: PR特定 + 対応対象の取得

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
5. **失敗した CI チェックの取得**（3・4 と同じレスポンスにまとめる）:
```bash
gh pr checks {pr_number} --json name,bucket,link --jq '[.[] | select(.bucket == "fail")]'
```
   - このオプションが使えない `gh` では素の `gh pr checks {pr_number}` の表を読む
     （exit code は `0` = 全部 pass / `8` = pending あり / それ以外 = 失敗あり。
     チェックが 1 つも無い PR ではエラー終了するので、出力の `no checks` で切り分ける）
   - **pending が残っているうちは CI 系統の対応をしない。** まだ結果が出ていないものを
     「失敗していない」と読むと、赤を素通しして報告することになる。その旨を報告に載せる
6. **失敗ログの取得**（失敗した check があるときだけ）:
```bash
gh run list --branch {headRefName} --limit 10 \
  --json databaseId,conclusion,workflowName \
  --jq '[.[] | select(.conclusion == "failure")] | .[0].databaseId'
gh run view {run_id} --log-failed | tail -n 300
```
   - `--log-failed` は失敗した step だけを返す。全文は長いので末尾から読む
   - ワークフローが `::error::` で出した注釈がそのままログに載る。**まずそれを探す**
     （原因が 1 行で書かれていることが多い）
7. **レビューコメント 0 件かつ失敗 check 0 件** → 「対応する指摘・失敗なし」で終了

**保持データ:** レビュー側は id, comment_type, author, file, line, body, thread_id /
CI 側は check 名, 失敗ステップ, ログの該当箇所

---

## Step 2: 修正実装

レビュー指摘と CI 失敗を**同じ 1 回の修正**として扱う（同じファイルを 2 度触らない）。

### CI 失敗の直しかた

ログの `::error::` 注釈から原因を特定し、**その原因を直す**。CI 設定のほうを緩めない
（gate を弱めれば緑にはなるが、止めるべきものが止まらなくなる）。

| 典型 | 対応 |
|:---|:---|
| コーディング規約違反（`warning UCS####`） | 指摘された箇所を規約に合わせる。抑制は正当な例外に限り、理由コメントを付ける |
| テスト失敗 | 実装を直す。テストのほうが誤っている根拠があるならテストを直し、その根拠を報告に書く |
| プロジェクト整合性（`.meta` 欠落・GUID 重複・衝突マーカー） | マージ事故の残骸。該当ファイルを直してコミットする |
| 環境・認証の失敗（ライセンス secret 未設定など） | **コードの問題ではない**。直さず、必要な設定を報告する |

**原因を特定できないまま推測で直さない。** 分からなければ、ログの該当箇所を添えて報告し止める。

---

## Step 3: コミット・Push

変更があるときだけコミットして push する。subject は直した内容に合わせる
（例: `fix: コーディング規約違反を解消`）。リプライ文は修正したかスキップしたかが分かる形で、
スキップなら理由を書く。

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

**CI 失敗への返答**は返信先のスレッドが無いので、PR コメント 1 本にまとめて投稿する。
失敗した check 名・原因・行った修正を書く。**直さなかったもの（環境起因など）も必ず載せる。**

---

## Step 5: Copilot コメント自動 Resolve

- `author` が `copilot-pull-request-reviewer`（末尾 `[bot]` が付く形式も同一視・前方一致）
  かつ `isResolved: false` のスレッドのみ
- **人間レビュアーのコメントは Resolve しない**

```bash
gh api graphql -f query="mutation { resolveReviewThread(input: {threadId: \"THREAD_ID\"}) { thread { isResolved } } }"
```

Resolve 失敗はベストエフォート。

---

## Step 6: 報告

次を含めて報告する:

- 対応したレビュー指摘とその内容
- 対応した CI の失敗（check 名・原因・修正内容）
- **直さなかったもの**とその理由（環境起因・原因不明・仕様判断が要るもの）
- pending のまま結果が出ていなかった check があればその一覧
- **push 後の CI は未確認である旨**（このスキルは回り直した結果を待たない）
