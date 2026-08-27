// テンプレート更新の検知（setup-sync-state.json + setup-sync-check.mjs）のテスト。
//
// 観点:
//   1. setup-github apply が状態ファイルを書く（版・pr-copilot フラグ込み）
//   2. setup-github / setup-unity が同じ状態ファイルに各自のキーをマージ（相手を消さない）
//   3. hook: 状態ファイル無し / 版一致 / ダウングレード方向 / 壊れた JSON → 何も出さない
//   4. hook: 現行版が新しい → systemMessage（ユーザー向け）と additionalContext（Claude 向け）
//      の両方を出す。additionalContext だけだと画面に出ず人間が気づけない
//   5. hook: 子プロセスを起こさない（同期は /setup-sync 側で走らせる）
//   6. hook: SETUP_SYNC_DISABLE=1 で黙る（避難口）

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


// ---- 更新を検知したときの出力 ----
// hook は知らせるだけ。強制はできない（SessionStart は仕様上ブロックできない）ので、
// **ユーザーの画面に出る systemMessage** を出すことが「気づかれる」ための唯一の手段になる。

test("hook: 現行版が新しければ systemMessage と additionalContext の両方を出す", () => {
  const target = tempDir("sync-drift-");
  writeState(target, {
    "setup-github": { version: "1.0.0", flags: ["--pr-copilot", "--review-targets=Assets/App"] },
    "setup-unity": { version: "1.0.0", flags: ["--architecture", "--mcp", "mcp-for-unity"] },
  });
  const out = JSON.parse(runSyncHook(target, "1.3.0"));

  // ユーザーの画面に出る行。additionalContext だけだと Claude が触れない限り誰も気づかない。
  assert.match(out.systemMessage, /setup-github v1\.0\.0→v1\.3\.0/);
  assert.match(out.systemMessage, /setup-unity v1\.0\.0→v1\.3\.0/);
  assert.match(out.systemMessage, /\/setup-sync/);

  // Claude 向けの手順。
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(out.hookSpecificOutput.additionalContext, /\/project-setup:setup-sync/);
});

test("hook: 子プロセスを起こさない（同期は /setup-sync 側で走らせる）", () => {
  const src = readFileSync(SYNC_HOOK, "utf8");
  const spawners = [...src.matchAll(/\b(spawn|spawnSync|execFile|execFileSync|exec|execSync)\s*\(/g)];
  assert.deepEqual(
    spawners.map((m) => m[1]),
    [],
    "hook が子プロセスを起こしています。ここは検知だけに徹する"
  );
});

test("hook: 片方のスキルだけドリフトしていればそのスキルだけ対象にする", () => {
  const target = tempDir("sync-partial-");
  writeState(target, {
    "setup-github": { version: "1.3.0", flags: [] },
    "setup-unity": { version: "1.0.0", flags: ["--architecture"] },
  });
  const out = JSON.parse(runSyncHook(target, "1.3.0"));
  assert.match(out.systemMessage, /setup-unity v1\.0\.0→v1\.3\.0/);
  assert.doesNotMatch(out.systemMessage, /setup-github v/);
});

test("hook: SETUP_SYNC_DISABLE=1 なら黙る（避難口）", () => {
  const target = tempDir("sync-disable-");
  writeState(target, { "setup-github": { version: "1.0.0", flags: [] } });
  assert.equal(runSyncHook(target, "1.3.0", { env: { SETUP_SYNC_DISABLE: "1" } }), "");
});
