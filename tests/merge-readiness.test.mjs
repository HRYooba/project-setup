// マージ可否の判定（merge-readiness.mjs）と、gh pr merge の引数解釈のテスト。
// GitHub への問い合わせ（fetchState）は対象外。取得済みの状態から判定する部分と、取るフィールドの選び方だけを見る。

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { HOOKS_DIR } from "./helpers.mjs";
/* global process */

const { judge, parseMergeArgs, resolveMergeCwd, viewFields, GATE_WORKFLOW } = await import(
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

test("includeChecks: false では statusCheckRollup を取らない", () => {
  // workflow の GITHUB_TOKEN は checks / statuses の読み取り権限を持たず、取ると GraphQL が拒否する
  assert.ok(!viewFields({ includeChecks: false }).split(",").includes("statusCheckRollup"));
  assert.ok(viewFields().split(",").includes("statusCheckRollup"));
});

test("gh pr merge の PR 指定とリポジトリ指定を取り出す", () => {
  assert.deepEqual(parseMergeArgs("gh pr merge 12 --squash"), { pr: "12", repo: undefined, cd: [] });
  assert.deepEqual(parseMergeArgs("gh pr merge --squash -R o/r 12"), { pr: "12", repo: "o/r", cd: [] });
  assert.deepEqual(parseMergeArgs('gh pr merge -t "a b" --repo=o/r'), { pr: undefined, repo: "o/r", cd: [] });
  assert.deepEqual(parseMergeArgs("GH_REPO=o/r gh pr merge 3"), { pr: "3", repo: "o/r", cd: [] });
});

test("gh pr merge より前の cd を辿る", () => {
  assert.deepEqual(parseMergeArgs("cd x && gh pr merge feat/y --merge; echo ok").cd, ["x"]);
  assert.deepEqual(parseMergeArgs('cd "/c/a b" && cd sub; gh pr merge 4').cd, ["/c/a b", "sub"]);
  assert.deepEqual(parseMergeArgs("(cd x && gh pr merge 4)").cd, ["x"]);
  // merge より後の cd は効かない
  assert.deepEqual(parseMergeArgs("gh pr merge 4 && cd y").cd, []);
});

test("辿れない cd は null", () => {
  for (const cmd of [
    "cd $REPO && gh pr merge 4",
    "cd - && gh pr merge 4",
    "pushd x && gh pr merge 4",
    "(cd x); gh pr merge 4",
  ]) {
    assert.equal(parseMergeArgs(cmd).cd, null, cmd);
  }
});

test("gh を動かすディレクトリを cd から決める", () => {
  const base = mkdtempSync(join(tmpdir(), "mr-"));
  mkdirSync(join(base, "other"));
  const at = (cmd, opts) => resolveMergeCwd(parseMergeArgs(cmd), base, opts);
  assert.equal(at("gh pr merge 4"), base);
  assert.equal(at("cd other && gh pr merge 4"), join(base, "other"));
  assert.equal(at("cd ~ && gh pr merge 4", { home: join(base, "other") }), join(base, "other"));
  // 対象が引数で決まっていれば cd は見ない
  assert.equal(at("cd $X && gh pr merge 4 -R o/r"), base);
  assert.equal(at("cd $X && gh pr merge https://github.com/o/r/pull/4"), base);
  // 辿れない・行き先が無いなら判定しない
  assert.equal(at("cd $X && gh pr merge 4"), null);
  assert.equal(at("cd missing && gh pr merge 4"), null);
});

test("Windows では Git Bash の /c/... をドライブパスにする", { skip: process.platform !== "win32" }, () => {
  const base = mkdtempSync(join(tmpdir(), "mr-"));
  const msys = "/" + base[0].toLowerCase() + base.slice(2).replace(/\\/g, "/");
  assert.equal(resolveMergeCwd(parseMergeArgs(`cd ${msys} && gh pr merge 4`), "C:\\"), base);
});

test("gh pr merge の呼び出しでなければ null", () => {
  assert.equal(parseMergeArgs("gh pr view 12"), null);
  assert.equal(parseMergeArgs('echo "gh pr merge 12"'), null);
});
