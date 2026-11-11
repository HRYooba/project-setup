// setup-touchdesigner インストーラ本体。
//
// 対象 TouchDesigner プロジェクトへ次を配る。冪等（再実行安全）。
//   - TDMCPSkills（`td-*` skill）を `.claude/skills/` へ直置きし、LICENSE を添える
//   - プラグインとして入っている同名 skill を `.claude/settings.json` の skillOverrides で伏せる
//   - `.mcp.json` へ TDMCP の接続（`touchdesigner`）をマージする
//   - `.claude/CLAUDE.md` へ TouchDesigner 操作の方針の節を配る（差分があれば要マージ）
//   - `.claude/sync-setup-state.json` へ自分のキーを記録する
//
// 使い方: node apply.mjs [target-dir]   (target-dir 省略時は cwd)
//
// Node 標準のみ。外部コマンドは git 1 つ（上流の clone）。失敗しても続行する（他の配置は決定的に完了させる）。

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { consolidateSyncState } from "../sync-setup/state.mjs";
import { createMergeQueue, deployClaudeMdSection } from "../shared/markdown-merge.mjs";
import { readOwnSkillVersion, readRecordedState, writeSyncState } from "../shared/skill-state.mjs";
import {
  disablePluginSkills,
  printCollisionWarning,
  printUpstreamWarnings,
  vendorUpstreamPlugin,
} from "../shared/upstream-plugin.mjs";
import { TDMCP_SKILLS_REPO, TDMCP_SKILLS_TAG } from "./upstream.mjs";
/* global process, console */

const SKILL_KEY = "setup-touchdesigner";
const here = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const unknownFlags = args.filter((a) => a.startsWith("--"));
if (unknownFlags.length) {
  console.error(`不明なオプション: ${unknownFlags.join(" ")}（このコマンドはオプションを取りません）`);
  process.exit(1);
}
const target = args[0] ?? process.cwd();
const claudeDir = join(target, ".claude");
mkdirSync(claudeDir, { recursive: true });

const mergeQueue = createMergeQueue("setup-touchdesigner-md-");

// ---- CLAUDE.md の節 ----
const claudeMdSrc = join(here, "templates", "claude-md.md");
const claudeMdState = deployClaudeMdSection(mergeQueue, {
  dst: join(claudeDir, "CLAUDE.md"),
  section: readFileSync(claudeMdSrc, "utf8"),
  label: ".claude/CLAUDE.md",
  mergeSrc: claudeMdSrc,
});

// ---- TDMCPSkills の直置き ----
// 上流は skill の中身だけを持つリポジトリ。配るのは skills/ だけで、残りは開発用ファイル。
// `.mcp.json` は上流の開発用（名前 `tdmcp`・`localhost`）で配備先向けではないため配らない —
// 接続は下の registerMcpServer が正しい値で書く。
// 上流の差し替え口 SETUP_TOUCHDESIGNER_SKILLS_REPO は**テスト専用**（配備先の運用では設定しない）。
const recorded = readRecordedState(claudeDir, SKILL_KEY);
const tdSkills = vendorUpstreamPlugin({
  repo: process.env.SETUP_TOUCHDESIGNER_SKILLS_REPO || TDMCP_SKILLS_REPO,
  ref: TDMCP_SKILLS_TAG,
  refNotes: {
    missing: "",
    failed: (ref) => `（tag ${ref} を取得できないため HEAD）`,
  },
  claudeDir,
  recorded: recorded.tdmcpSkills,
  isOwn: () => false,
  inert: [
    ".git",
    ".github",
    ".gitignore",
    ".claude-plugin",
    ".claude",
    ".mcp.json",
    "CHANGELOG.md",
    "CLAUDE.md",
    "LICENSE.md",
    "README.md",
    "SKILLS.md",
    "VERSION",
    "build_plugin.py",
    "smoketest",
    "validate.py",
  ],
  unsupported: ["hooks"],
  licenseName: "TDMCP-SKILLS-LICENSE.md",
  tmpPrefix: "tdmcp-skills-",
});

