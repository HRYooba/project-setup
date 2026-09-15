---
name: watch-pr
description: >
  **after-pr-create hook が起動を指示したときだけ**起動する。指示が無い PR は Copilot の
  レビュー対象外（コード変更なし等）なので自発的に起動しない — 起動すると 30 分の空監視になる。
  1 PR につき 1 回のみ。Monitor で PR のレビューと CI チェックを監視し、両方が出揃ってから
  指摘または CI の失敗があれば resolve-pr を起動する。PR 番号または URL を指定。
version: 1.8.0
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
`{owner}`, `{repo}`, `{pr}`, `{start_time}` は Step 1 で取得した値に置換する。
`{attempt}` は初回起動なので `1` を入れる。

```
Monitor(
  description: "PR #{pr} レビュー・CI 監視 ({attempt}/5)",
  timeout_ms: 420000,
  command: <下記スクリプト>
)
```

**Monitor の watch は必ず deadline を持つ。無期限にするオプションは無い。**
`timeout_ms` に達すると watch は kill され、Claude へ「再 arm せよ」という通知が届く。
deadline の上限は **30 分**、**単発 `-p` 実行では 10 分**
（パラメータ名と上限の正本は Monitor ツール自身の説明文。ここへ写さない）。

したがって 30 分を 1 回の watch で張ることはできない。**6 分の watch を最大 5 回つなぐ**:

| 値 | 意味 |
|:---|:---|
| スクリプトの `max_checks=12` | 30 秒 × 12 = **watch 1 回あたり 6 分** |
| `timeout_ms: 420000` | 7 分。スクリプトの 6 分より長いので**通常はスクリプトが自分で終わる**（deadline kill は `gh` が固まったときの保険）。`-p` の上限 10 分より短いので**通常実行と `-p` で同じ値がそのまま使える** |
| スクリプトの `max_attempts=5` | 6 分 × 5 = **合計 30 分**。**CI が Editor を起動するプロジェクトでは 10〜30 分かかる**ので縮めない |

**再 arm しても「1 PR につき 1 回のみ」は崩れない。** 再 arm は同じ監視の続きであって、
resolve-pr を複数回起動することではない。resolve-pr の起動は Step 3 で 1 度だけ。

**再 arm で状態を引き継ぐ必要は無い。** `review` / `checks` は毎回 API から `start_time` 起点で
判定し直すので、`start_time` さえ変えなければ前の watch で検出済みのレビューもそのまま再現される。
watch をまたいで引き継ぐのは `{attempt}` だけ。

### ポーリングスクリプト

```bash
owner="{owner}"
repo="{repo}"
pr="{pr}"
start_time="{start_time}"
attempt={attempt}
max_attempts=5
max_checks=12
check=0

review_state="none"    # none / detected / no_comments
checks_state="pending" # pending / pass / fail / none

while [ $check -lt $max_checks ]; do
  check=$((check + 1))
  echo "attempt $attempt/$max_attempts check $check/$max_checks review=$review_state checks=$checks_state" >&2

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

if [ "$attempt" -lt "$max_attempts" ]; then
  echo "CONTINUE|pr=$pr|review=$review_state|checks=$checks_state|next_attempt=$((attempt + 1))"
else
  echo "TIMEOUT|pr=$pr|review=$review_state|checks=$checks_state"
fi
```

**初回（`{attempt}` が `1`）のときだけ**「PR #{pr} のレビュー・CI 監視を開始しました」と出力する。
再 arm では何も出力しない（同じ監視の続きであって、新しい監視ではない）。

### 再 arm の手順

スクリプトは打ち切るとき、次にどうするかを自分で最終行に出す。**残り回数を頭で数えない。**

| スクリプトの最終行 | 対応 |
|:---|:---|
| `RESULT` 行 | 両系統が出揃った。**Step 3 へ** |
| `CONTINUE` 行（`next_attempt=N` 付き） | **同じスクリプトを `{attempt}` = N に差し替えて再 arm する**。`{start_time}` は初回の値のまま変えない |
| `TIMEOUT` 行 | 5 回を使い切った。**Step 3 へ**（打ち切りとして扱う） |

`timeout_ms` の deadline が先に来て、上のどれも出ないまま watch が終わった場合
（Monitor から再 arm を促す通知だけが届く）は `CONTINUE` と同じ扱いにし、
`{attempt}` を 1 つ進めて再 arm する。ただし `{attempt}` が既に `5` なら `TIMEOUT` と同じ扱いで Step 3 へ。

**これ以上は再 arm しない。** 合計 5 回（30 分）が全体の打ち切り条件で、
到達したら監視を終える。延長したくなったら `max_attempts` を上げるのであって、
表の外で追加の watch を張らない。

---

## Step 3: 結果に応じた対応

ここへ来るのは 3 経路ある: Step 1 で両方が出揃っていた（Monitor を経由しない）／
`RESULT` 行を受け取った／`TIMEOUT` 行（＝再 arm 5 回を使い切った）を受け取った。
`CONTINUE` 行はここへ来ない — Step 2 の再 arm に戻る。

| review | checks | 対応 |
|:---|:---|:---|
| `detected` | 何でも | resolve-pr を起動（下記） |
| `no_comments` | `fail` | resolve-pr を起動（下記） |
| `no_comments` | `pass` / `none` | 「レビュー完了・CI 通過、対応不要」と報告して終了 |

`TIMEOUT` の場合は、その時点の `review` / `checks` の値をそのまま報告して終了する
（`fail` が確定していれば resolve-pr を起動してよい）。ここでさらに再 arm はしない。
Monitor の終了通知は、`RESULT` / `TIMEOUT` を受け取った後に届いたものだけ無視する
（監視はもう終わっている）。それ以外の終了通知は Step 2 の再 arm 表に従う。

### resolve-pr の起動方法

```
Skill(skill: "resolve-pr", args: "{pr}")
```

resolve-pr 自身がレビューコメントと失敗した check の両方を集めるので、内容は渡さない。

**resolve-pr は 1 度だけ起動する。** その push で CI が回り直した結果まで待たない
（待ち直すと監視が入れ子になる）。resolve-pr の報告に「push 後の CI は未確認」と出るので、
ユーザーがそこから続きを判断する。
