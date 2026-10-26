// マージ可否の判定（merge-readiness.mjs）と、gh pr merge の引数解釈のテスト。
// GitHub への問い合わせ（fetchState）は対象外。取得済みの状態から判定する部分だけを見る。

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { HOOKS_DIR } from "./helpers.mjs";

const { judge, parseMergeArgs, GATE_WORKFLOW } = await import(
  pathToFileURL(join(HOOKS_DIR, "lib", "merge-readiness.mjs")).href
);

const run = (workflowName, status, conclusion) => ({
  __typename: "CheckRun",
  name: "check",
  workflowName,
  status,
  conclusion,
});
const kinds = (problems) => problems.map((p) => p.kind);

test("条件が揃えば止めない", () => {
  assert.deepEqual(judge({ checks: [run("ci", "COMPLETED", "SUCCESS")], unresolvedThreads: 0, behindBy: 0 }), []);
});

test("CI の失敗・未完了・スレッド・遅れをそれぞれ止める", () => {
  const problems = judge({
    checks: [
      run("ci", "COMPLETED", "FAILURE"),
      run("lint", "IN_PROGRESS", null),
      { __typename: "StatusContext", context: "ext", state: "PENDING" },
    ],
    unresolvedThreads: 2,
    behindBy: 3,
  });
  assert.deepEqual(kinds(problems), ["failed", "pending", "threads", "behind"]);
  assert.deepEqual(problems[1].detail, ["lint / check", "ext"]);
});

test("merge-gate 自身の check は CI 条件に数えない", () => {
  // 数えると、赤くなった gate が自分を理由に赤のまま残り、マージを永久に止める
  assert.deepEqual(judge({ checks: [run(GATE_WORKFLOW, "COMPLETED", "FAILURE")] }), []);
});

test("includeChecks: false では CI を見ない", () => {
  assert.deepEqual(
    kinds(judge({ checks: [run("ci", "IN_PROGRESS", null)], behindBy: 1 }, { includeChecks: false })),
    ["behind"]
  );
});

test("gh pr merge の PR 指定とリポジトリ指定を取り出す", () => {
  assert.deepEqual(parseMergeArgs("gh pr merge 12 --squash"), { pr: "12", repo: undefined });
  assert.deepEqual(parseMergeArgs("gh pr merge --squash -R o/r 12"), { pr: "12", repo: "o/r" });
  assert.deepEqual(parseMergeArgs('gh pr merge -t "a b" --repo=o/r'), { pr: undefined, repo: "o/r" });
  assert.deepEqual(parseMergeArgs("cd x && gh pr merge feat/y --merge; echo ok"), { pr: "feat/y", repo: undefined });
});

test("gh pr merge の呼び出しでなければ null", () => {
  assert.equal(parseMergeArgs("gh pr view 12"), null);
  assert.equal(parseMergeArgs('echo "gh pr merge 12"'), null);
});
