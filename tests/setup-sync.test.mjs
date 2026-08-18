// テンプレート自動追随（setup-sync-state.json + setup-sync-check.mjs）のテスト。
//
// 観点:
//   1. setup-github apply が状態ファイルを書く（版・pr-copilot フラグ込み）
//   2. setup-github / setup-unity が同じ状態ファイルに各自のキーをマージ（相手を消さない）
//   3. hook: 状態ファイル無し / 版一致 / ダウングレード方向 / 壊れた JSON → 何も注入しない
//   4. hook: 現行版が新しい → launcher を detached 起動し、何も注入しない（旧版は通知していた）
//   5. hook: launcher が無い / SETUP_SYNC_NO_AUTO=1 → 起動せず通知へ落ちる（避難口）
//   6. report hook: 結果ファイルの有無・種別ごとの報告と、報告後に消えること

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { APPLY, APPLY_UNITY, SYNC_HOOK, SYNC_REPORT_HOOK, tempDir } from "./helpers.mjs";
/* global process, setTimeout */

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

// launcher を持つ偽のプラグイン install ディレクトリ。launcher は起動された事実と引数を
// マーカーファイルへ書くだけのスタブ（本物は worktree を作り裏 Claude を起こす）。
function fakeInstall(markerPath) {
  const root = tempDir("sync-install-");
  const dir = join(root, "skills", "setup-sync");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "sync-launch.mjs"),
    `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify(process.argv.slice(2)), "utf8");\n`,
    "utf8"
  );
  return root;
}

async function waitForFile(path, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

test("hook: 現行版が新しければ launcher を起動し、セッションには何も注入しない", async () => {
  const target = tempDir("sync-drift-");
  writeState(target, {
    "setup-github": { version: "1.0.0", flags: ["--pr-copilot", "--review-targets=Assets/App"] },
    "setup-unity": { version: "1.0.0", flags: ["--architecture", "--mcp", "mcp-for-unity"] },
  });
  const marker = join(tempDir("sync-marker-"), "launched.json");
  const out = runSyncHook(target, "1.3.0", { installPath: fakeInstall(marker) });
  // 旧版はここで「/setup-sync を実行して」と注入していた。従順性に賭けるのをやめたので無言。
  assert.equal(out, "", `セッション開始に何か注入された: ${out}`);
  assert.ok(await waitForFile(marker), "launcher が起動されなかった");
  assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), [target], "launcher に対象パスが渡っていない");
});

test("hook: launcher が見つからなければ黙って落ちず、手動実行を促す", () => {
  const target = tempDir("sync-nolauncher-");
  writeState(target, { "setup-github": { version: "1.0.0", flags: [] } });
  const ctx = JSON.parse(runSyncHook(target, "1.3.0", { installPath: "C:/plugins/project-setup/1.3.0" }))
    .hookSpecificOutput.additionalContext;
  assert.match(ctx, /setup-github v1\.0\.0→v1\.3\.0/);
  assert.match(ctx, /\/setup-sync/);
});

test("hook: SETUP_SYNC_NO_AUTO=1 なら起動せず通知だけに落ちる（避難口）", async () => {
  const target = tempDir("sync-noauto-");
  writeState(target, { "setup-github": { version: "1.0.0", flags: [] } });
  const marker = join(tempDir("sync-marker-"), "launched.json");
  const out = runSyncHook(target, "1.3.0", {
    installPath: fakeInstall(marker),
    env: { SETUP_SYNC_NO_AUTO: "1" },
  });
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /SETUP_SYNC_NO_AUTO/);
  assert.equal(await waitForFile(marker, 500), false, "NO_AUTO なのに launcher が起動した");
});

test("hook: 片方のスキルだけドリフトしていればそのスキルだけ対象にする", () => {
  const target = tempDir("sync-partial-");
  writeState(target, {
    "setup-github": { version: "1.3.0", flags: [] },
    "setup-unity": { version: "1.0.0", flags: ["--architecture"] },
  });
  // drift 判定の結果は通知文でしか観測できないため、避難口（通知のみ）で確認する。
  const out = runSyncHook(target, "1.3.0", { env: { SETUP_SYNC_NO_AUTO: "1" } });
  // setup-github は一致・setup-unity のみドリフト → setup-unity だけ注入
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /setup-unity v1\.0\.0→v1\.3\.0/);
  assert.doesNotMatch(ctx, /setup-github v/);
});

