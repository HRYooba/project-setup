// PR の hook（before-pr-merge.mjs / after-pr-create.mjs）が、PowerShell ツールの入力でも
// Bash ツールの入力と同じ判定を返すか。配備物を temp へ撒き、gh を偽物へ差し替えて走らせる。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { APPLY, tempDir } from "./helpers.mjs";
/* global process */

const target = tempDir("pr-hooks-");
{
  const res = spawnSync(process.execPath, [APPLY, target, "--pr-copilot", "--review-targets=src"], { encoding: "utf8" });
  assert.equal(res.status, 0, `apply failed: ${res.stderr}\n${res.stdout}`);
}
const hook = (name) => join(target, ".claude", "hooks", name);

// behindBy: compare が返す遅れ。PR の他の状態（CI・スレッド）は問題なしで返す。
function fakeGh({ behindBy = 0 } = {}) {
  const bin = join(tempDir("fake-gh-"), "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bash
case "$1 $2" in
  "pr view") echo '{"number":12,"url":"https://github.com/o/r/pull/12","baseRefName":"main","headRefOid":"abc","statusCheckRollup":[]}' ;;
  "pr diff") echo "src/a.ts" ;;
  "api graphql") echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}' ;;
  "api repos/"*) echo ${behindBy} ;;
  "api --method") echo '{}' ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 }
  );
  return bin;
}

function runHook(name, input, bin) {
  const r = spawnSync(process.execPath, [hook(name)], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

const mergeInput = (tool_name, command) => ({
  hook_event_name: "PreToolUse",
  tool_name,
  tool_input: { command },
  cwd: target,
});

for (const [label, behindBy, expectDeny] of [
  ["止める条件があれば", 3, true],
  ["止める条件が無ければ", 0, false],
]) {
  test(`before-pr-merge: ${label} PowerShell 形も Bash 形と同じ判定を返す`, () => {
    const bin = fakeGh({ behindBy });
    const bash = runHook("before-pr-merge.mjs", mergeInput("Bash", "gh pr merge 12 --squash"), bin);
    const ps = runHook("before-pr-merge.mjs", mergeInput("PowerShell", "gh pr merge 12 --squash"), bin);
    assert.equal(ps, bash);
    if (expectDeny) assert.equal(JSON.parse(bash).hookSpecificOutput.permissionDecision, "deny");
    else assert.equal(bash, "");
  });
}

const createInput = (tool_name, tool_response) => ({
  hook_event_name: "PostToolUse",
  tool_name,
  tool_input: { command: "gh pr create --fill" },
  tool_response,
  cwd: target,
});
const PR_URL = "https://github.com/o/r/pull/12\n";

test("after-pr-create: PowerShell 形も Bash 形と同じ判定を返す", () => {
  const bin = fakeGh();
  const bash = runHook("after-pr-create.mjs", createInput("Bash", { stdout: PR_URL, stderr: "" }), bin);
  assert.match(JSON.parse(bash).hookSpecificOutput.additionalContext, /PR #12: Copilot レビューを自動依頼しました/);
  // PowerShell の tool_response の形は文書化されていないため、想定しうる形をすべて確かめる。
  for (const response of [{ stdout: PR_URL, stderr: "" }, PR_URL, { output: PR_URL }]) {
    const ps = runHook("after-pr-create.mjs", createInput("PowerShell", response), bin);
    assert.equal(ps, bash, `tool_response=${JSON.stringify(response)}`);
  }
});

test("after-pr-create: PR URL が無ければ PowerShell 形でも何もしない", () => {
  const bin = fakeGh();
  for (const response of [{ stdout: "" }, "", undefined, { output: "error" }]) {
    assert.equal(runHook("after-pr-create.mjs", createInput("PowerShell", response), bin), "");
  }
});
