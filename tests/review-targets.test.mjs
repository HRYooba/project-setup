// setup-unity が review-config.json の reviewTargets を宣言する挙動の検証。
//
// この設定は 2 つの読み手を持つ（どちらも setup-github の配布物）:
//   - .claude/hooks/lib/reviewable-files.mjs → Copilot 自動アサインの対象判定
//   - .claude/CLAUDE.md の /code-review / /security-review 指示 → コマンドの対象範囲
// 片方だけに効く状態になると「Copilot は付くのに手動レビューは全部見る」食い違いが戻るため、
// 書き込み先と値の形をここで固定する。
//
// 観点:
//   1. config が無い（setup-github 未実行）なら作らない
//   2. --review-target で Assets/App/ が入る。既存の他フォルダは消さない
//   3. 二重適用で重複しない（末尾スラッシュのゆらぎも吸収する）
//   4. --no-review-target で取り除ける（他フォルダは残る）
//   5. フラグ無しなら触らない
//   6. 両方同時指定は落とす（どちらが勝ったか分からない書き換えを避ける）
//   7. 選択は sync-setup-state.json に残る（テンプレ同期が同じ形で再適用できる）

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { APPLY_UNITY, tempDir } from "./helpers.mjs";
/* global process */

const CONFIG_REL = join(".claude", "hooks", "review-config.json");

function unityProject(reviewTargets) {
  const target = tempDir("review-targets-");
  mkdirSync(join(target, "ProjectSettings"), { recursive: true });
  writeFileSync(
    join(target, "ProjectSettings", "ProjectVersion.txt"),
    "m_EditorVersion: 6000.3.18f1\n",
    "utf8"
  );
  if (reviewTargets !== undefined) {
    mkdirSync(join(target, ".claude", "hooks"), { recursive: true });
    writeFileSync(
      join(target, CONFIG_REL),
      JSON.stringify(
        { reviewTargets, reviewExcludes: [".claude/", ".github/", ".githooks/"] },
        null,
        2
      ) + "\n",
      "utf8"
    );
  }
  return target;
}

function runApply(target, args = []) {
  const res = spawnSync(process.execPath, [APPLY_UNITY, target, ...args], { encoding: "utf8" });
  assert.equal(res.status, 0, `apply failed: ${res.stderr}\n${res.stdout}`);
  return res.stdout;
}

function readConfig(target) {
  return JSON.parse(readFileSync(join(target, CONFIG_REL), "utf8"));
}

// config を持たない配備先へ勝手に作ると、読み手（reviewable-files.mjs / CLAUDE.md 指示）が
// 居ないので効かないうえ、次の setup-github が「温存」と読んで質問の既定値まで汚す。
test("review-config.json が無ければ作らない", () => {
  const target = unityProject(undefined);
  const out = runApply(target, ["--review-target"]);
  assert.equal(existsSync(join(target, CONFIG_REL)), false);
  assert.match(out, /未配置（setup-github 未実行のため書きませんでした）/);
});

test("--review-target で Assets/App/ が入る（既存フォルダは残す）", () => {
  const target = unityProject(["src/"]);
  runApply(target, ["--review-target"]);
  assert.deepEqual(readConfig(target).reviewTargets, ["src/", "Assets/App/"]);
});

test("--review-target を二重適用しても重複しない（ゆらぎも吸収）", () => {
  const target = unityProject(["Assets/App"]);
  runApply(target, ["--review-target"]);
  assert.deepEqual(readConfig(target).reviewTargets, ["Assets/App/"]);
  runApply(target, ["--review-target"]);
  assert.deepEqual(readConfig(target).reviewTargets, ["Assets/App/"]);
});

test("--no-review-target で取り除く（他フォルダは残す）", () => {
  const target = unityProject(["src/", "Assets/App/"]);
  runApply(target, ["--no-review-target"]);
  assert.deepEqual(readConfig(target).reviewTargets, ["src/"]);
});

test("reviewExcludes は触らない", () => {
  const target = unityProject([]);
  runApply(target, ["--review-target"]);
  assert.deepEqual(readConfig(target).reviewExcludes, [".claude/", ".github/", ".githooks/"]);
});

test("フラグ無しなら reviewTargets を触らない", () => {
  const target = unityProject(["src/"]);
  const out = runApply(target);
  assert.deepEqual(readConfig(target).reviewTargets, ["src/"]);
  assert.match(out, /指定なし（現状のまま）/);
});

test("--review-target と --no-review-target の同時指定は落とす", () => {
  const target = unityProject(["src/"]);
  const res = spawnSync(
    process.execPath,
    [APPLY_UNITY, target, "--review-target", "--no-review-target"],
    { encoding: "utf8" }
  );
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /同時に指定できません/);
  assert.deepEqual(readConfig(target).reviewTargets, ["src/"]);
});

// テンプレ同期は state の flags をそのまま渡して再適用する。ここに残らないと、
// 同期のたびに「指定なし」で走って設定が現状維持になる（= 選択が伝わらない）。
test("選択は sync-setup-state.json の flags に残る", () => {
  const on = unityProject(["src/"]);
  runApply(on, ["--review-target"]);
  const stateOn = JSON.parse(readFileSync(join(on, ".claude", "sync-setup-state.json"), "utf8"));
  assert.ok(stateOn["setup-unity"].flags.includes("--review-target"));

  const off = unityProject(["src/"]);
  runApply(off, ["--no-review-target"]);
  const stateOff = JSON.parse(readFileSync(join(off, ".claude", "sync-setup-state.json"), "utf8"));
  assert.ok(stateOff["setup-unity"].flags.includes("--no-review-target"));
});
