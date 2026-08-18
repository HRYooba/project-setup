// sync-launch.mjs（無人起動側）のテスト。
//
// 裏 Claude の起動そのものは検証しない（API を叩くため）。検証するのは、この launcher が
// 引き受けている**分離の担保**:
//   - 使い捨て worktree を origin の default ブランチから切る（対象リポジトリの HEAD に依らない）
//   - sparse-checkout でテンプレが触る領域だけ展開する（Unity のような巨大リポジトリ対策）
//   - 対象リポジトリの作業ツリー・ブランチ・index に一切触れない
//   - 終了時に worktree を片付け、ロックを外す
//   - ロック中は二重起動しない

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SYNC_LAUNCH, tempDir } from "./helpers.mjs";
/* global process */

function git(cwd, ...a) {
  return execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

// bare origin と作業クローンを作る。テンプレが触る領域（.claude/.github）と、
// 触らない大きめの領域（Assets/）を仕込む。
function makeRepo() {
  const root = tempDir("launch-repo-");
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  mkdirSync(origin, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", origin], { stdio: "ignore" });
  execFileSync("git", ["init", "-q", work], { stdio: "ignore" });
  git(work, "config", "user.email", "t@example.invalid");
  git(work, "config", "user.name", "t");
  mkdirSync(join(work, ".claude", "rules"), { recursive: true });
  mkdirSync(join(work, ".github"), { recursive: true });
  mkdirSync(join(work, "Assets"), { recursive: true });
  writeFileSync(join(work, ".claude", "setup-sync-state.json"), '{"setup-github":{"version":"1.0.0","flags":[]}}\n');
  writeFileSync(join(work, ".claude", "rules", "git-conventions.md"), "rules\n");
  writeFileSync(join(work, ".github", "pull_request_template.md"), "pr\n");
  writeFileSync(join(work, "Assets", "big.bin"), "x".repeat(50000));
  git(work, "add", "-A");
  git(work, "commit", "-qm", "init");
  git(work, "branch", "-M", "main");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "-u", "origin", "main");
  return work;
}

function runLaunch(target, { dataDir, version = "1.13.0", keep = false, env = {} } = {}) {
  const pluginsJson = join(tempDir("launch-plugins-"), "installed_plugins.json");
  writeFileSync(
    pluginsJson,
    JSON.stringify({
      version: 2,
      plugins: {
        "project-setup@hryooba": [
          { scope: "user", installPath: "C:/fake/ps/current", version, lastUpdated: "2026-08-18T00:00:00.000Z" },
        ],
      },
    }),
    "utf8"
  );
  const res = spawnSync(process.execPath, [SYNC_LAUNCH, target], {
    encoding: "utf8",
    env: {
      ...process.env,
      SETUP_SYNC_PLUGINS_JSON: pluginsJson,
      SETUP_SYNC_DATA_DIR: dataDir,
      SETUP_SYNC_LAUNCH_DRY: "1",
      ...(keep ? { SETUP_SYNC_LAUNCH_KEEP: "1" } : {}),
      ...env,
    },
  });
  assert.equal(res.status, 0, `launcher exited non-zero: ${res.stderr}`);
  const results = join(dataDir, "results");
  const files = existsSync(results) ? readdirSync(results) : [];
  assert.equal(files.length, 1, `結果ファイルが 1 件でない: ${JSON.stringify(files)}`);
  return { result: JSON.parse(readFileSync(join(results, files[0]), "utf8")), stdout: res.stdout };
}

test("launcher: 使い捨て worktree を作り、対象リポジトリには触らず、後始末してロックを外す", () => {
  const repo = makeRepo();
  // 対象リポジトリを「ユーザーが作業中」の状態にする（別ブランチ + 未コミットの変更）。
  git(repo, "switch", "-qc", "feat/user-work");
  writeFileSync(join(repo, "Assets", "editing.txt"), "作業中\n");
  const dataDir = join(tempDir("launch-data-"), "data");

  const { result } = runLaunch(repo, { dataDir });
  assert.equal(result.status, "skipped");
  assert.equal(result.branch, "chore/setup-sync-v1.13.0");

  // 足元を触っていないこと。ここが崩れると Unity Editor 稼働中に事故る。
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "feat/user-work");
  assert.equal(readFileSync(join(repo, "Assets", "editing.txt"), "utf8"), "作業中\n");
  assert.match(git(repo, "status", "--porcelain"), /Assets\/editing\.txt/);
  // 後始末: worktree は残らず、ロックも外れている。
  assert.equal(git(repo, "worktree", "list").split("\n").length, 1, "worktree が残っている");
  assert.equal(existsSync(join(dataDir, "sync-lock.json")), false, "ロックが残っている");
});