// ---- 報告 hook（UserPromptSubmit）----
// 裏で走った同期の結果を 1 回だけ報告して消す。動いているセッションへ外から差し込む口が
// 無いため、報告はここまで遅れる。

// launcher と同一仕様のキー算出（hook 側の実装が変わっていないことも同時に検証する）。
function resultKey(dir) {
  const norm = dir.replace(/[\\/]+$/, "");
  const canon = process.platform === "win32" ? norm.toLowerCase() : norm;
  let h = 0;
  for (let i = 0; i < canon.length; i++) h = (Math.imul(h, 31) + canon.charCodeAt(i)) | 0;
  const name = (canon.split(/[\\/]/).pop() || "repo").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
  return `${name}-${(h >>> 0).toString(16)}`;
}

function runReportHook(projectDir, result) {
  const dataDir = tempDir("sync-data-");
  const resultPath = join(dataDir, "results", `${resultKey(projectDir)}.json`);
  if (result !== undefined) {
    mkdirSync(join(dataDir, "results"), { recursive: true });
    writeFileSync(resultPath, typeof result === "string" ? result : JSON.stringify(result), "utf8");
  }
  const res = spawnSync(process.execPath, [SYNC_REPORT_HOOK], {
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: projectDir }),
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectDir,
      SETUP_SYNC_DATA_DIR: dataDir,
      SETUP_SYNC_DISABLE: "",
    },
  });
  assert.equal(res.status, 0, `report hook exited non-zero: ${res.stderr}`);
  return { out: res.stdout.trim(), resultPath };
}

test("report: 結果ファイルが無ければ何も注入しない", () => {
  const { out } = runReportHook(tempDir("sync-rep-none-"));
  assert.equal(out, "");
});

test("report: PR 作成の結果を URL 付きで 1 回報告し、結果ファイルを消す", () => {
  const target = tempDir("sync-rep-pr-");
  const { out, resultPath } = runReportHook(target, {
    status: "pr",
    message: "テンプレ同期 PR を作成しました（v1.13.0）",
    prUrl: "https://github.com/o/r/pull/42",
    repo: target,
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const ctx = parsed.hookSpecificOutput.additionalContext;
  assert.match(ctx, /https:\/\/github\.com\/o\/r\/pull\/42/);
  assert.match(ctx, /merge はしていません/);
  assert.equal(existsSync(resultPath), false, "報告後も結果ファイルが残っている（二度報告される）");
});

test("report: 失敗も黙らせず報告する", () => {
  const { out } = runReportHook(tempDir("sync-rep-fail-"), {
    status: "failed",
    message: "git fetch origin に失敗しました",
  });
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /失敗/);
  assert.match(ctx, /git fetch origin/);
});

test("report: 壊れた結果ファイルは捨てて何も注入しない", () => {
  const { out, resultPath } = runReportHook(tempDir("sync-rep-broken-"), "{ not json");
  assert.equal(out, "");
  assert.equal(existsSync(resultPath), false, "壊れた結果ファイルが残り毎回読まれる");
});

test("report: 別リポジトリの結果は拾わない（キーが異なる）", () => {
  const other = tempDir("sync-rep-other-");
  const dataDir = tempDir("sync-data-x-");
  mkdirSync(join(dataDir, "results"), { recursive: true });
  writeFileSync(
    join(dataDir, "results", `${resultKey(other)}.json`),
    JSON.stringify({ status: "pr", message: "x", prUrl: "https://example.invalid/1" }),
    "utf8"
  );
  const mine = tempDir("sync-rep-mine-");
  const res = spawnSync(process.execPath, [SYNC_REPORT_HOOK], {
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: mine }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: mine, SETUP_SYNC_DATA_DIR: dataDir, SETUP_SYNC_DISABLE: "" },
  });
  assert.equal(res.stdout.trim(), "");
  assert.ok(existsSync(join(dataDir, "results", `${resultKey(other)}.json`)), "他リポジトリの結果を消した");
  rmSync(dataDir, { recursive: true, force: true });
});
