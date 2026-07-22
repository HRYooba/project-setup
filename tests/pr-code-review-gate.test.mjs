// pr-code-review-gate.mjs の deny/allow 分岐テスト。
//
// 観点:
//   1. code-review / security-review 両方の実行有無で合否が決まる（不足分はまとめて 1 回の deny）
//   2. anchor（直近の成功した gh pr create）より前のレビューは数えない
//   3. レビュー対象外の差分（docs のみ等）はレビュー不要で素通り
//   4. 中断・起動失敗（is_error）のレビューは数えない
//   5. CR_GATE_DISABLE=1 の脱出口・不正入力の fail-open

import assert from "node:assert/strict";
import { test } from "node:test";
import { runGate, runHook, successfulPrCreate, toolResult, toolUse, typedCommand, GATE } from "./helpers.mjs";

// 完了済みレビュー（Skill 起動 + 正常な tool_result）の 2 行。
const doneReview = (skill, id, args = "") => [
  toolUse("Skill", { skill, args }, id),
  toolResult(id, "レビュー完了。指摘 0 件。"),
];

test("両レビュー済み（Skill）→ allow", () => {
  const r = runGate([
    ...doneReview("code-review", "toolu_cr", "high"),
    ...doneReview("security-review", "toolu_sr"),
  ]);
  assert.equal(r.decision, "allow");
});

test("code-review のみ済み → security-review だけを deny で要求", () => {
  const r = runGate([...doneReview("code-review", "toolu_cr", "high")]);
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /\/security-review/);
  assert.ok(!r.reason.includes("`/code-review"), `code-review を再要求している: ${r.reason}`);
});

test("security-review のみ済み → code-review だけを deny で要求（推奨 effort 付き）", () => {
  const r = runGate([...doneReview("security-review", "toolu_sr")]);
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /`\/code-review (?:medium|high|xhigh|max)`/);
  assert.ok(!r.reason.includes("`/security-review`"), `security-review を再要求している: ${r.reason}`);
});

test("推奨 effort: 小規模は high（下限 high）", () => {
  const r = runGate([...doneReview("security-review", "toolu_sr")], {
    env: { CR_GATE_FILES: "src/foo.ts", CR_GATE_LINES: "50" },
  });
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /`\/code-review high`/);
});

test("推奨 effort: 大規模でも xhigh 止まり（max にしない）", () => {
  const many = Array.from({ length: 15 }, (_, i) => `src/f${i}.ts`).join("\n");
  const r = runGate([...doneReview("security-review", "toolu_sr")], {
    env: { CR_GATE_FILES: many, CR_GATE_LINES: "900" },
  });
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /`\/code-review xhigh`/);
  assert.ok(!/`\/code-review max`/.test(r.reason), `max を自動推奨している: ${r.reason}`);
});

test("どちらも未実行 → 両方をまとめて 1 回の deny で要求", () => {
  const r = runGate([]);
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /`\/code-review /);
  assert.match(r.reason, /`\/security-review`/);
});

test("SlashCommand 経由のレビューもカウントされる", () => {
  const lines = [
    toolUse("SlashCommand", { command: "/code-review high" }, "toolu_cr"),
    toolResult("toolu_cr", "done"),
    toolUse("SlashCommand", { command: "/security-review" }, "toolu_sr"),
    toolResult("toolu_sr", "done"),
  ];
  assert.equal(runGate(lines).decision, "allow");
});

test("ユーザー手打ち（<command-name> 形式）もカウントされる", () => {
  const lines = [typedCommand("/code-review", "max"), typedCommand("/security-review")];
  assert.equal(runGate(lines).decision, "allow");
});

// 回帰: 最新 Claude Code は手打ちコマンド content 先頭へ <command-message> を前置きする。
// 旧 typedRe は `^\s*<command-name>` 行頭固定だったためこの前置きに負けて手打ちレビューを
// 取りこぼし、deny 連発＝「レビュー後 HEAD 動く→再レビュー」ループを起こしていた（実 transcript で確認）。
test("手打ち <command-message> 前置き形式（最新版）もカウントされる（ループ回帰）", () => {
  const typed = (name, args = "") =>
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: `<command-message>${name.replace(/^\//, "")}</command-message>\n<command-name>${name}</command-name>\n<command-args>${args}</command-args>`,
      },
    });
  const lines = [typed("/code-review", "max"), typed("/security-review")];
  assert.equal(runGate(lines).decision, "allow");
});

test("手打ち 旧形式（<command-message> 無し）も後方互換でカウントされる", () => {
  const typed = (name, args = "") =>
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: `<command-name>${name}</command-name>\n<command-args>${args}</command-args>`,
      },
    });
  const lines = [typed("/code-review", "max"), typed("/security-review")];
  assert.equal(runGate(lines).decision, "allow");
});

