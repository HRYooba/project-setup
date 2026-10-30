// 同期 PR を自動 merge してよいかの判定。sync-run.mjs の publish が使う。
//
// 自動 merge は「人がレビューしなくても中身が正しいと言える」ときだけ行う。
// 言えない同期は PR を開いたまま残し、理由を出力して人のゲートへ回す。

// 自動 merge を止める理由の一覧（空なら merge してよい）。
//   drifted: 同期計画の drifted（{ skill, basis, from, to }）
//   notes:   統合で決め切れなかった矛盾メモ（PR 本文の「要確認」節）
export function autoMergeBlockers(drifted, notes) {
  const reasons = [];
  if (String(notes || "").trim()) {
    reasons.push("テンプレと現物の矛盾が未決のまま残っている（PR 本文の「要確認」を見て判断する）");
  }
  // sha には新旧の向きが無い。marketplace の更新が遅れたマシンは、新しい配備先を古い sha へ
  // 巻き戻す PR を出しうるので、そのまま merge させない。
  const shaSyncs = (drifted || []).filter((d) => d.basis === "unity-plugin");
  if (shaSyncs.length) {
    reasons.push(
      `公式 unity プラグインの sha 同期を含む（${shaSyncs.map((d) => `${d.from}→${d.to}`).join(", ")}）。` +
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
