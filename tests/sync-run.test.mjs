// sync-run.mjs（同期の実行本体）の決定的コア（drift 判定・計画・ガード）のテスト。
//
// git/gh を伴う副作用（branch/commit/push/PR）は CI で再現しづらいため、副作用に入る前の
// 決定的な部分だけを検証する:
//   - --dry-run: 同期計画の算出（対象スキル・保存フラグ・ブランチ・試行回数）と、副作用ゼロ
//   - drift 無し / 状態ファイル無し → 何もしないで exit 0
//   - 試行上限ガード（非 dry-run でも副作用前に停止し、試行回数を増やさない）
//   - フェーズ指定の必須化と、publish を計画なし / worktree なしで叩いたときの停止
//   - --phase=apply の通し（worktree 作成 → apply.mjs 起動）。ここを誰も通していなかったため、
//     sparse-checkout と apply.mjs の前提の食い違いがユニットテスト全 pass の裏を素通りしていた

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SYNC_RUN, tempDir } from "./helpers.mjs";
import { dirname } from "node:path";
/* global process */

// 偽の installed_plugins.json を書き、sync-run.mjs を本番同様に子プロセスで起動する。
function runSyncRun(
  target,
  currentVersion,
  { dryRun = false, phase = "apply", attemptsPath, planPath, maxAttempts, installPath, dataDir } = {}
) {
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
  // --dry-run は phase 不要（計画のみ）。非 dry-run は --phase が必須。
  if (dryRun) args.push("--dry-run");
  else if (phase) args.push(`--phase=${phase}`);
  const env = { ...process.env, SYNC_SETUP_PLUGINS_JSON: pluginsJson };
  if (attemptsPath) env.SYNC_SETUP_ATTEMPTS_JSON = attemptsPath;
  if (planPath) env.SYNC_SETUP_PLAN_JSON = planPath;
  if (maxAttempts != null) env.SYNC_SETUP_MAX_ATTEMPTS = String(maxAttempts);
  if (dataDir) env.SYNC_SETUP_DATA_DIR = dataDir;
  const res = spawnSync(process.execPath, args, { encoding: "utf8", env });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function writeState(target, obj) {
  mkdirSync(join(target, ".claude"), { recursive: true });
  writeFileSync(join(target, ".claude", "sync-setup-state.json"), JSON.stringify(obj, null, 2) + "\n", "utf8");
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
  assert.match(stdout, /chore\/sync-setup-v1\.3\.0/);
  assert.match(stdout, /dry-run/);
  // 副作用ゼロ: 試行回数ファイルは作られない。
  assert.ok(!existsSync(attemptsPath), "dry-run で試行回数ファイルが作られた");
});

// 状態ファイルは過去に 2 回改名している。読み手が正名しか見ないと、旧名だけが残った配備先は
// 「同期対象外」で静かに落ちる。改名の後始末は apply.mjs にあるが、apply は drift 検知の後に
// しか走らないので永久に到達しない（＝黙って追随が止まったまま誰も気づけない）。
test("旧名の状態ファイルしか無くても drift を検知する", () => {
  const target = tempDir("syncrun-legacyname-");
  mkdirSync(join(target, ".claude"), { recursive: true });
  writeFileSync(
    join(target, ".claude", "setup-sync-state.json"),
    JSON.stringify({ "setup-github": { version: "1.0.0", flags: [] } }, null, 2) + "\n",
    "utf8"
  );
  const { status, stdout } = runSyncRun(target, "1.3.0", { dryRun: true });
  assert.equal(status, 0);
  assert.match(stdout, /setup-github: v1\.0\.0 → v1\.3\.0/);
  assert.match(stdout, /旧名の状態ファイルを読みました/);
});

