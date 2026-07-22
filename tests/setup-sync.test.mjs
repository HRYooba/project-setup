// テンプレート自動追随（setup-sync-state.json + setup-sync-check.mjs）のテスト。
//
// 観点:
//   1. setup-github apply が状態ファイルを書く（版・pr-copilot フラグ込み）
//   2. setup-github / setup-unity が同じ状態ファイルに各自のキーをマージ（相手を消さない）
//   3. hook: 状態ファイル無し / 版一致 / ダウングレード方向 / 壊れた JSON → 何も注入しない
//   4. hook: 現行版が新しい → additionalContext で同期を促す（対象スキル・ブランチ名・apply コマンド）

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { APPLY, APPLY_UNITY, SYNC_HOOK, tempDir } from "./helpers.mjs";
/* global process */

function runApply(applyPath, target, args = []) {
  const res = spawnSync(process.execPath, [applyPath, target, ...args], { encoding: "utf8" });
  assert.equal(res.status, 0, `apply failed: ${res.stderr}\n${res.stdout}`);
  return res.stdout;
}

const PLUGIN_VERSION = JSON.parse(
  readFileSync(join(APPLY, "..", "..", "..", ".claude-plugin", "plugin.json"), "utf8")
).version;

// 偽の installed_plugins.json を書いて hook を本番同様 stdin JSON で起動する。
// 戻り値 stdout（空 = 何も注入しない）。
function runSyncHook(projectDir, currentVersion, { installPath = "C:/fake/project-setup/1.2.0", env = {} } = {}) {
  const dir = tempDir("sync-plugins-");
  const pluginsJson = join(dir, "installed_plugins.json");
  writeFileSync(
    pluginsJson,
    JSON.stringify({
      version: 2,
      plugins: {
        "project-setup@hryooba": [
          { scope: "user", installPath, version: currentVersion, lastUpdated: "2026-07-21T00:00:00.000Z" },
        ],
      },
    }),
    "utf8"
  );
  const res = spawnSync(process.execPath, [SYNC_HOOK], {
    input: JSON.stringify({ hook_event_name: "SessionStart", cwd: projectDir }),
    encoding: "utf8",
    env: { ...process.env, SETUP_SYNC_PLUGINS_JSON: pluginsJson, CLAUDE_PROJECT_DIR: projectDir, SETUP_SYNC_DISABLE: "", ...env },
  });
  assert.equal(res.status, 0, `hook exited non-zero: ${res.stderr}`);
  return res.stdout.trim();
}

function writeState(projectDir, obj) {
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  writeFileSync(join(projectDir, ".claude", "setup-sync-state.json"), JSON.stringify(obj, null, 2) + "\n", "utf8");
}

test("setup-github apply が状態ファイルへ版と pr-copilot フラグを記録する", () => {
  const target = tempDir("sync-gh-");
  runApply(APPLY, target, ["--pr-copilot", "--review-targets=src,shared"]);
  const state = JSON.parse(readFileSync(join(target, ".claude", "setup-sync-state.json"), "utf8"));
  assert.equal(state["setup-github"].version, PLUGIN_VERSION);
  assert.ok(state["setup-github"].flags.includes("--pr-copilot"));
  assert.ok(state["setup-github"].flags.includes("--review-targets=src,shared"));
});

test("setup-github と setup-unity が状態ファイルへ各自のキーをマージ（相手を消さない）", () => {
  const target = tempDir("sync-merge-");
  // 先に setup-unity（Unity プロジェクトの体裁を用意）
  mkdirSync(join(target, "ProjectSettings"), { recursive: true });
  writeFileSync(join(target, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 2022.3.0f1\n", "utf8");
  runApply(APPLY_UNITY, target, ["--architecture"]);
  let state = JSON.parse(readFileSync(join(target, ".claude", "setup-sync-state.json"), "utf8"));
  assert.equal(state["setup-unity"].version, PLUGIN_VERSION);
  assert.ok(state["setup-unity"].flags.includes("--architecture"));
  assert.ok(state["setup-unity"].flags.includes("--mcp"), "binding が --mcp で保存されていない");

  // 続けて setup-github → 両キーが揃う
  runApply(APPLY, target);
  state = JSON.parse(readFileSync(join(target, ".claude", "setup-sync-state.json"), "utf8"));
  assert.ok(state["setup-github"], "setup-github キーが無い");
  assert.ok(state["setup-unity"], "setup-github 適用で setup-unity キーが消えた");
  assert.ok(state["setup-unity"].flags.includes("--architecture"), "setup-unity のフラグが失われた");
});

test("hook: 状態ファイルが無ければ何も注入しない", () => {
  const target = tempDir("sync-none-");
  assert.equal(runSyncHook(target, "9.9.9"), "");
});

test("hook: 版が一致すれば何も注入しない", () => {
  const target = tempDir("sync-match-");
  writeState(target, { "setup-github": { version: PLUGIN_VERSION, flags: [] } });
  assert.equal(runSyncHook(target, PLUGIN_VERSION), "");
});

test("hook: 現行版のほうが古い（ダウングレード）なら何も注入しない", () => {
  const target = tempDir("sync-down-");
  writeState(target, { "setup-github": { version: "9.9.9", flags: [] } });
  assert.equal(runSyncHook(target, "1.0.0"), "");
});

test("hook: 壊れた状態ファイルは黙って無視する", () => {
  const target = tempDir("sync-broken-");
  mkdirSync(join(target, ".claude"), { recursive: true });
  writeFileSync(join(target, ".claude", "setup-sync-state.json"), "{ not json", "utf8");
  assert.equal(runSyncHook(target, "9.9.9"), "");
});

test("hook: 現行版が新しければ /setup-sync の実行を通知する（スキル・版・merge しない旨込み）", () => {
  const target = tempDir("sync-drift-");
  writeState(target, {
    "setup-github": { version: "1.0.0", flags: ["--pr-copilot", "--review-targets=Assets/App"] },
    "setup-unity": { version: "1.0.0", flags: ["--architecture", "--mcp", "mcp-for-unity"] },
  });
  const out = runSyncHook(target, "1.3.0", { installPath: "C:/plugins/project-setup/1.3.0" });
  assert.ok(out, "同期通知が注入されていない");
  const parsed = JSON.parse(out);
  const ctx = parsed.hookSpecificOutput.additionalContext;
  assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(ctx, /setup-github v1\.0\.0→v1\.3\.0/);
  assert.match(ctx, /setup-unity v1\.0\.0→v1\.3\.0/);
  // 通知のみ: 実行は /setup-sync に委ねる。apply コマンドや subagent 起動指示は注入しない。
  assert.match(ctx, /\/setup-sync/);
  assert.match(ctx, /merge はしません/);
  assert.doesNotMatch(ctx, /apply\.mjs/);
  assert.doesNotMatch(ctx, /worktree/);
});

test("hook: 片方のスキルだけドリフトしていればそのスキルだけ対象にする", () => {
  const target = tempDir("sync-partial-");
  writeState(target, {
    "setup-github": { version: "1.3.0", flags: [] },
    "setup-unity": { version: "1.0.0", flags: ["--architecture"] },
  });
  const out = runSyncHook(target, "1.3.0");
  // setup-github は一致・setup-unity のみドリフト → setup-unity だけ注入
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /setup-unity v1\.0\.0→v1\.3\.0/);
  assert.doesNotMatch(ctx, /setup-github v/);
});