test("plugin プレフィックス付き Skill 名（foo:code-review）もカウントされる", () => {
  const lines = [
    ...doneReview("myplugin:code-review", "toolu_cr", "high"),
    ...doneReview("myplugin:security-review", "toolu_sr"),
  ];
  assert.equal(runGate(lines).decision, "allow");
});

test("引数に名前を含むだけの別コマンドは幻のレビュー実績にならない", () => {
  const lines = [
    toolUse("Skill", { skill: "create-issue", args: "code-review と security-review の対応" }, "toolu_ci"),
    toolResult("toolu_ci", "issue created"),
  ];
  assert.equal(runGate(lines).decision, "deny");
});

test("is_error のレビュー（ESC 中断・起動失敗）は数えない", () => {
  const lines = [
    toolUse("Skill", { skill: "code-review", args: "high" }, "toolu_cr"),
    toolResult("toolu_cr", "interrupted", true),
    ...doneReview("security-review", "toolu_sr"),
  ];
  const r = runGate(lines);
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /`\/code-review /);
});

test("tool_result が無いレビュー起動（in-flight・中断）は数えない", () => {
  const lines = [
    toolUse("Skill", { skill: "security-review" }, "toolu_sr"),
    ...doneReview("code-review", "toolu_cr", "high"),
  ];
  const r = runGate(lines);
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /`\/security-review`/);
});

test("anchor: 成功した gh pr create より前のレビューは次の PR に流用できない", () => {
  const lines = [
    ...doneReview("code-review", "toolu_cr", "high"),
    ...doneReview("security-review", "toolu_sr"),
    ...successfulPrCreate("toolu_pr"),
  ];
  const r = runGate(lines);
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /`\/code-review /);
  assert.match(r.reason, /`\/security-review`/);
});

test("anchor: --web の成功試行（PR URL なし）も区切りになる", () => {
  const lines = [
    ...doneReview("code-review", "toolu_cr", "high"),
    ...doneReview("security-review", "toolu_sr"),
    toolUse("Bash", { command: "gh pr create --web" }, "toolu_pr"),
    toolResult("toolu_pr", "Opening https://github.com/example/repo/compare/main...feat in your browser."),
  ];
  assert.equal(runGate(lines).decision, "deny");
});

test("anchor: 失敗した試行（deny・エラー）はリトライ扱いで区切りにならない", () => {
  const lines = [
    ...doneReview("code-review", "toolu_cr", "high"),
    ...doneReview("security-review", "toolu_sr"),
    toolUse("Bash", { command: "gh pr create --fill" }, "toolu_pr"),
    toolResult("toolu_pr", "permission denied by hook", true),
  ];
  assert.equal(runGate(lines).decision, "allow");
});

test("anchor 後に両レビューをやり直せば allow", () => {
  const lines = [
    ...successfulPrCreate("toolu_pr1"),
    ...doneReview("code-review", "toolu_cr2", "high"),
    ...doneReview("security-review", "toolu_sr2"),
  ];
  assert.equal(runGate(lines).decision, "allow");
});

test("複合コマンド（git push && gh pr create）も入口判定で捕捉される", () => {
  const r = runGate([], { command: "git push -u origin feat && gh pr create --fill" });
  assert.equal(r.decision, "deny");
});

test("レビュー対象外の差分のみ（docs 等）はレビュー不要で allow", () => {
  const r = runGate([], { env: { CR_GATE_FILES: "README.md\ndocs/guide.md", CR_GATE_LINES: "0" } });
  assert.equal(r.decision, "allow");
});

test("除外フォルダ（.claude/ 等）のみの差分は allow", () => {
  const r = runGate([], {
    env: { CR_GATE_FILES: ".claude/hooks/pr-code-review-gate.mjs", CR_GATE_LINES: "0" },
  });
  assert.equal(r.decision, "allow");
});

test("gh pr create 以外のコマンドは無関係で allow", () => {
  const r = runGate([], { command: "git status" });
  assert.equal(r.decision, "allow");
});

test("CR_GATE_DISABLE=1 は security 判定にも効く（全体を無効化）", () => {
  const r = runGate([], { env: { CR_GATE_DISABLE: "1" } });
  assert.equal(r.decision, "allow");
});

test("不正な stdin は fail-open（allow）", () => {
  const r = runHook(GATE, "not-json{{{");
  assert.equal(r.decision, "allow");
});

test("transcript が読めない場合は fail-closed（deny）", () => {
  const input = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: "gh pr create --fill" },
    transcript_path: "Z:\\no\\such\\transcript.jsonl",
    cwd: process.cwd(),
  });
  const r = runHook(GATE, input, { CR_GATE_FILES: "src/foo.ts", CR_GATE_LINES: "50" });
  assert.equal(r.decision, "deny");
});
/* global process */
