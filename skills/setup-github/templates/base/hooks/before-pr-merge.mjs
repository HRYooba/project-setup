// PreToolUse(Bash) hook: Claude の `gh pr merge` を、マージを止める条件があるとき拒否する。
// 条件の定義は lib/merge-readiness.mjs が正本。
//
// GitHub 側の check（merge-gate.yml）はブランチ保護の無い private / Free プランでは
// マージを止められず、スレッド解決では再評価もされない。ここではマージ直前の状態を取り直して判定する。
//
// gh や API が失敗したときは止めない（判定できないことを理由に拒否し続ける門番は、
// 結局外されて何も守らなくなる）。

import { describe, fetchState, judge, parseMergeArgs } from "./lib/merge-readiness.mjs";
import { readStdin } from "./lib/reviewable-files.mjs";
/* global process */

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
}

let data;
try {
  data = JSON.parse((await readStdin()).replace(/^\uFEFF/, ""));
} catch {
  process.exit(0);
}
const parsed = parseMergeArgs(data?.tool_input?.command ?? "");
if (!parsed) process.exit(0);

let state;
try {
  state = fetchState(parsed.pr, { repo: parsed.repo });
} catch {
  process.exit(0);
}
const problems = judge(state);
if (problems.length) {
  deny(
    [
      `PR #${state.number} はまだマージできない:`,
      ...describe(problems, state.number).map((l) => `- ${l}`),
      "条件を満たしてから gh pr merge をやり直す。",
    ].join("\n")
  );
}
