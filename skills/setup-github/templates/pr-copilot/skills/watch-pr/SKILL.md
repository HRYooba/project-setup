---
name: watch-pr
description: >
  PR作成後に Claude が自動で起動するスキル。
  Monitor ツールで PR のレビューをポーリング監視し、指摘があれば resolve-pr を自動実行する。
  PR番号またはURLを指定。
version: 1.1.0
user-invocable: false
argument-hint: [PR番号 or URL]
---

# PRレビュー監視 + 対応

**PR指定**: $ARGUMENTS

引数がPR番号またはURLの場合はそのPRを対象に、引数なしの場合は現在ブランチのPRを自動検出する。

## 呼び出し規約

このスキルは **Skill ツール** で起動する。Monitor によるポーリングはバックグラウンドで実行され、レビュー検出時に通知が届く。

```
Skill(skill: "watch-pr", args: "{pr_number}")
```

## 制約

- **1 PR につき 1 回のみ**起動する。Copilot は 1 PR に 1 回しか自動レビューしないため、resolve-pr 対応後に再度 watch-pr を起動しない
- 起動は原則 after-pr-create hook の指示による。指示が無い PR は Copilot レビュー対象外（コード変更なし等）なので自発的に起動しない

## Step 1: PR 特定 + Copilot レビュアー確認 + 開始時刻記録

1. **PR特定**: `gh pr view --json number,url` で自動検出、または引数から抽出
2. **リポジトリ情報取得**: `gh repo view --json owner,name`
3. **Copilot レビュアー確認**（監視前ガード）:

   ```
   gh api "repos/{owner}/{repo}/pulls/{pr}" --jq '[.requested_reviewers[].login | select(test("copilot"; "i"))] | length'
   ```

   結果が `0` なら「PR #{pr} に Copilot レビュアーが付いていないため監視しません」と報告して**ここで終了する**（Monitor を起動しない）。レビューが来ない PR を 30 分ポーリングする無駄を防ぐガード
4. **開始時刻記録**: `date -u +%Y-%m-%dT%H:%M:%SZ` → `{start_time}`

---

## Step 2: Monitor セットアップ

以下のポーリングスクリプトを Monitor ツールで起動する。
`{owner}`, `{repo}`, `{pr}`, `{start_time}` は Step 1 で取得した値に置換すること。

```
Monitor(
  description: "PR #{pr} レビュー監視",
  persistent: true,
  timeout_ms: 1,
  command: <下記スクリプト>
)
```

`persistent: true` のため `timeout_ms` は無視されるが、必須パラメータのため任意の値を指定する。
監視上限はスクリプト内の `max_checks=60`（30秒 × 60回 = 30分）で制御する。

### ポーリングスクリプト

```bash
owner="{owner}"
repo="{repo}"
pr="{pr}"
start_time="{start_time}"
max_checks=60
check=0

while [ $check -lt $max_checks ]; do
  check=$((check + 1))
  echo "check $check/$max_checks" >&2

  reviews=$(gh api "repos/$owner/$repo/pulls/$pr/reviews" \
    --jq "[.[] | select(.submitted_at > \"$start_time\")] | length" 2>/dev/null || echo "0")

  if [ "$reviews" -gt 0 ] 2>/dev/null; then
    pr_comments=$(gh api "repos/$owner/$repo/pulls/$pr/comments" \
      --jq "[.[] | select(.created_at > \"$start_time\")] | length" 2>/dev/null || echo "0")
    issue_comments=$(gh api "repos/$owner/$repo/issues/$pr/comments" \
      --jq "[.[] | select(.created_at > \"$start_time\" and (.user.type != \"Bot\" or (.user.login | test(\"^copilot-pull-request-reviewer\"))))] | length" 2>/dev/null || echo "0")
    total=$((pr_comments + issue_comments))

    if [ "$total" -gt 0 ]; then
      echo "REVIEW_DETECTED|pr=$pr|comments=$total"
    else
      echo "REVIEW_NO_COMMENTS|pr=$pr"
    fi
    exit 0
  fi

  sleep 30
done

echo "TIMEOUT|pr=$pr|checks=$max_checks"
```

セットアップ完了後、「PR #{pr} のレビュー監視を開始しました」と出力する。

---

## Step 3: 通知受信時の対応

Monitor から通知を受信したら、内容に応じて対応する:

| 通知 | 対応 |
|:---|:---|
| `REVIEW_DETECTED` | resolve-pr スキルを起動（下記参照） |
| `REVIEW_NO_COMMENTS` | 「レビュー完了、指摘なし」と報告して終了 |
| `TIMEOUT` | 「30分間レビューが検出されませんでした」と報告して終了 |
| stream ended（完了通知） | 無視する（Monitor 終了時のシステム通知） |

### resolve-pr の起動方法

```
Skill(skill: "resolve-pr", args: "{pr}")
```

resolve-pr は frontmatter で `context: fork` / `agent: review-responder` を指定しているため、
専用エージェント上で自動的にレビュー対応が実行される。
