---
name: watch-pr
description: >
  **after-pr-create hook が起動を指示したときだけ**起動する。指示が無い PR は Copilot の
  レビュー対象外（コード変更なし等）なので自発的に起動しない — 起動すると 30 分の空監視になる。
  1 PR につき 1 回のみ。Monitor で PR のレビューと CI チェックを監視し、両方が出揃ってから
  指摘または CI の失敗があれば resolve-pr を起動する。PR 番号または URL を指定。
version: 1.7.0
argument-hint: [PR番号 or URL]
---

# PR のレビュー・CI 監視

**PR指定**: $ARGUMENTS

## 何を待つか

PR 作成後に外から返ってくる非同期の結果は 2 系統ある。**両方が出揃うまで待ってから**
1 度だけ resolve-pr へ渡す。片方で抜けると、残る片方のためにもう一度監視を張ることになる。

| 系統 | 出所 | 完了の判定 |
|:---|:---|:---|
| Copilot のレビュー | `pulls/{pr}/reviews` | 監視開始後のレビューが 1 件でも付いた |
| CI チェック | `gh pr checks` | pending が 1 つも無くなった |

## 制約

- **1 PR につき 1 回のみ**起動する。Copilot は 1 PR に 1 回しか自動レビューしないため、
  resolve-pr 対応後に再度 watch-pr を起動しない。resolve-pr の push で CI が回り直した結果は
  ユーザーが `gh pr checks --watch` で見るか、次のターンで確認する
- 起動は原則 after-pr-create hook の指示による。指示が無い PR は Copilot レビュー対象外
  （コード変更なし等）なので自発的に起動しない

## Step 1: PR 特定 + 現在の状態確認 + 開始時刻記録

1. **PR特定**: `gh pr view --json number,url,headRefName` で自動検出、または引数から抽出
2. **リポジトリ情報取得**: `gh repo view --json owner,name`
3. **両系統の現在値を 1 レスポンスで取る**（Step 2 のポーリングと同じ判定を 1 回だけ先に撃つ）:

   ```bash
   gh api "repos/{owner}/{repo}/pulls/{pr}/reviews" \
     --jq '[.[] | select(.user.login // "" | test("copilot"; "i"))] | length'
   gh pr checks {pr}
   ```

   | 結果 | 対応 |
   |:---|:---|
   | レビューが `> 0` かつ CI に pending が無い | どちらも出揃っている。Monitor を起動せず **Step 3 へ直行** |
   | どちらかが未確定 | Step 2 の Monitor 監視へ進む |
   | コマンド自体が失敗（権限不足・ネットワーク等） | 「未確定」と同じ扱いで Step 2 へ進む（判定不能を「無し」と決めつけて対応を落とさない） |

   `gh pr checks` は **exit code で読む**（JSON のフィールド名に依存しない）:
   `0` = 全部 pass / `8` = pending あり / それ以外 = 失敗あり。
   ただし **チェックが 1 つも無い PR ではエラー終了する**ので、出力に `no checks` を含むかで
   「失敗」と「そもそも無い」を切り分ける。

   **Copilot 依頼の成否をここで判定しない。** 判定するのは after-pr-create hook で、
   失敗した PR には hook が「起動しないでください」と出す。2 箇所で判定すると、
   ずれたときに届いているレビューを取りこぼす。

   **`requested_reviewers` を使ってはいけない。** User 型しか返さず、Bot 型の Copilot は
   依頼が成立していても常に空配列になる。`pulls/{pr}/reviews` の `user.login` は Bot でも
   `copilot-pull-request-reviewer[bot]` を返すのでこの穴が無い。
4. **開始時刻記録**（Step 2 へ進む場合のみ）: `date -u +%Y-%m-%dT%H:%M:%SZ` → `{start_time}`

---

## Step 2: Monitor セットアップ

以下のポーリングスクリプトを Monitor ツールで起動する。
`{owner}`, `{repo}`, `{pr}`, `{start_time}` は Step 1 で取得した値に置換すること。

