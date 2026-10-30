// 同期 PR の自動 merge 判定（auto-merge.mjs）のテスト。
// GitHub への問い合わせ（CI 待ち・merge）は対象外。止める理由と merge 方式の選び方だけを見る。

import assert from "node:assert/strict";
import { test } from "node:test";
import { autoMergeBlockers, pickMergeMethod } from "../skills/sync-setup/auto-merge.mjs";

const skillSync = { skill: "setup-github", basis: "skill", from: "1.0.0", to: "1.1.0" };
const shaSync = { skill: "setup-unity", basis: "unity-plugin", from: "aaa", to: "bbb" };

test("skill 版の同期だけで矛盾メモが無ければ merge してよい", () => {
  assert.deepEqual(autoMergeBlockers([skillSync], ""), []);
});

test("矛盾メモが残っていれば止める（空白だけのメモは無いものとして扱う）", () => {
  assert.equal(autoMergeBlockers([skillSync], "## CLAUDE.md\n見出しが衝突").length, 1);
  assert.deepEqual(autoMergeBlockers([skillSync], "  \n"), []);
});

// sha には新旧の向きが無く、marketplace の遅れたマシンが巻き戻す PR を出しうる
test("公式 unity プラグインの sha 同期を含めば止める", () => {
  const reasons = autoMergeBlockers([skillSync, shaSync], "");
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /aaa→bbb/);
});

test("merge 方式は squash を優先し、許可が無ければ他へ落ちる", () => {
  assert.equal(pickMergeMethod({ squashMergeAllowed: true, mergeCommitAllowed: true }), "--squash");
  assert.equal(pickMergeMethod({ squashMergeAllowed: false, mergeCommitAllowed: true }), "--merge");
  assert.equal(pickMergeMethod({ rebaseMergeAllowed: true }), "--rebase");
  assert.equal(pickMergeMethod(null), null);
});
