---
name: watch-pr
description: >
  PR作成後に Claude が自動で起動するスキル。
  Monitor ツールで PR のレビューをポーリング監視し、指摘があれば resolve-pr を自動実行する。
  PR番号またはURLを指定。
version: 1.4.0
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

## Step 1: PR 特定 + 既存レビューの確認 + 開始時刻記録

1. **PR特定**: `gh pr view --json number,url` で自動検出、または引数から抽出
2. **リポジトリ情報取得**: `gh repo view --json owner,name`
3. **レビューが既に届いているか確認**: Step 2 のポーリングと同じエンドポイントを 1 回だけ叩く。

   ```bash
   gh api "repos/{owner}/{repo}/pulls/{pr}/reviews" \
     --jq '[.[] | select(.user.login // "" | test("copilot"; "i"))] | length'
   ```

   | 結果 | 対応 |
   |:---|:---|
   | `> 0` | Copilot のレビューは既に届いている。Monitor を起動せず **Step 3 の resolve-pr へ直行**する |
   | `0` | まだ届いていない。Step 2 の Monitor 監視へ進む |
   | コマンド自体が失敗（権限不足・ネットワーク等） | `0` と同じ扱いで Step 2 へ進む（判定不能を「レビュー無し」と決めつけて対応を落とさない） |

   **Copilot 依頼が成立しているかをここで判定しない。** 依頼を投げるのも成否を見るのも
   after-pr-create hook で、失敗した PR には hook が「watch-pr を起動しないでください」と出す。
   つまりこのスキルが起動された時点で依頼は成立している。同じ事実を hook と skill の 2 箇所で
   判定すると、判定式がずれたときに skill 側が hook の伝えた事実を上書きして
   「Copilot レビュアーが付いていない」と誤報告し、届いているレビューを取りこぼす。
   空監視を防ぐ多層防御は失うが、その最大コストは 30 分のポーリング 1 本で、
   誤報告のコスト（レビューを無視した上でユーザーへ嘘を伝える）より軽い。

   **`requested_reviewers`（REST の PR 本体 `repos/{owner}/{repo}/pulls/{pr}`）を使ってはいけない。**
   このフィールドは User 型しか返さず、Copilot は Bot 型のため依頼が成立していても常に空配列になる。
   この Step が使う `pulls/{pr}/reviews` の `user.login` は Bot でも
   `copilot-pull-request-reviewer[bot]` を返すため、Bot 型の穴が無い。
4. **開始時刻記録**（Step 2 へ進む場合のみ）: `date -u +%Y-%m-%dT%H:%M:%SZ` → `{start_time}`

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

## Step 3: レビュー対応

Step 1 でレビューが既に届いていた場合は、Monitor を経由せずここへ来る。下記「resolve-pr の起動方法」で直接 resolve-pr を起動する。

Monitor から通知を受信した場合は、内容に応じて対応する:

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
