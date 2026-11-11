// setup-touchdesigner の apply.mjs の検証。上流は偽のリポジトリで差し替える
// （本物の上流を叩くとテストがネットワークと上流の更新に左右される）。
//
// 観点:
//   1. 固定した tag の skill を配り、LICENSE と状態を残す
//   2. プラグイン版の同名 skill を 2 つの名前空間とも伏せる
//   3. .mcp.json は既存のサーバーと配備先の値を温存する
//   4. 冪等（2 回目は何も変えない）
//   5. 上流から消えた skill を消し、off も取り下げる
//   6. 上流の構成変化（hooks・未知の要素）を報告する
//   7. CLAUDE.md の差分は書かずに要マージにする

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { PLUGIN_ROOT, skillVersion, tempDir } from "./helpers.mjs";
import { TDMCP_SKILLS_TAG } from "../skills/setup-touchdesigner/upstream.mjs";
/* global process */

const APPLY_TD = join(PLUGIN_ROOT, "skills", "setup-touchdesigner", "apply.mjs");

function writeFile(p, body) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body, "utf8");
}

function git(repo, ...a) {
  const r = spawnSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });
  assert.equal(r.status, 0, `git ${a[0]} 失敗: ${r.stderr}`);
  return r.stdout.trim();
}

// 偽の上流。apply.mjs が固定 tag を fetch するので、同じ名前の tag を打つ。
function fakeUpstream(skills, extra = () => {}) {
  const repo = tempDir("tdmcp-upstream-");
  for (const s of skills) writeFile(join(repo, "skills", s, "SKILL.md"), `---\nname: ${s}\n---\n`);
  writeFile(join(repo, "LICENSE.md"), "LICENSE\n");
  writeFile(join(repo, ".mcp.json"), '{"mcpServers":{"tdmcp":{"type":"http","url":"http://localhost:13316/mcp"}}}\n');
  extra(repo);
  git(repo, "init", "-q", ".");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  git(repo, "tag", TDMCP_SKILLS_TAG);
  return repo;
}

// 上流を進めて tag を打ち直す（上流の skill 増減を再現する）。
function retag(repo, mutate) {
  mutate(repo);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "next");
  git(repo, "tag", "-f", TDMCP_SKILLS_TAG);
}

function tdProject() {
  const target = tempDir("setup-td-project-");
  writeFile(join(target, "demo.toe"), "");
  return target;
}

function runApply(target, repo) {
  const res = spawnSync(process.execPath, [APPLY_TD, target], {
    encoding: "utf8",
    env: { ...process.env, SETUP_TOUCHDESIGNER_SKILLS_REPO: repo },
  });
  assert.equal(res.status, 0, `apply failed: ${res.stderr}\n${res.stdout}`);
  return res.stdout;
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

test("固定 tag の skill を配り、LICENSE・skillOverrides・.mcp.json・状態を書く", () => {
  const repo = fakeUpstream(["td-general", "td-top-family"]);
  const target = tdProject();
  const out = runApply(target, repo);

  for (const s of ["td-general", "td-top-family"]) {
    assert.ok(existsSync(join(target, ".claude", "skills", s, "SKILL.md")), `${s} を配っていない`);
  }
  assert.ok(existsSync(join(target, ".claude", "skills", "TDMCP-SKILLS-LICENSE.md")), "LICENSE を置いていない");
  assert.doesNotMatch(out, /警告:/, "上流の開発用ファイルを未知の要素として報告した");

  const overrides = readJson(join(target, ".claude", "settings.json")).skillOverrides;
  for (const ns of ["tdmcp-skills", "touchdesigner"]) {
    assert.equal(overrides[`${ns}:td-general`], "off", `${ns} の名前空間を伏せていない`);
  }

  // 上流の開発用 .mcp.json（tdmcp / localhost）ではなく、正しい値で登録する。
  assert.deepEqual(readJson(join(target, ".mcp.json")).mcpServers, {
    touchdesigner: { type: "http", url: "http://127.0.0.1:13316/mcp" },
  });

  const state = readJson(join(target, ".claude", "sync-setup-state.json"))["setup-touchdesigner"];
  assert.equal(state.skillVersion, skillVersion("setup-touchdesigner"));
  assert.equal(state.tdmcpSkills.sha, git(repo, "rev-parse", TDMCP_SKILLS_TAG + "^{commit}"));
  assert.deepEqual(state.tdmcpSkills.placed.skills, ["td-general", "td-top-family"]);
});

test("2 回目の適用は何も変えない", () => {
  const repo = fakeUpstream(["td-general"]);
  const target = tdProject();
  runApply(target, repo);
  const out = runApply(target, repo);

  assert.match(out, /TDMCPSkills.*導入済み/);
  assert.match(out, /skillOverrides）: 変更なし/);
  assert.match(out, /MCP 接続（\.mcp\.json）: 変更なし/);
  assert.match(out, /CLAUDE\.md: 変更なし/);
});

test(".mcp.json の他のサーバーと、配備先が変えた touchdesigner の値を温存する", () => {
  // ポートはプロジェクトごとに変えうる（1 台で複数の TouchDesigner を動かすとき）。
  const repo = fakeUpstream(["td-general"]);
  const target = tdProject();
  const mine = { type: "http", url: "http://127.0.0.1:13317/mcp" };
  writeFile(join(target, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" }, touchdesigner: mine } }));
  const out = runApply(target, repo);

  const servers = readJson(join(target, ".mcp.json")).mcpServers;
  assert.deepEqual(servers.touchdesigner, mine, "配備先の値を書き換えた");
  assert.deepEqual(servers.other, { command: "x" }, "他のサーバーを消した");
  assert.match(out, /触っていません/);
});

test("上流から消えた skill を配備先から消し、off も取り下げる", () => {
  const repo = fakeUpstream(["td-general", "td-old"]);
  const target = tdProject();
  runApply(target, repo);
  retag(repo, (r) => rmSync(join(r, "skills", "td-old"), { recursive: true }));
  runApply(target, repo);

  assert.ok(!existsSync(join(target, ".claude", "skills", "td-old")), "上流から消えた skill が残った");
  const overrides = readJson(join(target, ".claude", "settings.json")).skillOverrides;
  assert.ok(!("touchdesigner:td-old" in overrides), "上流から消えた skill の off が残った");
  assert.equal(overrides["touchdesigner:td-general"], "off");
});

test("上流が hooks や未知の要素を足したら、黙って無視せず報告する", () => {
  const repo = fakeUpstream(["td-general"], (r) => {
    writeFile(join(r, "hooks", "hooks.json"), "{}\n");
    writeFile(join(r, "brand-new-kind", "x.txt"), "x\n");
  });
  const out = runApply(tdProject(), repo);

  assert.match(out, /警告: 上流に直置きでは再現できない構成要素があります.*hooks/);
  assert.match(out, /警告: 上流に扱いを決めていない要素があります.*brand-new-kind/);
});

test("既存の CLAUDE.md に節が無ければ、書かずに要マージとして報告する", () => {
  const repo = fakeUpstream(["td-general"]);
  const target = tdProject();
  const claudeMd = join(target, ".claude", "CLAUDE.md");
  writeFile(claudeMd, "# 既存\n");
  const out = runApply(target, repo);

  assert.equal(readFileSync(claudeMd, "utf8"), "# 既存\n", "既存の CLAUDE.md を書き換えた");
  assert.match(out, /要マージ[\s\S]*\.claude\/CLAUDE\.md/);
});
