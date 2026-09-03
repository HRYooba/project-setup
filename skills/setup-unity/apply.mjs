// setup-unity インストーラ本体。
//
// 対象 Unity プロジェクトの .claude/ に開発規約一式（rules / skills / agents）を撒く。
// --architecture 指定時はレイヤードアーキテクチャ規約のオーバーレイを上書き配置する。
// templates/project/ は .claude/ ではなく Unity プロジェクト本体へ配る（常時）:
// Roslyn analyzer（Assets/Analyzers/。Unity は Assets 配下の RoslynAnalyzer ラベル付き DLL だけを
// csc へ渡すので置き場所が動作条件そのもの）と、PR ゲートの GitHub Actions（.github/）。
// Unity 操作の手段は Unity CLI に固定。配備先に OBSOLETE_PATHS のファイルがあれば取り除く。
// 冪等（再実行安全）。
//
// 使い方: node apply.mjs [target-dir] [--architecture]
//         (target-dir 省略時は cwd)
//
// 依存なし（Node 標準のみ / Node 16.7+ の fs.cpSync を使用）。

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { consolidateSyncState } from "../sync-setup/state.mjs";
/* global process, console */

// 反映を LLM 判断へ委ねる Markdown（rules/*.md と CLAUDE.md）。apply.mjs は書かず、
// ここへ積んで報告するだけ。実際の統合は SKILL 手順で Claude が現物とテンプレを読んで行う。
// 機械的な上書きはプロジェクト側で育った記述を消し、機械的なスキップはテンプレ更新を
// 永久に届かなくする。どちらも避けるための委譲（テンプレが扱う話題はテンプレ側を正とし、
// プロジェクト固有の追記は残す、という基準は SKILL 手順が持つ）。
const needsMerge = [];
const mdStates = [];

// 「テンプレが最終的に書きたい内容」を一時ディレクトリへ書き出し、そのパスを返す。
// 要マージ時の入力を「常に最終内容のファイル」に揃えるための経路。
let stagingDir = null;
function stageTemplate(name, content) {
  stagingDir ??= mkdtempSync(join(tmpdir(), "setup-unity-md-"));
  const p = join(stagingDir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

const here = dirname(fileURLToPath(import.meta.url));

// このスキルが配らないファイル。配備先に残っていると常時コンテキストへ載り、
// 現行の rules と手順が二重になるので取り除く。
// （プロジェクト固有の追記があった場合は配備先の git 履歴から復元できる）
//
// test-unity は skill をやめた。判断基準と決めごとは rules/testing.md、実装後に回す検査は
// rules/dev-flow.md が持つ。skill / agent / 旧 references が残っていると古い基準で動くため消す。
const OBSOLETE_PATHS = [
  "rules/unity-mcp.md",
  "rules/unity-mcp-tools.md",
  "skills/test-unity/SKILL.md",
  "skills/test-unity/references/test-designing-guide.md",
  "skills/test-unity/references/test-writing-guide.md",
  "skills/test-unity/references/unity-mcp-tools.md",
  "skills/lint-unity/references/unity-mcp-tools.md",
  "references/test-designing-guide.md",
  "references/test-writing-guide.md",
  "agents/unity-tester.md",
];

const rawArgs = process.argv.slice(2);
const KNOWN_FLAGS = new Set(["--architecture"]);
const args = [];
// 廃止したフラグ。配備先の sync-setup-state.json に記録が残っていることがあり、テンプレ同期は
// それをそのまま渡してくる。ここでエラー終了すると同期が永久に失敗するため、注意を出して捨てて
// 続行する（次の適用で state から消える）。「不明なオプションはエラー」の唯一の例外。
//   --mcp <値>           Unity 操作は Unity CLI に固定した
//   --analyzer           analyzer は常時配置になった（coding-standards.md が常時配られる以上、
//                        その機械実装だけ任意にする理由が無い）
//   --analyzer-severity  severity は Warning 固定になった（Error にすると Unity が Safe Mode へ
//                        落ちる。PR の gate は CI が担う）
const droppedFlags = [];
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === "--mcp") {
    const value = rawArgs[i + 1] && !rawArgs[i + 1].startsWith("--") ? rawArgs[++i] : "(値なし)";
    droppedFlags.push(`--mcp ${value}`);
  } else if (a === "--analyzer" || a.split("=")[0] === "--analyzer-severity") {
    droppedFlags.push(a);
  } else {
    args.push(a);
  }
}
const unknownFlags = args.filter((a) => a.startsWith("--") && !KNOWN_FLAGS.has(a));
if (unknownFlags.length) {
  console.error(`不明なオプション: ${unknownFlags.join(" ")}（使用可能: --architecture）`);
  process.exit(1);
}
let useArchitecture = args.includes("--architecture");
const targetArg = args.find((a) => !a.startsWith("--"));
const target = targetArg ? targetArg : process.cwd();
const claudeDir = join(target, ".claude");

