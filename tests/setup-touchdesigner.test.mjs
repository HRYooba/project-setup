// setup-touchdesigner の apply.mjs の検証。
//
// 観点:
//   1. skill を配らず、.mcp.json（既存の値は温存）・CLAUDE.md・状態を書く
//   2. 以前の版が直置きした td-* を記録どおりに消し、記録も消す
//      （自前の skill・skillOverrides・.mcp.json は残す）
//   3. 冪等（2 回目は何も変えない）
//   4. 記録の名前で .claude の外を消させない
//   5. CLAUDE.md の差分は書かずに要マージにする
//   6. TDMCP.tox は固定 sha256 と照合して置く

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { PLUGIN_ROOT, skillVersion, tempDir } from "./helpers.mjs";
/* global process */

const APPLY_TD = join(PLUGIN_ROOT, "skills", "setup-touchdesigner", "apply.mjs");

function writeFile(p, body) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body, "utf8");
}

function tdProject() {
  const target = tempDir("setup-td-project-");
  writeFile(join(target, "demo.toe"), "");
  return target;
}

// release の取得は空のディレクトリへ向ける（ネットワークへ出さない）。
function runApply(target) {
  const res = spawnSync(process.execPath, [APPLY_TD, target], {
    encoding: "utf8",
    env: { ...process.env, SETUP_TOUCHDESIGNER_RELEASE_DIR: tempDir("td-no-release-") },
  });
  assert.equal(res.status, 0, `apply failed: ${res.stderr}\n${res.stdout}`);
  return res.stdout;
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const stateOf = (target) => readJson(join(target, ".claude", "sync-setup-state.json"))["setup-touchdesigner"];

// 1.x が直置きした配備先を再現する（skill・LICENSE・skillOverrides・.mcp.json・記録）。
function legacyProject() {
  const target = tdProject();
  const skills = join(target, ".claude", "skills");
  for (const s of ["td-general", "td-top-family"]) writeFile(join(skills, s, "SKILL.md"), `---\nname: ${s}\n---\n`);
  writeFile(join(skills, "TDMCP-SKILLS-LICENSE.md"), "LICENSE\n");
  writeFile(join(skills, "my-skill", "SKILL.md"), "---\nname: my-skill\n---\n");
  writeFile(
    join(target, ".claude", "settings.json"),
    JSON.stringify({ skillOverrides: { "touchdesigner:td-general": "off", "tdmcp-skills:td-general": "off" } })
  );
  writeFile(join(target, ".mcp.json"), JSON.stringify({ mcpServers: { touchdesigner: { type: "http", url: "http://127.0.0.1:13316/mcp" } } }));
  writeFile(
    join(target, ".claude", "sync-setup-state.json"),
    JSON.stringify({
      "setup-touchdesigner": {
        skillVersion: "1.1.0",
        flags: [],
        tdmcpSkills: { sha: "abc1234", placed: { skills: ["td-general", "td-top-family"] } },
      },
    })
  );
  return target;
}

test("skill を配らず、.mcp.json・CLAUDE.md・状態を書く", () => {
  const target = tdProject();
  const out = runApply(target);

  assert.ok(!existsSync(join(target, ".claude", "skills")), "skill を配った");
  // コンポーネントの Add MCP（Install Scope: Project）が書くのと同じ値
  assert.deepEqual(readJson(join(target, ".mcp.json")).mcpServers, {
    touchdesigner: { type: "http", url: "http://127.0.0.1:13316/mcp" },
  });
  assert.ok(!existsSync(join(target, ".claude", "settings.json")), "settings.json を書いた");
  assert.ok(existsSync(join(target, ".claude", "CLAUDE.md")), "CLAUDE.md を書いていない");
  assert.doesNotMatch(out, /以前に直置きした/, "記録が無いのに取り除きを報告した");

  const state = stateOf(target);
  assert.equal(state.skillVersion, skillVersion("setup-touchdesigner"));
  assert.ok(!("tdmcpSkills" in state), "直置きの記録を書いた");
});

test("以前の版が直置きした td-* を記録どおりに消し、自前の skill・skillOverrides・.mcp.json は残す", () => {
  const target = legacyProject();
  const settingsBefore = readFileSync(join(target, ".claude", "settings.json"), "utf8");
  const mcpBefore = readFileSync(join(target, ".mcp.json"), "utf8");
  const out = runApply(target);

  const skills = join(target, ".claude", "skills");
  for (const s of ["td-general", "td-top-family"]) assert.ok(!existsSync(join(skills, s)), `${s} が残った`);
  assert.ok(!existsSync(join(skills, "TDMCP-SKILLS-LICENSE.md")), "LICENSE が残った");
  assert.ok(existsSync(join(skills, "my-skill", "SKILL.md")), "記録に無い skill を消した");
  assert.equal(readFileSync(join(target, ".claude", "settings.json"), "utf8"), settingsBefore, "skillOverrides を変えた");
  assert.equal(readFileSync(join(target, ".mcp.json"), "utf8"), mcpBefore, ".mcp.json を変えた");
  assert.match(out, /以前に直置きした td-\* skill: 3 件を削除しました/);

  const state = stateOf(target);
  assert.equal(state.skillVersion, skillVersion("setup-touchdesigner"));
  assert.ok(!("tdmcpSkills" in state), "取り除き終えた記録が残った");
});

test(".mcp.json の他のサーバーと、配備先が変えた touchdesigner の値を温存する", () => {
  // ポートはプロジェクトごとに変えうる（1 台で複数の TouchDesigner を動かすとき）。
  const target = tdProject();
  const mine = { type: "http", url: "http://127.0.0.1:13317/mcp" };
  writeFile(join(target, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" }, touchdesigner: mine } }));
  const out = runApply(target);

  const servers = readJson(join(target, ".mcp.json")).mcpServers;
  assert.deepEqual(servers.touchdesigner, mine, "配備先の値を書き換えた");
  assert.deepEqual(servers.other, { command: "x" }, "他のサーバーを消した");
  assert.match(out, /MCP 接続（\.mcp\.json）: 触っていません/);
});

test("2 回目の適用は何も変えない", () => {
  const target = legacyProject();
  runApply(target);
  const out = runApply(target);

  assert.doesNotMatch(out, /以前に直置きした/);
  assert.match(out, /MCP 接続（\.mcp\.json）: 変更なし/);
  assert.match(out, /CLAUDE\.md: 変更なし/);
  assert.ok(existsSync(join(target, ".claude", "skills", "my-skill", "SKILL.md")));
});

test("記録の名前で .claude の外や配る種別以外を消させない", () => {
  const target = tdProject();
  writeFile(join(target, "keep.txt"), "x");
  writeFile(join(target, ".claude", "hooks", "h", "x.txt"), "x");
  writeFile(join(target, ".claude", "skills", "my-skill", "SKILL.md"), "x");
  writeFile(
    join(target, ".claude", "sync-setup-state.json"),
    JSON.stringify({
      "setup-touchdesigner": { skillVersion: "1.1.0", tdmcpSkills: { placed: { skills: ["..", "../keep.txt", "my-skill"], hooks: ["h"] } } },
    })
  );
  runApply(target);

  assert.ok(existsSync(join(target, "keep.txt")), ".claude の外を消した");
  assert.ok(existsSync(join(target, ".claude", "hooks", "h", "x.txt")), "配る種別以外を消した");
  assert.ok(existsSync(join(target, ".claude", "skills", "my-skill", "SKILL.md")), "td- 以外の名前を消した");
});

test("skills が symlink / junction なら、リンク先の td-* を消さない", () => {
  const target = tdProject();
  const outside = tempDir("td-outside-");
  writeFile(join(outside, "td-general", "SKILL.md"), "x");
  mkdirSync(join(target, ".claude"), { recursive: true });
  symlinkSync(outside, join(target, ".claude", "skills"), "junction");
  writeFile(
    join(target, ".claude", "sync-setup-state.json"),
    JSON.stringify({ "setup-touchdesigner": { skillVersion: "1.1.0", tdmcpSkills: { placed: { skills: ["td-general"] } } } })
  );
  runApply(target);

  assert.ok(existsSync(join(outside, "td-general", "SKILL.md")), "リンク先を消した");
});

test("既存の CLAUDE.md に節が無ければ、書かずに要マージとして報告する", () => {
  const target = tdProject();
  const claudeMd = join(target, ".claude", "CLAUDE.md");
  writeFile(claudeMd, "# 既存\n");
  const out = runApply(target);

  assert.equal(readFileSync(claudeMd, "utf8"), "# 既存\n", "既存の CLAUDE.md を書き換えた");
  assert.match(out, /要マージ[\s\S]*\.claude\/CLAUDE\.md/);
});

// ---- TDMCP.tox ----
// 照合の基準は呼び手が渡す sha256 なので、モジュールを直接呼んで偽の release で確かめる。

async function placeWith(releaseFiles, target, sha) {
  const { placeTdmcpTox } = await import("../skills/setup-touchdesigner/tdmcp-tox.mjs");
  const dir = tempDir("td-release-");
  for (const [n, body] of Object.entries(releaseFiles)) writeFile(join(dir, n), body);
  const prev = process.env.SETUP_TOUCHDESIGNER_RELEASE_DIR;
  process.env.SETUP_TOUCHDESIGNER_RELEASE_DIR = dir;
  try {
    return await placeTdmcpTox({ target, repo: "x/y", tag: "9.9.9", sha256: sha });
  } finally {
    if (prev === undefined) delete process.env.SETUP_TOUCHDESIGNER_RELEASE_DIR;
    else process.env.SETUP_TOUCHDESIGNER_RELEASE_DIR = prev;
  }
}
const hashOf = (s) => createHash("sha256").update(s).digest("hex");

test("tox: 固定 sha256 と一致すれば LICENSE と一緒に置き、2 回目は触らない", async () => {
  const target = tdProject();
  const files = { "TDMCP.tox": "TOX-v1", "LICENSE.md": "LICENSE\n" };
  const first = await placeWith(files, target, hashOf("TOX-v1"));
  assert.match(first.state, /置きました/);
  assert.equal(readFileSync(join(target, "TDMCP.tox"), "utf8"), "TOX-v1");
  assert.equal(readFileSync(join(target, "TDMCP-LICENSE.md"), "utf8"), "LICENSE\n");

  const second = await placeWith({}, target, hashOf("TOX-v1"));
  assert.match(second.state, /導入済み/, "一致しているのに取得しに行った");
});

test("tox: 取得物が固定 sha256 と一致しなければ置かずに警告する", async () => {
  const target = tdProject();
  const res = await placeWith({ "TDMCP.tox": "TAMPERED", "LICENSE.md": "L" }, target, hashOf("TOX-v1"));
  assert.ok(res.warning, "警告を出していない");
  assert.ok(!existsSync(join(target, "TDMCP.tox")), "一致しない tox を置いた");
});

test("tox: 取得できなければ既存の tox を残す", async () => {
  const target = tdProject();
  writeFile(join(target, "TDMCP.tox"), "OLD");
  const res = await placeWith({}, target, hashOf("TOX-v2"));
  assert.match(res.state, /見送りました/);
  assert.equal(readFileSync(join(target, "TDMCP.tox"), "utf8"), "OLD");
});

test("tox: 版の違う既存 tox は置き換える", async () => {
  const target = tdProject();
  writeFile(join(target, "TDMCP.tox"), "OLD");
  const res = await placeWith({ "TDMCP.tox": "TOX-v2", "LICENSE.md": "L" }, target, hashOf("TOX-v2"));
  assert.match(res.state, /置き換えました/);
  assert.equal(readFileSync(join(target, "TDMCP.tox"), "utf8"), "TOX-v2");
});