```
Monitor(
  description: "PR #{pr} レビュー・CI 監視",
  persistent: true,
  timeout_ms: 1000,
  command: <下記スクリプト>
)
```

`persistent: true` でも `timeout_ms` は必須で、**`1000` 未満は書かない**（値は無視されるが
スキーマ検証が先に走る。`1` を渡していた間は毎回 Invalid tool parameters で落ちていた）。
監視上限はスクリプト内の `max_checks=60`（30 秒 × 60 = 30 分）。
**CI が Editor を起動するプロジェクトでは 10〜30 分かかる**ので縮めない。

### ポーリングスクリプト

```bash
owner="{owner}"
repo="{repo}"
pr="{pr}"
start_time="{start_time}"
max_checks=60
check=0

review_state="none"    # none / detected / no_comments
checks_state="pending" # pending / pass / fail / none

while [ $check -lt $max_checks ]; do
  check=$((check + 1))
  echo "check $check/$max_checks review=$review_state checks=$checks_state" >&2

  # --- レビュー ---
  if [ "$review_state" = "none" ]; then
    reviews=$(gh api "repos/$owner/$repo/pulls/$pr/reviews" \
      --jq "[.[] | select(.submitted_at > \"$start_time\")] | length" 2>/dev/null || echo "0")
    if [ "$reviews" -gt 0 ] 2>/dev/null; then
      pr_comments=$(gh api "repos/$owner/$repo/pulls/$pr/comments" \
        --jq "[.[] | select(.created_at > \"$start_time\")] | length" 2>/dev/null || echo "0")
      issue_comments=$(gh api "repos/$owner/$repo/issues/$pr/comments" \
        --jq "[.[] | select(.created_at > \"$start_time\" and (.user.type != \"Bot\" or (.user.login | test(\"^copilot-pull-request-reviewer\"))))] | length" 2>/dev/null || echo "0")
      total=$((pr_comments + issue_comments))
      if [ "$total" -gt 0 ]; then review_state="detected"; else review_state="no_comments"; fi
    fi
  fi

  # --- CI チェック ---
  if [ "$checks_state" = "pending" ]; then
    checks_out=$(gh pr checks "$pr" 2>&1)
    case $? in
      0) checks_state="pass" ;;
      8) checks_state="pending" ;;
      *) if printf '%s' "$checks_out" | grep -qi "no checks"; then
           checks_state="none"
         else
           checks_state="fail"
         fi ;;
    esac
  fi

  if [ "$review_state" != "none" ] && [ "$checks_state" != "pending" ]; then
    echo "RESULT|pr=$pr|review=$review_state|checks=$checks_state"
    exit 0
  fi

  sleep 30
done

echo "TIMEOUT|pr=$pr|review=$review_state|checks=$checks_state"
```

セットアップ完了後、「PR #{pr} のレビュー・CI 監視を開始しました」と出力する。

---

## Step 3: 結果に応じた対応

Step 1 で両方が出揃っていた場合は、Monitor を経由せずここへ来る。

| review | checks | 対応 |
|:---|:---|:---|
| `detected` | 何でも | resolve-pr を起動（下記） |
| `no_comments` | `fail` | resolve-pr を起動（下記） |
| `no_comments` | `pass` / `none` | 「レビュー完了・CI 通過、対応不要」と報告して終了 |

`TIMEOUT` の場合は、その時点の `review` / `checks` の値をそのまま報告して終了する
（`fail` が確定していれば resolve-pr を起動してよい）。
Monitor の終了通知（stream ended）は無視する。

### resolve-pr の起動方法

```
Skill(skill: "resolve-pr", args: "{pr}")
```

resolve-pr 自身がレビューコメントと失敗した check の両方を集めるので、内容は渡さない。

**resolve-pr は 1 度だけ起動する。** その push で CI が回り直した結果まで待たない
（待ち直すと監視が入れ子になる）。resolve-pr の報告に「push 後の CI は未確認」と出るので、
ユーザーがそこから続きを判断する。
