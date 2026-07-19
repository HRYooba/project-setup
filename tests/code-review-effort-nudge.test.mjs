// code-review-effort-nudge.mjs の非干渉テスト。
//
// nudge は「Claude 発の code-review 起動に effort 引数が無ければ差し戻す」だけの hook。
// security-review 門番の追加で対象が広がっていないこと（/security-review の起動を
// 誤って差し戻さないこと）と、既存の code-review 向け挙動が壊れていないことを確認する。

import assert from "node:assert/strict";
import { test } from "node:test";
import { NUDGE, runHook, tempDir } from "./helpers.mjs";

// nudge は内部で gate --required を spawn する。CR_GATE_FILES/CR_GATE_LINES は子へ
// 環境変数で伝播し、git repo 無しでも決定的な推奨 effort（high）が算出される。
const env = { CR_GATE_FILES: "src/foo.ts", CR_GATE_LINES: "50" };

const skillInput = (skill, args = "") =>
  JSON.stringify({ tool_name: "Skill", tool_input: { skill, args }, cwd: tempDir("nudge-test-") });

test("security-review の起動は nudge の対象外（effort 引数なしでも allow）", () => {
  const r = runHook(NUDGE, skillInput("security-review"), env);
  assert.equal(r.decision, "allow");
});

test("SlashCommand の /security-review も対象外", () => {
  const input = JSON.stringify({
    tool_name: "SlashCommand",
    tool_input: { command: "/security-review" },
    cwd: tempDir("nudge-test-"),
  });
  assert.equal(runHook(NUDGE, input, env).decision, "allow");
});

test("code-review の effort 未指定は従来どおり deny（推奨 effort を提示）", () => {
  const r = runHook(NUDGE, skillInput("code-review"), env);
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /effort が未指定/);
});

test("code-review の effort 明示は従来どおり allow", () => {
  const r = runHook(NUDGE, skillInput("code-review", "high"), env);
  assert.equal(r.decision, "allow");
});

test("CR_GATE_DISABLE=1 で nudge も止まる", () => {
  const r = runHook(NUDGE, skillInput("code-review"), { ...env, CR_GATE_DISABLE: "1" });
  assert.equal(r.decision, "allow");
});
