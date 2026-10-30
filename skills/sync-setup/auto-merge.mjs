// 同期 PR を自動 merge してよいかの判定。sync-run.mjs の publish が使う。
//
// 自動 merge は「人がレビューしなくても中身が正しいと言える」ときだけ行う。
// 言えない同期は PR を開いたまま残し、理由を出力して人のゲートへ回す。

// 自動 merge を止める理由の一覧（空なら merge してよい）。
//   notes:          統合で決め切れなかった矛盾メモ（PR 本文の「要確認」節）
//   needsMerge:     apply が要マージを報告したか（＝ Claude が手で統合した差分を含む）
//   unityShaChange: apply の前後で記録が変わった unity プラグインの sha（{ from, to } / null）
export function autoMergeBlockers({ notes = "", needsMerge = false, unityShaChange = null } = {}) {
  const reasons = [];
  // 統合先は配備先の AI の振る舞いを決める CLAUDE.md や rules。Claude が書いた差分は人が見る
  if (needsMerge) {
    reasons.push("要マージのファイルを Claude が統合した（その差分を人が確認する）");
  }
  if (String(notes || "").trim()) {
    reasons.push("テンプレと現物の矛盾が未決のまま残っている（PR 本文の「要確認」を見て判断する）");
  }
  // sha には新旧の向きが無い。marketplace の更新が遅れたマシンは、新しい配備先を古い sha へ
  // 巻き戻す PR を出しうるので、そのまま merge させない。skill 版の同期でも apply.mjs が
  // 手元の pin で sha を書き直すため、drift の種類ではなく記録の変化で見る。
  if (unityShaChange) {
    reasons.push(
      `公式 unity プラグインの sha が変わる（${String(unityShaChange.from).slice(0, 7)}→${String(unityShaChange.to).slice(0, 7)}）。` +
        "sha には新旧の向きが無く、巻き戻しかどうかを機械で判定できない"
    );
  }
  return reasons;
}

// リポジトリが許す merge 方式から 1 つ選ぶ。squash を優先する
// （PR タイトルが default ブランチの 1 コミットになり、同期 1 回が 1 行で履歴に残る）。
//   repo: `gh repo view --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed` の結果
export function pickMergeMethod(repo) {
  if (repo?.squashMergeAllowed) return "--squash";
  if (repo?.mergeCommitAllowed) return "--merge";
  if (repo?.rebaseMergeAllowed) return "--rebase";
  return null;
}