// architecture 導入済みの検知。フラグ無しで再実行すると base がレイヤー版の
// folder-structure / coding-standards / testing 等を静かに巻き戻し、
// architecture.md だけ残る混在状態になるため、導入済みならモードを自動継承する。
let architectureInherited = false;
if (!useArchitecture && existsSync(join(claudeDir, "rules", "architecture.md"))) {
  useArchitecture = true;
  architectureInherited = true;
}

// .claude/ の外へ配るもの（analyzer の DLL と PR ゲートの workflow）。常時配置。
const projectTemplate = join(here, "templates", "project");

const layers = ["base"];
if (useArchitecture) layers.push("architecture");

for (const layer of layers) {
  if (!existsSync(join(here, "templates", layer))) {
    console.error(`テンプレートが見つかりません: ${join(here, "templates", layer)}`);
    process.exit(1);
  }
}

if (!existsSync(join(projectTemplate, "Assets", "Analyzers", "UnityCodingStandards.Analyzers.dll"))) {
  console.error(
    `analyzer の配布物が見つかりません: ${projectTemplate}\n` +
      "（開発リポジトリでは `node analyzers/build.mjs` を先に実行する）"
  );
  process.exit(1);
}

if (!existsSync(join(target, "ProjectSettings", "ProjectVersion.txt"))) {
  console.error(`Unity プロジェクトではありません（ProjectSettings/ProjectVersion.txt がない）: ${target}`);
  process.exit(1);
}

// rules/*.md は cpSync が無条件に上書きするため、適用前の現物をここで退避しておく。
// cpSync を通した後の内容が「テンプレが最終的に書きたい内容」になるので、
// それと退避分を突き合わせて、差分があるファイルだけ現物へ戻す（＝ apply.mjs は書かない）。
const rulesDir = join(claudeDir, "rules");
const rulesBefore = new Map();
if (existsSync(rulesDir)) {
  for (const f of readdirSync(rulesDir)) {
    if (f.endsWith(".md")) rulesBefore.set(f, readFileSync(join(rulesDir, f), "utf8"));
  }
}

// base → (--architecture 時) architecture の順に上書きコピー
mkdirSync(claudeDir, { recursive: true });
const copied = new Map(); // 相対パス → 由来レイヤー
for (const layer of layers) {
  const src = join(here, "templates", layer);
  cpSync(src, claudeDir, { recursive: true });
  for (const f of walk(src)) {
    copied.set(relative(src, f).split(sep).join("/"), layer);
  }
}

// 取り除く対象は、下の rules 突き合わせより先に消す必要がある（残っていると
// 「テンプレに無い rules」として要マージ側に回り、消えないまま常時コンテキストに残る）。
const removedLegacy = [];
for (const rel of OBSOLETE_PATHS) {
  const p = join(claudeDir, ...rel.split("/"));
  if (!existsSync(p)) continue;
  try {
    rmSync(p);
    removedLegacy.push(rel);
  } catch (e) {
    // 他の IO と同じく、消せなくても適用全体は止めない（配置物は配り切る）
    console.log(`注意: 旧配備物を削除できませんでした（手で消してください）: .claude/${rel} — ${e.message}`);
  }
}

// 空になったディレクトリを畳む。ファイルだけ消すと skills/test-unity/references/ のような
// 空の殻が残り、配備先を見た人が「まだあるもの」と読む。
for (const rel of OBSOLETE_PATHS) {
  const parts = rel.split("/");
  for (let depth = parts.length - 1; depth >= 1; depth--) {
    const dir = join(claudeDir, ...parts.slice(0, depth));
    try {
      if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
    } catch {
      // 消せなくても害はない（空ディレクトリが残るだけ）
    }
  }
}

