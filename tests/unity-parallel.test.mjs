// unity-parallel（検証レーンの貸し出し）のテスト。
//
// 観点:
//   1. 配布 — apply.mjs が skill / hook / agent を撒き、再実行しても壊れない
//   2. 門番 — 「判断できないなら拒否」が守られているか。fail-open だと事故が素通りするため、
//      許可側より拒否側の網羅を厚くする
//   3. 差分ゲート — checkout する前に禁止された変更を弾けるか
//   4. 排他 — 同時に 2 人へ貸さないか

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { APPLY_UNITY, tempDir } from "./helpers.mjs";
import { UNITY_SERIALIZED_EXT } from "../skills/setup-unity/templates/base/skills/unity-parallel/protocol.mjs";
/* global process */

const SKILL_DIR = ".claude/skills/unity-parallel";

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

function git(args, cwd) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} 失敗: ${res.stderr}`);
  return res.stdout.trim();
}

/** Unity プロジェクトの体裁を持つ git リポジトリを作り、setup-unity を適用する。 */
function unityRepo(prefix) {
  // worktree はリポジトリの隣（`..`）に作られる。テストごとに親を分けないと
  // 別のテストの wt-a と同じパスを取り合って失敗する。
  const dir = join(tempDir(prefix), "repo");
  mkdirSync(join(dir, "ProjectSettings"), { recursive: true });
  writeFileSync(join(dir, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.3.9f1\n", "utf8");
  mkdirSync(join(dir, "Assets", "App"), { recursive: true });
  writeFileSync(join(dir, "Assets", "App", "Foo.cs"), "public class Foo {}\n", "utf8");

  const apply = spawnSync(process.execPath, [APPLY_UNITY, dir], { encoding: "utf8" });
  assert.equal(apply.status, 0, `apply 失敗: ${apply.stderr}${apply.stdout}`);

  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "t@example.com"], dir);
  git(["config", "user.name", "t"], dir);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "init"], dir);
  return dir;
}

function stateDirOf(repo) {
  return join(repo, ".git", "unity-parallel");
}

function writeLaneState(repo, patch) {
  const dir = stateDirOf(repo);
  mkdirSync(dir, { recursive: true });
  const base = {
    version: 1,
    lanePath: repo,
    generation: 1,
    holder: null,
    queue: [],
    worktrees: {},
    approvedSnapshots: {},
    recovery: null,
  };
  writeFileSync(join(dir, "state.json"), JSON.stringify({ ...base, ...patch }, null, 2), "utf8");
  return dir;
}

function runGuard(repo, payload, { raw = null } = {}) {
  const guard = join(repo, SKILL_DIR, "guard.mjs");
  const res = spawnSync(process.execPath, [guard], {
    input: raw === null ? JSON.stringify({ cwd: repo, ...payload }) : raw,
    encoding: "utf8",
    cwd: repo,
  });
  return { status: res.status, stderr: res.stderr };
}

function runLane(repo, args, cwd = repo) {
  const lane = join(repo, SKILL_DIR, "lane.mjs");
  return spawnSync(process.execPath, [lane, ...args], { encoding: "utf8", cwd });
}

const mcpCall = { tool_name: "mcp__UnityMCP__read_console", tool_input: {} };

// ---------------------------------------------------------------------------
// 1. 配布
// ---------------------------------------------------------------------------

test("apply: unity-parallel の skill / スクリプト / agent が配られる", () => {
  const repo = unityRepo("up-apply-");
  for (const f of [
    `${SKILL_DIR}/SKILL.md`,
    `${SKILL_DIR}/lane.mjs`,
    `${SKILL_DIR}/guard.mjs`,
    `${SKILL_DIR}/protocol.mjs`,
    `${SKILL_DIR}/references/protocol.md`,
    ".claude/agents/unity-worker.md",
  ]) {
    assert.ok(existsSync(join(repo, f)), `${f} が配置されていない`);
  }
  // hook は skill frontmatter に閉じる。settings.json へは登録しない（setup-unity の契約）
  assert.ok(!existsSync(join(repo, ".claude", "settings.json")), "setup-unity が settings.json を作っている");
  const skill = readFileSync(join(repo, SKILL_DIR, "SKILL.md"), "utf8");
  assert.match(skill, /^hooks:/m, "SKILL.md に hook 登録が無い");
  assert.match(skill, /guard\.mjs/, "hook が guard.mjs を指していない");
});

test("apply: 再実行しても unity-parallel の配布物が壊れない", () => {
  const repo = unityRepo("up-apply2-");
  const before = readFileSync(join(repo, SKILL_DIR, "lane.mjs"), "utf8");
  const again = spawnSync(process.execPath, [APPLY_UNITY, repo], { encoding: "utf8" });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(join(repo, SKILL_DIR, "lane.mjs"), "utf8"), before);
});

test("rules/unity-mcp.md に接続先がクライアント単位で 1 つである旨が載る", () => {
  const repo = unityRepo("up-rule-");
  const rule = readFileSync(join(repo, ".claude", "rules", "unity-mcp.md"), "utf8");
  assert.match(rule, /クライアント単位で\s*1\s*つ/);
  assert.match(rule, /unity-parallel/);
});

// ---------------------------------------------------------------------------
// 2. 門番
// ---------------------------------------------------------------------------

test("門番: レーン未初期化なら素通しする（並列作業していないセッションを邪魔しない）", () => {
  const repo = unityRepo("up-guard-off-");
  assert.equal(runGuard(repo, { ...mcpCall, agent_id: "a1" }).status, 0);
});

test("門番: レーンが生きていて状態ファイルが壊れていれば拒否する", () => {
  const repo = unityRepo("up-guard-broken-");
  const dir = stateDirOf(repo);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), "{ not json", "utf8");
  const r = runGuard(repo, { ...mcpCall, agent_id: "a1" });
  assert.equal(r.status, 2, "壊れた状態を通してしまっている");
  assert.match(r.stderr, /状態ファイルを読めません/);
});

test("門番: レーンが生きていて hook 入力が壊れていれば拒否する", () => {
  const repo = unityRepo("up-guard-badin-");
  writeLaneState(repo, {});
  const r = runGuard(repo, {}, { raw: "not json at all" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /解釈できません/);
});

test("門番: トークンを持たないサブエージェントの Unity MCP を拒否する", () => {
  const repo = unityRepo("up-guard-nonholder-");
  const head = git(["rev-parse", "HEAD"], repo);
  writeLaneState(repo, {
    holder: { worktree: "wt-a", agentId: "holder-1", phase: "ACTIVE", loadedCommit: head, commit: head, delegate: null },
  });
  const r = runGuard(repo, { ...mcpCall, agent_id: "other-2", agent_type: "unity-worker" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /トークンを持っていません/);
});

test("門番: 保持者でも PREPARING 中は Unity MCP を拒否する", () => {
  const repo = unityRepo("up-guard-preparing-");
  const head = git(["rev-parse", "HEAD"], repo);
  writeLaneState(repo, {
    holder: { worktree: "wt-a", agentId: "h1", phase: "PREPARING", loadedCommit: head, commit: head, delegate: null },
  });
  const r = runGuard(repo, { ...mcpCall, agent_id: "h1" });
  assert.equal(r.status, 2, "切り替え途中の呼び出しを通している（偽の green の原因）");
  assert.match(r.stderr, /PREPARING/);
});

test("門番: 保持者かつ ACTIVE かつ HEAD 一致なら許可する", () => {
  const repo = unityRepo("up-guard-ok-");
  const head = git(["rev-parse", "HEAD"], repo);
  writeLaneState(repo, {
    holder: { worktree: "wt-a", agentId: "h1", phase: "ACTIVE", loadedCommit: head, commit: head, delegate: null },
  });
  assert.equal(runGuard(repo, { ...mcpCall, agent_id: "h1" }).status, 0);
});

test("門番: HEAD がリース時と違えば保持者でも拒否する", () => {
  const repo = unityRepo("up-guard-head-");
  writeLaneState(repo, {
    holder: {
      worktree: "wt-a",
      agentId: "h1",
      phase: "ACTIVE",
      loadedCommit: "0".repeat(40),
      commit: "0".repeat(40),
      delegate: null,
    },
  });
  const r = runGuard(repo, { ...mcpCall, agent_id: "h1" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /HEAD がリース時と違います/);
});

test("門番: 委譲された検証エージェントは許可、委譲を外すと拒否", () => {
  const repo = unityRepo("up-guard-delegate-");
  const head = git(["rev-parse", "HEAD"], repo);
  const holder = { worktree: "wt-a", agentId: "h1", phase: "ACTIVE", loadedCommit: head, commit: head };
  writeLaneState(repo, { holder: { ...holder, delegate: { agentType: "unity-tester" } } });
  assert.equal(runGuard(repo, { ...mcpCall, agent_id: "tester-9", agent_type: "unity-tester" }).status, 0);

  writeLaneState(repo, { holder: { ...holder, delegate: null } });
  assert.equal(runGuard(repo, { ...mcpCall, agent_id: "tester-9", agent_type: "unity-tester" }).status, 2);
});

test("門番: 貸し出し中はメインセッションの Unity MCP も拒否する（無条件免除にしない）", () => {
  const repo = unityRepo("up-guard-main-");
  const head = git(["rev-parse", "HEAD"], repo);
  writeLaneState(repo, {
    holder: { worktree: "wt-a", agentId: "h1", phase: "ACTIVE", loadedCommit: head, commit: head, delegate: null },
  });
  const active = runGuard(repo, mcpCall); // agent_id なし = メインセッション
  assert.equal(active.status, 2);

  // 準備・返却フェーズでは coordinator の操作が要るので許す
  writeLaneState(repo, {
    holder: { worktree: "wt-a", agentId: "h1", phase: "PREPARING", loadedCommit: head, commit: head, delegate: null },
  });
  assert.equal(runGuard(repo, mcpCall).status, 0);
});

test("門番: RECOVERY_REQUIRED 中は誰の Unity MCP も拒否する", () => {
  const repo = unityRepo("up-guard-recovery-");
  writeLaneState(repo, { recovery: { reason: "テスト", at: new Date().toISOString() } });
  assert.equal(runGuard(repo, mcpCall).status, 2);
  assert.equal(runGuard(repo, { ...mcpCall, agent_id: "h1" }).status, 2);
});

test("門番: Unity シリアライズファイルの手編集は全拡張子で拒否する", () => {
  const repo = unityRepo("up-guard-write-");
  writeLaneState(repo, {});
  for (const ext of UNITY_SERIALIZED_EXT) {
    const r = runGuard(repo, {
      tool_name: "Write",
      tool_input: { file_path: join(repo, "Assets", `Sample${ext}`) },
      agent_id: "h1",
    });
    assert.equal(r.status, 2, `${ext} の手編集を通している`);
  }
});

test("門番: シェル経由の書き込みも代表的な形は拒否する", () => {
  const repo = unityRepo("up-guard-shell-");
  writeLaneState(repo, {});
  const denied = [
    'echo x > Assets/A.prefab',
    'cp /tmp/a.meta Assets/A.cs.meta',
    "sed -i 's/a/b/' Assets/Main.unity",
    'Set-Content Assets/M.mat "x"',
  ];
  for (const command of denied) {
    const r = runGuard(repo, { tool_name: "Bash", tool_input: { command }, agent_id: "h1" });
    assert.equal(r.status, 2, `通してしまった: ${command}`);
  }
  // 読み取りは落とさない
  const read = runGuard(repo, { tool_name: "Bash", tool_input: { command: "cat Assets/A.prefab" }, agent_id: "h1" });
  assert.equal(read.status, 0, "読み取りまで拒否している");
});

test("門番: 保持者でないエージェントのレーン内書き込みを拒否する", () => {
  const repo = unityRepo("up-guard-lane-write-");
  const head = git(["rev-parse", "HEAD"], repo);
  writeLaneState(repo, {
    holder: { worktree: "wt-a", agentId: "h1", phase: "ACTIVE", loadedCommit: head, commit: head, delegate: null },
  });
  const r = runGuard(repo, {
    tool_name: "Write",
    tool_input: { file_path: join(repo, "Assets", "App", "Bar.cs") },
    agent_id: "other",
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /検証レーン/);
});

test("門番: lane.mjs の呼び出しは通し、呼び出し元の識別子を記録する", () => {
  const repo = unityRepo("up-guard-identity-");
  const dir = writeLaneState(repo, {});
  const command = `node .claude/skills/unity-parallel/lane.mjs request --worktree wt-a`;
  const r = runGuard(repo, { tool_name: "Bash", tool_input: { command }, agent_id: "worker-7", agent_type: "unity-worker" });
  assert.equal(r.status, 0, `lane.mjs の呼び出しを拒否している: ${r.stderr}`);
  const identity = JSON.parse(readFileSync(join(dir, "pending-identity.json"), "utf8"));
  assert.equal(identity.agentId, "worker-7");
  assert.equal(identity.agentType, "unity-worker");
});

test("門番: 無関係な MCP サーバーは巻き込まない", () => {
  const repo = unityRepo("up-guard-othermcp-");
  const head = git(["rev-parse", "HEAD"], repo);
  writeLaneState(repo, {
    holder: { worktree: "wt-a", agentId: "h1", phase: "ACTIVE", loadedCommit: head, commit: head, delegate: null },
  });
  const r = runGuard(repo, { tool_name: "mcp__slack__send_message", tool_input: {}, agent_id: "other" });
  assert.equal(r.status, 0, "Unity 以外の MCP まで止めている");
});

// ---------------------------------------------------------------------------
// 3. 差分ゲート / 4. 排他
// ---------------------------------------------------------------------------

test("lane: init → add → request が通り、Unity シリアライズの変更は checkout 前に弾かれる", () => {
  const repo = unityRepo("up-lane-gate-");
  assert.equal(runLane(repo, ["init"]).status, 0);
  const add = runLane(repo, ["add", "a"]);
  assert.equal(add.status, 0, add.stderr);

  const wt = join(repo, "..", "wt-a");
  // 許可される変更（.cs の編集）だけなら通る
  writeFileSync(join(wt, "Assets", "App", "Foo.cs"), "public class Foo { int x; }\n", "utf8");
  git(["add", "-A"], wt);
  git(["commit", "-q", "-m", "edit"], wt);
  const okReq = runLane(repo, ["request", "--worktree", "a"]);
  assert.equal(okReq.status, 0, okReq.stderr);

  // 禁止される変更（.prefab の手編集）は弾く
  writeFileSync(join(wt, "Assets", "App", "Bad.prefab"), "%YAML 1.1\n", "utf8");
  git(["add", "-A"], wt);
  git(["commit", "-q", "-m", "bad"], wt);
  const ngReq = runLane(repo, ["request", "--worktree", "a"]);
  assert.equal(ngReq.status, 1, "禁止された変更を検証レーンへ載せようとしている");
  assert.match(ngReq.stderr, /Editor（MCP）経由/);
});

test("lane: 貸し出し中はもう一人へ貸さない", () => {
  const repo = unityRepo("up-lane-excl-");
  runLane(repo, ["init"]);
  runLane(repo, ["add", "a"]);
  runLane(repo, ["add", "b"]);
  for (const name of ["a", "b"]) {
    const wt = join(repo, "..", `wt-${name}`);
    writeFileSync(join(wt, "Assets", "App", `${name}.cs`), `public class ${name.toUpperCase()} {}\n`, "utf8");
    git(["add", "-A"], wt);
    git(["commit", "-q", "-m", name], wt);
    assert.equal(runLane(repo, ["request", "--worktree", name]).status, 0);
  }

  const first = runLane(repo, ["grant"]);
  assert.equal(first.status, 0, first.stderr);
  const second = runLane(repo, ["grant"]);
  assert.equal(second.status, 1, "2 人目へも貸してしまっている");
  assert.match(second.stderr, /既に/);

  const state = JSON.parse(readFileSync(join(stateDirOf(repo), "state.json"), "utf8"));
  assert.equal(state.holder.phase, "PREPARING", "grant 直後に ACTIVE になっている（切り替え前の呼び出しを許してしまう）");
  assert.equal(state.queue.length, 1);
});

test("lane: 未コミットの変更があると順番待ちに入れない", () => {
  const repo = unityRepo("up-lane-dirty-");
  runLane(repo, ["init"]);
  runLane(repo, ["add", "a"]);
  const wt = join(repo, "..", "wt-a");
  writeFileSync(join(wt, "Assets", "App", "Dirty.cs"), "public class Dirty {}\n", "utf8");
  const req = runLane(repo, ["request", "--worktree", "a"]);
  assert.equal(req.status, 1);
  assert.match(req.stderr, /未コミット/);
});

test("lane: doctor は状態ファイルの破損を検出する", () => {
  const repo = unityRepo("up-lane-doctor-");
  runLane(repo, ["init"]);
  writeFileSync(join(stateDirOf(repo), "state.json"), "{ broken", "utf8");
  const res = runLane(repo, ["doctor"]);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /壊れています/);
});

test("lane: 1 サイクル通しで Editor 生成の .meta が worktree へ戻る", () => {
  const repo = unityRepo("up-lane-cycle-");
  runLane(repo, ["init"]);
  runLane(repo, ["add", "a"]);
  const wt = join(repo, "..", "wt-a");

  writeFileSync(join(wt, "Assets", "App", "Bar.cs"), "public class Bar {}\n", "utf8");
  git(["add", "-A"], wt);
  git(["commit", "-q", "-m", "add Bar"], wt);
  assert.equal(runLane(repo, ["request", "--worktree", "a"]).status, 0);
  assert.equal(runLane(repo, ["grant"]).status, 0);
  assert.equal(runLane(repo, ["activate"]).status, 0);

  // Editor が .meta を生成した状況を作る（worker はこれを手で書けない）
  writeFileSync(join(repo, "Assets", "App", "Bar.cs.meta"), "guid: 1111\n", "utf8");
  assert.equal(runLane(repo, ["drain"]).status, 0);
  assert.equal(runLane(repo, ["seal", "-m", "chore: meta"]).status, 0);
  const ret = runLane(repo, ["return"]);
  assert.equal(ret.status, 0, ret.stderr);

  // 取りこぼすと worktree 側で別 GUID が再生成され参照が壊れる。戻っていることを確かめる
  assert.ok(existsSync(join(wt, "Assets", "App", "Bar.cs.meta")), ".meta が worktree へ戻っていない");
  // 改行コードは autocrlf の影響を受けるので内容で比べる
  assert.match(readFileSync(join(wt, "Assets", "App", "Bar.cs.meta"), "utf8"), /guid: 1111/);

  const state = JSON.parse(readFileSync(join(stateDirOf(repo), "state.json"), "utf8"));
  assert.equal(state.holder, null, "返却後も貸し出しが残っている");
  assert.ok(state.approvedSnapshots.a, "承認済みスナップショットが記録されていない");
});

test("lane: レーンで正規に作られた .meta は次の要求で違反扱いしない", () => {
  const repo = unityRepo("up-lane-regate-");
  runLane(repo, ["init"]);
  runLane(repo, ["add", "a"]);
  const wt = join(repo, "..", "wt-a");

  writeFileSync(join(wt, "Assets", "App", "Bar.cs"), "public class Bar {}\n", "utf8");
  git(["add", "-A"], wt);
  git(["commit", "-q", "-m", "add Bar"], wt);
  runLane(repo, ["request", "--worktree", "a"]);
  runLane(repo, ["grant"]);
  runLane(repo, ["activate"]);
  writeFileSync(join(repo, "Assets", "App", "Bar.cs.meta"), "guid: 2222\n", "utf8");
  runLane(repo, ["drain"]);
  runLane(repo, ["seal", "-m", "chore: meta"]);
  assert.equal(runLane(repo, ["return"]).status, 0);

  // 2 回目。branch には .meta が含まれるが、承認済みの範囲なので弾いてはいけない
  writeFileSync(join(wt, "Assets", "App", "Bar.cs"), "public class Bar { int y; }\n", "utf8");
  git(["add", "-A"], wt);
  git(["commit", "-q", "-m", "edit Bar"], wt);
  const second = runLane(repo, ["request", "--worktree", "a"]);
  assert.equal(second.status, 0, `承認済みの .meta を違反として弾いている: ${second.stderr}`);
});