test("launcher: worktree は origin の default から切られ、テンプレ領域だけを展開する", () => {
  const repo = makeRepo();
  // ユーザーの HEAD には同期に無関係なコミットを積んでおく。起点がここなら PR に混入する。
  git(repo, "switch", "-qc", "feat/unrelated");
  writeFileSync(join(repo, "Assets", "unrelated.txt"), "無関係\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "unrelated");
  const dataDir = join(tempDir("launch-data-"), "data");

  const { result } = runLaunch(repo, { dataDir, keep: true });
  const wt = result.message.match(/（(.+)）/)[1];
  assert.ok(existsSync(wt), `worktree が残っていない: ${wt}`);

  // テンプレが触る領域だけが実体化している。
  assert.ok(existsSync(join(wt, ".claude", "setup-sync-state.json")));
  assert.ok(existsSync(join(wt, ".github", "pull_request_template.md")));
  assert.equal(existsSync(join(wt, "Assets")), false, "Assets まで展開している（巨大リポジトリで破綻する）");
  // 起点は origin/main。ユーザーの HEAD のコミットは載っていない。
  assert.equal(existsSync(join(wt, "Assets", "unrelated.txt")), false);
  assert.equal(git(wt, "rev-parse", "HEAD"), git(repo, "rev-parse", "origin/main"));
  // sparse でも作業ツリーは clean（publish の `git add -A` が幻の削除を拾わない）。
  assert.equal(git(wt, "status", "--porcelain"), "");

  git(repo, "worktree", "remove", "--force", wt);
});

test("launcher: ロック中は二重に起動しない", () => {
  const repo = makeRepo();
  const dataDir = join(tempDir("launch-data-"), "data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, "sync-lock.json"),
    JSON.stringify({ pid: 999999, repo, startedAt: new Date().toISOString() }),
    "utf8"
  );
  const pluginsJson = join(tempDir("launch-plugins-"), "installed_plugins.json");
  writeFileSync(
    pluginsJson,
    JSON.stringify({
      version: 2,
      plugins: {
        "project-setup@hryooba": [
          { scope: "user", installPath: "C:/fake/ps/current", version: "1.13.0", lastUpdated: "2026-08-18T00:00:00.000Z" },
        ],
      },
    }),
    "utf8"
  );
  const res = spawnSync(process.execPath, [SYNC_LAUNCH, repo], {
    encoding: "utf8",
    env: { ...process.env, SETUP_SYNC_PLUGINS_JSON: pluginsJson, SETUP_SYNC_DATA_DIR: dataDir, SETUP_SYNC_LAUNCH_DRY: "1" },
  });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /既に同期プロセスが走っています/);
  assert.equal(existsSync(join(dataDir, "results")), false, "起動していないのに結果を書いた");
  assert.ok(existsSync(join(dataDir, "sync-lock.json")), "他プロセスのロックを消した");
});

test("launcher: 期限切れのロックは無視して起動する", () => {
  const repo = makeRepo();
  const dataDir = join(tempDir("launch-data-"), "data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, "sync-lock.json"),
    JSON.stringify({ pid: 999999, repo, startedAt: new Date(Date.now() - 7200000).toISOString() }),
    "utf8"
  );
  const { result } = runLaunch(repo, { dataDir });
  assert.equal(result.status, "skipped");
  assert.equal(existsSync(join(dataDir, "sync-lock.json")), false, "ロックが外れていない");
});

test("launcher: git リポジトリでなければ失敗を結果に残す（黙って消えない）", () => {
  const dataDir = join(tempDir("launch-data-"), "data");
  const { result } = runLaunch(tempDir("launch-notgit-"), { dataDir });
  assert.equal(result.status, "failed");
  assert.match(result.message, /git リポジトリではありません/);
});
