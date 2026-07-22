// sync-run.mjs（方式B の実行本体）の決定的コア（drift 判定・計画・ガード）のテスト。
//
// git/gh を伴う副作用（branch/commit/push/PR）は CI で再現しづらいため、副作用に入る前の
// 決定的な部分だけを検証する:
//   - --dry-run: 同期計画の算出（対象スキル・保存フラグ・ブランチ・試行回数）と、副作用ゼロ
//   - drift 無し / 状態ファイル無し → 何もしないで exit 0
//   - 試行上限ガード（非 dry-run でも副作用前に停止し、試行回数を増やさない）

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SYNC_RUN, tempDir } from "./helpers.mjs";
/* global process */

// 偽の installed_plugins.json を書き、sync-run.mjs を本番同様に子プロセスで起動する。
function runSyncRun(target, currentVersion, { dryRun = false, attemptsPath, maxAttempts, installPath } = {}) {
  const dir = tempDir("syncrun-plugins-");
  const pluginsJson = join(dir, "installed_plugins.json");
  writeFileSync(
    pluginsJson,
    JSON.stringify({
      version: 2,
      plugins: {
        "project-setup@hryooba": [
          {
            scope: "user",
            installPath: installPath || "C:/fake/project-setup/current",
            version: currentVersion,
            lastUpdated: "2026-07-21T00:00:00.000Z",
          },
        ],
      },
    }),
    "utf8"
  );
  const args = [SYNC_RUN, target];
  if (dryRun) args.push("--dry-run");
  const env = { ...process.env, SETUP_SYNC_PLUGINS_JSON: pluginsJson };
  if (attemptsPath) env.SETUP_SYNC_ATTEMPTS_JSON = attemptsPath;
  if (maxAttempts != null) env.SETUP_SYNC_MAX_ATTEMPTS = String(maxAttempts);
  const res = spawnSync(process.execPath, args, { encoding: "utf8", env });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function writeState(target, obj) {
  mkdirSync(join(target, ".claude"), { recursive: true });
  writeFileSync(join(target, ".claude", "setup-sync-state.json"), JSON.stringify(obj, null, 2) + "\n", "utf8");
}

test("dry-run: drift があれば計画（スキル・保存フラグ・ブランチ）を出し、副作用を起こさない", () => {
  const target = tempDir("syncrun-plan-");
  writeState(target, {
    "setup-github": { version: "1.0.0", flags: ["--pr-copilot", "--review-targets=src"] },
  });
  const attemptsPath = join(tempDir("syncrun-att-"), "attempts.json");
  const { status, stdout } = runSyncRun(target, "1.3.0", { dryRun: true, attemptsPath });
  assert.equal(status, 0);
  assert.match(stdout, /setup-github: v1\.0\.0 → v1\.3\.0/);
  assert.match(stdout, /--pr-copilot --review-targets=src/);
  assert.match(stdout, /chore\/setup-sync-v1\.3\.0/);
  assert.match(stdout, /dry-run/);
  // 副作用ゼロ: 試行回数ファイルは作られない。
  assert.ok(!existsSync(attemptsPath), "dry-run で試行回数ファイルが作られた");
});

test("状態ファイルが無ければ同期対象外で exit 0", () => {
  const target = tempDir("syncrun-nostate-");
  const { status, stdout } = runSyncRun(target, "1.3.0", { dryRun: true });
  assert.equal(status, 0);
  assert.match(stdout, /同期対象外/);
});

test("記録版と現行版が同じなら同期不要で exit 0", () => {
  const target = tempDir("syncrun-match-");
  writeState(target, { "setup-github": { version: "1.3.0", flags: [] } });
  const { status, stdout } = runSyncRun(target, "1.3.0", { dryRun: true });
  assert.equal(status, 0);
  assert.match(stdout, /同期不要/);
});

test("ダウングレード方向（記録版のほうが新しい）は同期不要", () => {
  const target = tempDir("syncrun-down-");
  writeState(target, { "setup-github": { version: "9.9.9", flags: [] } });
  const { status, stdout } = runSyncRun(target, "1.3.0", { dryRun: true });
  assert.equal(status, 0);
  assert.match(stdout, /同期不要/);
});

test("試行上限に達していれば非 dry-run でも副作用前に停止し、試行回数を増やさない", () => {
  const target = tempDir("syncrun-cap-");
  writeState(target, { "setup-github": { version: "1.0.0", flags: [] } });
  const attemptsDir = tempDir("syncrun-capatt-");
  const attemptsPath = join(attemptsDir, "attempts.json");
  // 現行版キーで既に上限（2）に達している状態を用意する。
  // キーは "<origin url or target>@v<version>"。git repo でない temp dir では target がキー。
  writeFileSync(attemptsPath, JSON.stringify({ [`${target}@v1.3.0`]: 2 }, null, 2) + "\n", "utf8");
  const { status, stdout } = runSyncRun(target, "1.3.0", { attemptsPath, maxAttempts: 2 });
  assert.equal(status, 0);
  assert.match(stdout, /試行上限/);
  // 停止パスでは +1 しない（2 のまま）。
  const after = JSON.parse(readFileSync(attemptsPath, "utf8"));
  assert.equal(after[`${target}@v1.3.0`], 2, "上限停止で試行回数が増えた");
});
