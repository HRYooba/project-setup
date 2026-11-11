// setup-touchdesigner インストーラ本体。
//
// 対象 TouchDesigner プロジェクトへ次を配る。冪等（再実行安全）。
//   - TDMCP 本体（TDMCP.tox）を固定 release から取得し、プロジェクト直下へ置く（LICENSE を添える）
//   - `.mcp.json` へ TDMCP の接続（`touchdesigner`）をマージする
//   - `.claude/CLAUDE.md` へ TouchDesigner 操作の方針の節を配る（差分があれば要マージ）
//   - `.claude/sync-setup-state.json` へ自分のキーを記録する
//
// skill（td-*）は配らない。TDMCP コンポーネントの Install Skills が、コンポーネントで選んだ範囲
// （Local / Project / User）へ入れる。
// 以前の版が直置きした td-* skill は、記録にあるものだけを取り除く（コンポーネントの Install Skills と
// 二重に読まれるため）。記録は取り除き終えてから消す（消せなかった回は次の適用でやり直す）。
//
// 使い方: node apply.mjs [target-dir]   (target-dir 省略時は cwd)
//
// Node 18+ の標準のみ。ネットワークは release の取得だけ。失敗しても続行する（他の配置は決定的に完了させる）。

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { consolidateSyncState } from "../sync-setup/state.mjs";
import { createMergeQueue, deployClaudeMdSection } from "../shared/markdown-merge.mjs";
import { readOwnSkillVersion, readRecordedState, writeSyncState } from "../shared/skill-state.mjs";
import { removeLegacySkills } from "./legacy-skills.mjs";
import { placeTdmcpTox } from "./tdmcp-tox.mjs";
import { TDMCP_REPO, TDMCP_TAG, TDMCP_TOX_SHA256 } from "./upstream.mjs";
/* global process, console */

const SKILL_KEY = "setup-touchdesigner";
const here = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const unknownFlags = args.filter((a) => a.startsWith("--"));
if (unknownFlags.length) {
  console.error(`不明なオプション: ${unknownFlags.join(" ")}（このコマンドはオプションを取りません）`);
  process.exit(1);
}
// 空文字の引数をカレント扱いにしない（シェル変数の展開漏れで意図しない場所へ配る）。
if (args.length && !args[0].trim()) {
  console.error("導入先ディレクトリが空文字です。");
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

// ---- 以前の版が直置きした td-* skill の取り除き ----
// skillOverrides の "off"（プラグイン版の同名 skill を伏せるもの）は残す。skill をコンポーネントから
// 入れても、プラグイン版が並べば二重に読まれる点は変わらない。
const recorded = readRecordedState(claudeDir, SKILL_KEY);
const legacy = removeLegacySkills(claudeDir, recorded.tdmcpSkills);

// ---- TDMCP 本体（TDMCP.tox）----
const tox = await placeTdmcpTox({ target, repo: TDMCP_REPO, tag: TDMCP_TAG, sha256: TDMCP_TOX_SHA256 });

// ---- MCP 接続（.mcp.json）----
// コンポーネントの Add MCP（Install Scope: Project）が出す `claude mcp add --scope project` と同じ中身を書く。
// CLI を呼ばないのは、CLI の無い環境（テンプレ同期の worktree など）でも配れるようにするため。
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
  // 直置きの記録は取り除き終えたら消す。消せなかった回は引き継いで、次の適用でやり直す。
  const recreated = writeSyncState(
    claudeDir,
    SKILL_KEY,
    { skillVersion, flags: [] },
    { carryOver: legacy.done ? [] : ["tdmcpSkills"] }
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
console.log(`TDMCP 本体（TDMCP.tox）: ${tox.state}`);
if (tox.warning) console.log(`警告: ${tox.warning}`);
console.log(`MCP 接続（.mcp.json）: ${mcpState}`);
if (recorded.tdmcpSkills) console.log(`以前に直置きした td-* skill: ${legacy.state}`);
console.log("Markdown:");
console.log(`  - .claude/CLAUDE.md: ${claudeMdState}`);
mergeQueue.print();
if (syncState) console.log(`状態ファイル(sync-setup-state.json): ${syncState}`);
// .toe の有無は判定にしない（テンプレ同期の部分展開 worktree には無い）。人が打ったときだけ知らせる。
if (process.env.SYNC_SETUP_SPARSE_WORKTREE !== "1" && !readdirSync(target).some((n) => /\.toe$/i.test(n))) {
  console.log("注意: 導入先の直下に .toe がありません。TouchDesigner プロジェクトのルートか確かめてください。");
}