// ---- rules/*.md の突き合わせ（差分があれば現物へ戻して要マージにする） ----
// この時点の .claude/rules/*.md ＝ cpSync が置いた「テンプレの最終内容」。
// 退避しておいた適用前の現物と比べ、差分があるものだけ現物へ書き戻す。
for (const f of readdirSync(rulesDir).filter((n) => n.endsWith(".md"))) {
  const p = join(rulesDir, f);
  const wanted = readFileSync(p, "utf8");
  const before = rulesBefore.get(f);
  if (before === undefined) {
    mdStates.push(`rules/${f}: 新規配置`);
  } else if (before === wanted) {
    mdStates.push(`rules/${f}: 変更なし`);
  } else {
    writeFileSync(p, before, "utf8"); // apply.mjs は書かない（現物を維持する）
    copied.delete(`rules/${f}`); // 配置していないので「配置ファイル」から外す
    needsMerge.push({ label: `.claude/rules/${f}`, dst: p, src: stageTemplate(f, wanted) });
    mdStates.push(`rules/${f}: 要マージ`);
  }
}

// ---- CLAUDE.md への反映（apply.mjs は書かない） ----
// 配る内容は templates/claude-md.md（節そのもの）。配る文面を定数で持ち、移行を完全一致の
// 置換で追いかける書き方はしない（文面を変えるたびに移行コードが増える＝腐る）。
// 古い運用行は SKILL 手順のマージで Claude がテンプレ側を正として置き換える。
const claudeMdPath = join(claudeDir, "CLAUDE.md");
const claudeMdSrc = join(here, "templates", "claude-md.md");
const claudeMdSection = readFileSync(claudeMdSrc, "utf8");

// テンプレは「節」を配るので全文一致では判定できない。節の非空行がすべて配備先にあれば
// 反映済みとみなす。判定基準がテンプレ本体から導出されるので、別途マーカー文字列を維持
// する必要がない（文面を変えれば行が一致しなくなり、その時だけ要マージになる）。
function sectionApplied(dstText, sectionText) {
  return sectionText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .every((l) => dstText.includes(l));
}

let claudeMdState;
if (!existsSync(claudeMdPath)) {
  writeFileSync(claudeMdPath, claudeMdSection, "utf8");
  claudeMdState = "新規作成";
} else if (sectionApplied(readFileSync(claudeMdPath, "utf8"), claudeMdSection)) {
  claudeMdState = "変更なし";
} else {
  needsMerge.push({ label: ".claude/CLAUDE.md", dst: claudeMdPath, src: claudeMdSrc });
  claudeMdState = "要マージ";
}

// ---- Unity プロジェクト本体へ配るもの（.claude/ の外）----
// Roslyn analyzer は Assets 配下にあり RoslynAnalyzer ラベルの付いた DLL だけが csc へ渡るため、
// 置き場所と .meta が動作条件そのものになる。PR ゲートの workflow は .github/ へ。
// どちらもビルド成果物・配布物なので無条件に上書きする（設定ファイルは配らないので、
// 配備先が育てる余地のあるファイルはここに無い ＝ マージ判定が要らない）。
const projectStates = [];
cpSync(projectTemplate, target, { recursive: true });
for (const f of walk(projectTemplate)) {
  projectStates.push(`${relative(projectTemplate, f).split(sep).join("/")}: 配置`);
}
projectStates.sort();

// 旧名の状態ファイルを正名へ畳んで消す。規則は skills/sync-setup/state.mjs が正本
// （読み手側も同じ規則で旧名を解決する。片方だけ直すと配備先が黙って同期対象外になる）。
const migratedState = consolidateSyncState(claudeDir);
if (migratedState) console.log(`状態ファイル: ${migratedState}`);

// ---- 状態ファイル sync-setup-state.json への setup-unity キーの記録 ----
// このスキルは settings.json に触れず hook も配らない（従来の契約どおり）。同期チェック hook は
// setup-github が配る単一の sync-setup-check.mjs が担い、この状態ファイルの全キー（setup-github /
// setup-unity）を現行版と比較する。ここでは自分のキー（適用時のプラグイン版と有効フラグ）だけを
// マージ更新し、setup-github のキーや未知フィールドは温存する。ヘルパーはこのファイルに閉じる
// （スキル単体コピーで動くよう外部モジュールに依存しない ＝ upsertWorkflowSection と同方針）。
let syncState = null;
const pluginVersion = readPluginVersion();
if (pluginVersion) {
  const syncFlags = [];
  if (useArchitecture) syncFlags.push("--architecture");
  writeSyncState("setup-unity", pluginVersion, syncFlags);
  syncState = `setup-unity v${pluginVersion}（flags: ${syncFlags.join(" ") || "なし"}）`;
} else {
  console.log(
    "注意: .claude-plugin/plugin.json のバージョンを読めなかったため sync-setup-state.json を書きませんでした（テンプレ自動追随は無効のまま）。"
  );
}

