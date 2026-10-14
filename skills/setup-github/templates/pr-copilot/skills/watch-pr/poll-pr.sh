#!/usr/bin/env bash
# watch-pr の監視 1 回分（Monitor の watch 1 本）。手順と出力の読み方は同じディレクトリの SKILL.md が正本。
#
# 使い方: poll-pr.sh <owner> <repo> <pr> <phase> <start_time> <attempt>
#   phase=review : Copilot レビューと CI の両方が出揃うまで待つ
#   phase=ci     : CI だけを待つ（レビューは見ない）
#
# 最終行（stdout）は RESULT / CONTINUE / TIMEOUT のどれか 1 行。途中経過は stderr。
# POLL_INTERVAL_SEC で間隔を変えられる（既定 30 秒）。

owner="$1"
repo="$2"
pr="$3"
phase="$4"
start_time="$5"
attempt="$6"
max_attempts=5
max_checks=12
interval="${POLL_INTERVAL_SEC:-30}"
check=0

case "$phase" in
  review)
    review_state="none" # none / detected / no_comments
    # チェックが 1 つも無い PR は、その時点で「CI なし」と確定してよい
    none_grace=0
    ;;
  ci)
    review_state="skip"
    # push 直後は新しい head の check がまだ登録されていない。その間の「チェックなし」を
    # CI なしと読むと未実行の CI を素通しするため、最初の watch の 6 回（既定 3 分）は pending 扱い
    none_grace=6
    ;;
  *)
    echo "phase は review か ci: $phase" >&2
    exit 2
    ;;
esac
checks_state="pending" # pending / pass / fail / none

while [ "$check" -lt "$max_checks" ]; do
  check=$((check + 1))
  echo "phase $phase attempt $attempt/$max_attempts check $check/$max_checks review=$review_state checks=$checks_state" >&2

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
  # exit code で読む: 0 = 全部 pass / 8 = pending あり / それ以外 = 失敗あり。
  # チェックが 1 つも無い PR もエラー終了するので、出力の "no checks" で切り分ける
  if [ "$checks_state" = "pending" ]; then
    checks_out=$(gh pr checks "$pr" -R "$owner/$repo" 2>&1)
    case $? in
      0) checks_state="pass" ;;
      8) checks_state="pending" ;;
      *) if printf '%s' "$checks_out" | grep -qi "no checks"; then
           if [ "$attempt" -eq 1 ] && [ "$check" -le "$none_grace" ]; then
             checks_state="pending"
           else
             checks_state="none"
           fi
         else
           checks_state="fail"
         fi ;;
    esac
  fi

  if [ "$review_state" != "none" ] && [ "$checks_state" != "pending" ]; then
    echo "RESULT|pr=$pr|phase=$phase|review=$review_state|checks=$checks_state"
    exit 0
  fi

  sleep "$interval"
done

if [ "$attempt" -lt "$max_attempts" ]; then
  echo "CONTINUE|pr=$pr|phase=$phase|review=$review_state|checks=$checks_state|next_attempt=$((attempt + 1))"
else
  echo "TIMEOUT|pr=$pr|phase=$phase|review=$review_state|checks=$checks_state"
fi