// 同じ skill は 2 つのプラグイン名で Claude Code に届きうる: TDMCPSkills の marketplace から
// 入れた `tdmcp-skills`、Claude Desktop 向けプラグインがアカウント同期で届く `touchdesigner`。
const overridesState = disablePluginSkills(
  claudeDir,
  ["tdmcp-skills", "touchdesigner"],
  tdSkills.record?.placed?.skills ?? [],
  Array.isArray(recorded.tdmcpSkills?.placed?.skills) ? recorded.tdmcpSkills.placed.skills.map(String) : []
);

// ---- MCP 接続（.mcp.json）----
// TDMCP は TouchDesigner の中で動く HTTP の MCP サーバー。`127.0.0.1` を字句どおりに書く
// （ソケットが IPv4 のみで、`localhost` は多くの環境で `::1` へ先に解決される）。
// **既に `touchdesigner` があれば触らない。** ポートやサーバー名はプロジェクトごとに変えうる
// （1 台で複数の TouchDesigner を動かすと各自のポートが要る）ので、配備先の値を正とする。
const MCP_NAME = "touchdesigner";
const MCP_ENTRY = { type: "http", url: "http://127.0.0.1:13316/mcp" };

function registerMcpServer() {
  const p = join(target, ".mcp.json");
  let obj = {};
  if (existsSync(p)) {
    try {
      obj = JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
    } catch {
      return "見送りました（.mcp.json が不正な JSON です。手で直してから再実行してください）";
    }
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
      return "見送りました（.mcp.json のトップレベルがオブジェクトではありません）";
    }
  }
  const servers = obj.mcpServers ?? {};
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    return "見送りました（.mcp.json の mcpServers がオブジェクトではありません）";
  }
  const current = servers[MCP_NAME];
  if (current !== undefined) {
    const same = JSON.stringify(current) === JSON.stringify(MCP_ENTRY);
    return same ? "変更なし" : `触っていません（既存の ${MCP_NAME}: ${JSON.stringify(current)} を配備先の値とみなします）`;
  }
  obj.mcpServers = { ...servers, [MCP_NAME]: MCP_ENTRY };
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
  return `${MCP_NAME} → ${MCP_ENTRY.url} を登録しました`;
}
const mcpState = registerMcpServer();

// ---- 状態ファイル ----
const migratedState = consolidateSyncState(claudeDir);
if (migratedState) console.log(`状態ファイル: ${migratedState}`);
let syncState = null;
const skillVersion = readOwnSkillVersion(here);
if (skillVersion) {
  // tdmcpSkills は「上流をどの sha から、どの名前で配ったか」。clone できなかった回は前回の記録を引き継ぐ。
  const recreated = writeSyncState(
    claudeDir,
    SKILL_KEY,
    { skillVersion, flags: [], tdmcpSkills: tdSkills.record },
    { carryOver: ["tdmcpSkills"] }
  );
  if (recreated) {
    console.log("注意: sync-setup-state.json が不正な JSON のため作り直します（他スキルのキーは失われる可能性あり）。");
  }
  syncState = `${SKILL_KEY} v${skillVersion}`;
} else {
  console.log(
    "注意: SKILL.md の version を読めなかったため sync-setup-state.json を書きませんでした（テンプレ自動追随は無効のまま）。"
  );
}

// ---- 報告 ----
console.log(`インストール先: ${claudeDir}`);
console.log(`TDMCPSkills（tag ${TDMCP_SKILLS_TAG}）: ${tdSkills.state}`);
console.log(`プラグイン版の同名 skill（skillOverrides）: ${overridesState}`);
console.log(`MCP 接続（.mcp.json）: ${mcpState}`);
printUpstreamWarnings(tdSkills, SKILL_KEY);
printCollisionWarning(tdSkills, SKILL_KEY);
console.log("Markdown:");
console.log(`  - .claude/CLAUDE.md: ${claudeMdState}`);
mergeQueue.print();
if (syncState) console.log(`状態ファイル(sync-setup-state.json): ${syncState}`);
// .toe の有無は判定にしない（テンプレ同期の部分展開 worktree には無い）。人が打ったときだけ知らせる。
if (process.env.SYNC_SETUP_SPARSE_WORKTREE !== "1" && !readdirSync(target).some((n) => /\.toe$/i.test(n))) {
  console.log("注意: 導入先の直下に .toe がありません。TouchDesigner プロジェクトのルートか確かめてください。");
}