// 旧名 → 正名の改名でキーが引き継がれず、正名側に setup-github だけ、旧名側に setup-unity だけが
// 残った配備先が実在する。マージして読まないと setup-unity のテンプレ更新が永久に届かない。
test("正名と旧名にキーが散っていれば、両方を見て drift を判定する", () => {
  const target = tempDir("syncrun-mixedname-");
  mkdirSync(join(target, ".claude"), { recursive: true });
  writeFileSync(
    join(target, ".claude", "sync-setup-state.json"),
    JSON.stringify({ "setup-github": { version: "1.3.0", flags: [] } }, null, 2) + "\n",
    "utf8"
  );
  writeFileSync(
    join(target, ".claude", ".setup-sync.json"),
    JSON.stringify({ "setup-unity": { version: "1.0.0", flags: ["--architecture"] } }, null, 2) + "\n",
    "utf8"
  );
  const { status, stdout } = runSyncRun(target, "1.3.0", { dryRun: true });
  assert.equal(status, 0);
  assert.match(stdout, /setup-unity: v1\.0\.0 → v1\.3\.0/);
  assert.doesNotMatch(stdout, /setup-github: v/, "正名側の追随済みキーが旧名に引きずられている");
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

// apply と publish の間には「Claude が要マージの .md を統合する」工程が挟まる。
// フェーズを省略して一息に走らせると、その工程が飛ばされて .md 未更新の PR が出るため、
// 非 dry-run では --phase を必須にしている。
test("非 dry-run で --phase を省略するとエラー終了する", () => {
  const target = tempDir("syncrun-nophase-");
  writeState(target, { "setup-github": { version: "1.0.0", flags: [] } });
  const { status, stderr } = runSyncRun(target, "1.3.0", { phase: null });
  assert.equal(status, 1);
  assert.match(stderr, /--phase=apply または --phase=publish/);
});

test("publish を同期計画なしで叩くとエラー終了する（apply を先に要求する）", () => {
  const target = tempDir("syncrun-nopan-");
  writeState(target, { "setup-github": { version: "1.0.0", flags: [] } });
  const planPath = join(tempDir("syncrun-plan-missing-"), "sync-plan.json");
  const { status, stderr } = runSyncRun(target, "1.3.0", { phase: "publish", planPath });
  assert.equal(status, 1);
  assert.match(stderr, /同期計画が見つかりません/);
  assert.match(stderr, /--phase=apply/);
});

// publish は apply が作った worktree の中で commit する。worktree が消えていれば
// 対象リポジトリの作業ツリーへフォールバックしてはならない（ユーザーの作業を巻き込むため）。
test("publish: 計画はあるが worktree が消えていればエラー終了する", () => {
  const target = tempDir("syncrun-nowt-");
  writeState(target, { "setup-github": { version: "1.0.0", flags: [] } });
  const planPath = join(tempDir("syncrun-plan-nowt-"), "sync-plan.json");
  writeFileSync(
    planPath,
    JSON.stringify({
      key: `${target}@v1.3.0`,
      version: "1.3.0",
      branch: "chore/sync-setup-v1.3.0",
      repo: target,
      worktree: join(target, "does-not-exist"),
      drifted: [{ skill: "setup-github", from: "1.0.0", flags: [] }],
      warnings: [],
    }),
    "utf8"
  );
  const { status, stderr } = runSyncRun(target, "1.3.0", { phase: "publish", planPath });
  assert.equal(status, 1);
  assert.match(stderr, /worktree が見つかりません/);
});

// apply と publish の間にプラグインが自動更新されることがある。現行版で計画を照合すると鍵が
// 食い違い、成果の入った worktree ごと最初からやり直しになる（空振りの試行も 1 回記録される）。
// worktree の中身は apply 時の版のテンプレで作られているので、その版として publish するのが正しい。
test("publish: apply 後にプラグイン版が上がっても計画を捨てない", () => {
  const target = tempDir("syncrun-verdrift-");
  writeState(target, { "setup-github": { version: "1.0.0", flags: [] } });
  const planPath = join(tempDir("syncrun-plan-verdrift-"), "sync-plan.json");
  const repoId = target; // git repo でない temp dir では target が repoId
  writeFileSync(
    planPath,
    JSON.stringify({
      key: `${repoId}@v1.3.0`,
      version: "1.3.0",
      branch: "chore/sync-setup-v1.3.0",
      repo: target,
      worktree: join(target, "does-not-exist"),
      drifted: [{ skill: "setup-github", from: "1.0.0", flags: [] }],
      warnings: [],
    }),
    "utf8"
  );
  // 現行版は 1.4.0（apply 時は 1.3.0 だった）。
  const { status, stdout, stderr } = runSyncRun(target, "1.4.0", { phase: "publish", planPath });
  assert.match(stdout, /apply 時のプラグイン版は v1\.3\.0/);
  // 計画は生きているので、止まる理由は「worktree が無い」であって「計画が無い」ではない。
  assert.equal(status, 1);
  assert.match(stderr, /worktree が見つかりません/);
  assert.doesNotMatch(stderr, /同期計画が見つかりません/);
});

// ---------------------------------------------------------------------------
// apply フェーズの通し
// ---------------------------------------------------------------------------

function git(args, cwd) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} 失敗: ${res.stderr}`);
  return res.stdout.trim();
}

test("apply: Unity プロジェクトの worktree で setup-unity の apply.mjs が完走する", () => {
  // sparse-checkout が展開する範囲と apply.mjs が要求する前提は噛み合っていなければならない。
  // setup-unity は ProjectSettings/ProjectVersion.txt で Unity プロジェクトかを判定するので、
  // 展開されていないと毎回落ち、試行上限に達して以後どの更新も配備先へ届かなくなる。
  const root = tempDir("syncrun-apply-");
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");

  git(["init", "-q", "--bare", "-b", "main", origin], root);
  git(["init", "-q", "-b", "main", repo], root);
  git(["config", "user.email", "t@example.com"], repo);
  git(["config", "user.name", "t"], repo);
  mkdirSync(join(repo, "ProjectSettings"), { recursive: true });
  writeFileSync(join(repo, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.3.9f1\n", "utf8");
  writeState(repo, {
    "setup-unity": {
      version: "1.0.0",
      flags: ["--architecture", "--analyzer", "--mcp", "mcp-for-unity"],
    },
  });
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "init"], repo);
  git(["remote", "add", "origin", origin], repo);
  git(["push", "-q", "-u", "origin", "main"], repo);

  const dataDir = join(root, "data");
  const { status, stdout, stderr } = runSyncRun(repo, "9.9.9", {
    phase: "apply",
    installPath: join(dirname(SYNC_RUN), "..", ".."),
    attemptsPath: join(dataDir, "attempts.json"),
    planPath: join(dataDir, "plan.json"),
    dataDir,
  });

  assert.equal(status, 0, `apply フェーズが失敗した:
${stdout}
${stderr}`);
  // worktree の中で apply.mjs が走り、CLI 前提の rules が置かれていること
  const worktrees = join(dataDir, "worktrees");
  const wt = join(worktrees, readdirSync(worktrees)[0]);
  assert.ok(existsSync(join(wt, "ProjectSettings", "ProjectVersion.txt")), "ProjectSettings が展開されていない");
  assert.ok(
    existsSync(join(wt, ".claude", "rules", "coding-standards.md")),
    "rules/coding-standards.md が配置されていない"
  );
  // analyzer は .claude ではなく Assets 配下へ書く。sparse-checkout がそこを展開して
  // いなければ、同期 PR から analyzer の更新だけが静かに落ちる。
  assert.ok(
    existsSync(join(wt, "Assets", "Analyzers", "UnityCodingStandards.Analyzers.dll")),
    "Assets/Analyzers が展開されず analyzer が配置されていない"
  );
  // PR ゲートの workflow も .claude の外。sparse-checkout が .github を展開していなければ
  // 同期 PR から CI の更新だけが落ちる。
  assert.ok(
    existsSync(join(wt, ".github", "workflows", "unity-ci.yml")),
    ".github が展開されず workflow が配置されていない"
  );
  // 廃止フラグを渡されても止まらず、警告が出力に載る
  assert.match(stdout, /廃止したオプションを無視しました/);
});