// このプラグインの現行版を読む（`.claude-plugin/plugin.json`）。apply.mjs は skills/setup-unity/ に
// あるので plugin root は 2 つ上。cache 版でも dev repo でも同じ相対で当たる。読めなければ null。
function readPluginVersion() {
  try {
    const pj = JSON.parse(
      readFileSync(join(here, "..", "..", ".claude-plugin", "plugin.json"), "utf8").replace(/^\uFEFF/, "")
    );
    return typeof pj.version === "string" ? pj.version : null;
  } catch {
    return null;
  }
}

// 状態ファイル `.claude/sync-setup-state.json` へ自分のキー（skillKey）をマージ更新する。相手のキーや
// 未知フィールドは消さない（読み → 該当キーだけ差し替え → 書き戻し）。
function writeSyncState(skillKey, version, flags) {
  const p = join(claudeDir, "sync-setup-state.json");
  let obj = {};
  if (existsSync(p)) {
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
      if (parsed && typeof parsed === "object") obj = parsed;
    } catch {
      console.log("注意: sync-setup-state.json が不正な JSON のため作り直します（他スキルのキーは失われる可能性あり）。");
    }
  }
  obj[skillKey] = { version, flags };
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

console.log(`インストール先: ${claudeDir}`);
console.log(`モード: ${useArchitecture ? "architecture（レイヤードアーキテクチャ規約込み）" : "base（アーキテクチャ規約なし）"}`);
if (architectureInherited) {
  console.log("注意: 導入済みの architecture 規約を検出したため、--architecture 指定なしでも architecture モードで適用しました（巻き戻り防止）。");
}
console.log("Unity 操作: Unity CLI（rules/unity-cli.md）");
if (droppedFlags.length) {
  console.log(`注意: 廃止したオプションを無視しました: ${droppedFlags.join(" / ")}`);
  console.log(
    "  Unity 操作は Unity CLI に固定、analyzer は常時配置・severity は Warning 固定です" +
      "（PR の gate は .github/workflows/unity-ci.yml が担います）。"
  );
}
if (removedLegacy.length) {
  console.log("取り除いたファイル（rules/unity-cli.md と手順が二重になるため）:");
  for (const rel of removedLegacy) console.log(`  - .claude/${rel}`);
  console.log(
    "注意: これらは要マージにせず削除しました。プロジェクト固有の追記があった場合は失われています" +
      "（git 管理下なら `git diff` / `git checkout` で復元できます。管理外なら復元できません）。"
  );
}
console.log("配置ファイル:");
for (const [f, layer] of [...copied.entries()].sort()) {
  console.log(`  - .claude/${f}${layer === "base" ? "" : `  (${layer})`}`);
}
console.log("Unity プロジェクト本体（.claude/ の外）:");
for (const state of projectStates) console.log(`  - ${state}`);
console.log("Markdown（rules / CLAUDE.md）:");
for (const s of mdStates) console.log(`  - .claude/${s}`);
console.log(`  - .claude/CLAUDE.md: ${claudeMdState}`);
// 要マージは「apply.mjs が意図的に書かなかったファイル」。SKILL 手順がこの一覧を読んで
// Claude にマージさせる。ここで止めずに続行するのは、他の配置物は決定的に配り切るため。
if (needsMerge.length) {
  console.log("要マージ（apply.mjs は書いていない。Claude が現物とテンプレを読んで統合する）:");
  for (const m of needsMerge) {
    console.log(`  * ${m.label}`);
    console.log(`      現物    : ${m.dst}`);
    console.log(`      テンプレ: ${m.src}`);
  }
}
if (syncState) console.log(`状態ファイル(sync-setup-state.json): ${syncState}`);
if (!existsSync(join(target, "Assets", "App"))) {
  console.log("注意: Assets/App/ が存在しません。規約はアプリ本体を Assets/App/ 配下に置く前提です。");
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
