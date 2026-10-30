// 同期 PR の自動 merge 判定（auto-merge.mjs）のテスト。
// GitHub への問い合わせ（CI 待ち・merge）は対象外。止める理由と merge 方式の選び方だけを見る。

import assert from "node:assert/strict";
import { test } from "node:test";
import { autoMergeBlockers, pickMergeMethod } from "../skills/sync-setup/auto-merge.mjs";

test("機械的な同期だけなら merge してよい", () => {
  assert.deepEqual(autoMergeBlockers(), []);
});

test("矛盾メモが残っていれば止める（空白だけのメモは無いものとして扱う）", () => {
  assert.equal(autoMergeBlockers({ notes: "## CLAUDE.md\n見出しが衝突" }).length, 1);
  assert.deepEqual(autoMergeBlockers({ notes: "  \n" }), []);
});

test("要マージを Claude が統合した同期は止める", () => {
  assert.equal(autoMergeBlockers({ needsMerge: true }).length, 1);
});

// sha には新旧の向きが無く、marketplace の遅れたマシンが巻き戻す PR を出しうる。
// skill 版の同期でも apply.mjs が sha を書き直すので、drift の種類ではなく記録の変化で止める
test("unity プラグインの記録 sha が変わる同期は止める", () => {
  const reasons = autoMergeBlockers({ unityShaChange: { from: "aaaaaaaa1", to: "bbbbbbbb2" } });
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /aaaaaaa→bbbbbbb/);
});

test("merge 方式は squash を優先し、許可が無ければ他へ落ちる", () => {
  assert.equal(pickMergeMethod({ squashMergeAllowed: true, mergeCommitAllowed: true }), "--squash");
  assert.equal(pickMergeMethod({ squashMergeAllowed: false, mergeCommitAllowed: true }), "--merge");
  assert.equal(pickMergeMethod({ rebaseMergeAllowed: true }), "--rebase");
  assert.equal(pickMergeMethod(null), null);
});
