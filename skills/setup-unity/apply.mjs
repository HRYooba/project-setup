// setup-unity インストーラ本体。
//
// 対象 Unity プロジェクトの .claude/ に開発規約一式（rules / skills / agents）を撒く。
// --architecture 指定時はレイヤードアーキテクチャ規約のオーバーレイを上書き配置する。
// --mcp <binding> で Unity MCP 実装のバインディング表を選択し、
//   1) 表の core 節（常時必要な操作）を rules/unity-mcp.md へ合成（常時コンテキスト）
//   2) 表の全文を test-unity / lint-unity 各 skill の references/unity-mcp-tools.md へ配置（遅延参照）
// する（bindings/ に表を追加すれば新実装に対応できる）。rules/unity-mcp-tools.md があれば削除する。
// 冪等（再実行安全）。
//
// 使い方: node apply.mjs [target-dir] [--architecture] [--mcp <binding>]
//         (target-dir 省略時は cwd、--mcp 省略時は導入済みの表を継承、初回は mcp-for-unity)
//
// 依存なし（Node 標準のみ / Node 16.7+ の fs.cpSync を使用）。

import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
/* global process, console */

// 反映を LLM 判断へ委ねる Markdown（rules/*.md と CLAUDE.md）。apply.mjs は書かず、
// ここへ積んで報告するだけ。実際の統合は SKILL 手順で Claude が現物とテンプレを読んで行う。
// 機械的な上書きはプロジェクト側で育った記述を消し、機械的なスキップはテンプレ更新を
// 永久に届かなくする。どちらも避けるための委譲（テンプレが扱う話題はテンプレ側を正とし、
// プロジェクト固有の追記は残す、という基準は SKILL 手順が持つ）。
const needsMerge = [];
const mdStates = [];

// 「テンプレが最終的に書きたい内容」を一時ディレクトリへ書き出し、そのパスを返す。
// rules/unity-mcp.md はバインディング表との合成結果でディスク上に原本が無いため、
// 比較対象をファイルとして Claude に渡すにはステージングが要る。他の rules も同じ経路に
// 通して、要マージ時の入力を「常に最終内容のファイル」に揃える。
let stagingDir = null;
function stageTemplate(name, content) {
  stagingDir ??= mkdtempSync(join(tmpdir(), "setup-unity-md-"));
  const p = join(stagingDir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

const here = dirname(fileURLToPath(import.meta.url));
const bindingsDir = join(here, "bindings");
const DEFAULT_BINDING = "mcp-for-unity";
const BINDING_MARK = /^<!--\s*binding:\s*(\S+)\s*-->/;
const CORE_MARK = /<!--\s*core:\s*start\s*-->\r?\n([\s\S]*?)<!--\s*core:\s*end\s*-->/;
// バインディング表の全文コピー先（遅延参照側）。各 skill が同梱 references として Read する。
const BINDING_REF_PATHS = [
  "skills/test-unity/references/unity-mcp-tools.md",
  "skills/lint-unity/references/unity-mcp-tools.md",
];

const availableBindings = existsSync(bindingsDir)
  ? readdirSync(bindingsDir).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""))
  : [];

const rawArgs = process.argv.slice(2);
// --mcp は下の消費ループで args から除かれるため、KNOWN_FLAGS には含めない（含めても
// 到達しない死にエントリになる）。unknownFlags 判定に残るのは --architecture のみ。
const KNOWN_FLAGS = new Set(["--architecture"]);
const args = [];
let mcpArg = null;
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === "--mcp") {
    mcpArg = rawArgs[++i];
    if (!mcpArg || mcpArg.startsWith("--")) {
      console.error(`--mcp にはバインディング名が必要です（使用可能: ${availableBindings.join(" / ")}）`);
      process.exit(1);
    }
  } else {
    args.push(a);
  }
}
const unknownFlags = args.filter((a) => a.startsWith("--") && !KNOWN_FLAGS.has(a));
if (unknownFlags.length) {
  console.error(`不明なオプション: ${unknownFlags.join(" ")}（使用可能: --architecture / --mcp <binding>）`);
  process.exit(1);
}
if (mcpArg && !availableBindings.includes(mcpArg)) {
  console.error(`未対応のバインディング: ${mcpArg}（使用可能: ${availableBindings.join(" / ")}）`);
  console.error(`新しい Unity MCP 実装に対応するには ${bindingsDir} に表を追加する。`);
  process.exit(1);
}
let useArchitecture = args.includes("--architecture");
const targetArg = args.find((a) => !a.startsWith("--"));
const target = targetArg ? targetArg : process.cwd();
const claudeDir = join(target, ".claude");

// バインディング表の選択。--mcp 指定 > 導入済みの表から継承 > デフォルト。
// 継承がないと、--mcp 無しの再実行で別実装の表がデフォルトへ静かに巻き戻るため。
// マーカーは合成先 rules/unity-mcp.md の先頭行（rules/unity-mcp-tools.md しか無い配備先はそちらを読む）。
const deployedRulePath = join(claudeDir, "rules", "unity-mcp.md");
const legacyToolsPath = join(claudeDir, "rules", "unity-mcp-tools.md");
let binding = mcpArg;
let bindingInherited = false;
// マーカーはあるが、このスキルの bindings/ に該当表が無い（別マシンで追加された実装等）
// 場合。デフォルトへ巻き戻して上書きすると接続中 MCP と不一致になるため、配備済みを温存する。
let bindingUnknownDeployed = null;
const deployedRuleBefore = existsSync(deployedRulePath) ? readFileSync(deployedRulePath, "utf8") : null;
if (!binding) {
  for (const content of [deployedRuleBefore, existsSync(legacyToolsPath) ? readFileSync(legacyToolsPath, "utf8") : null]) {
    const m = content && content.match(BINDING_MARK);
    if (!m) continue;
    if (availableBindings.includes(m[1])) {
      binding = m[1];
      bindingInherited = binding !== DEFAULT_BINDING;
    } else {
      bindingUnknownDeployed = m[1];
    }
    break;
  }
}
if (!binding && !bindingUnknownDeployed) binding = DEFAULT_BINDING;
if (binding && !availableBindings.includes(binding)) {
  console.error(`バインディング表が見つかりません: ${join(bindingsDir, binding + ".md")}`);
  process.exit(1);
}

// architecture 導入済みの検知。フラグ無しで再実行すると base がレイヤー版の
// folder-structure / coding-standards / testing 等を静かに巻き戻し、
// architecture.md だけ残る混在状態になるため、導入済みならモードを自動継承する。
let architectureInherited = false;
if (!useArchitecture && existsSync(join(claudeDir, "rules", "architecture.md"))) {
  useArchitecture = true;
  architectureInherited = true;
}

const layers = ["base"];
if (useArchitecture) layers.push("architecture");

for (const layer of layers) {
  if (!existsSync(join(here, "templates", layer))) {
    console.error(`テンプレートが見つかりません: ${join(here, "templates", layer)}`);
    process.exit(1);
  }
}

if (!existsSync(join(target, "ProjectSettings", "ProjectVersion.txt"))) {
  console.error(`Unity プロジェクトではありません（ProjectSettings/ProjectVersion.txt がない）: ${target}`);
  process.exit(1);
}

// rules/*.md は cpSync が無条件に上書きするため、適用前の現物をここで退避しておく。
// cpSync とバインディング合成を通した後の内容が「テンプレが最終的に書きたい内容」になるので、
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

// 選択されたバインディング表を二層で配置:
//   常時層: core 節を rules/unity-mcp.md（方針ヘッダ）へ合成。先頭にマーカーを付けて再実行時の継承に使う
//   遅延層: 全文を各 skill の references/unity-mcp-tools.md へコピー（skill / agent が必要時に Read）
// 未対応バインディングが配備済みのときは上書きせず温存する（接続中 MCP との不一致を防ぐ）。
if (bindingUnknownDeployed) {
  // cpSync が rules/unity-mcp.md をテンプレートで上書きしているため、合成済みだった内容を戻す。
  // references 側の表もそのまま温存する（テンプレートコピーは references を触らない）。
  if (deployedRuleBefore !== null) writeFileSync(deployedRulePath, deployedRuleBefore, "utf8");
  copied.set("rules/unity-mcp.md", `binding: ${bindingUnknownDeployed}（未対応・温存）`);
} else {
  const bindingSrc = join(bindingsDir, `${binding}.md`);
  const bindingText = readFileSync(bindingSrc, "utf8");
  const core = bindingText.match(CORE_MARK);
  if (!core) {
    console.error(`バインディング表に core 節がありません: ${bindingSrc}`);
    console.error("常時必要な操作（失敗判定 / 禁止事項 / コンパイル確認 / コンソールエラー取得 等）を <!-- core: start --> 〜 <!-- core: end --> で囲んでください。");
    process.exit(1);
  }
  const ruleHeader = readFileSync(deployedRulePath, "utf8"); // cpSync 直後 = テンプレートの方針ヘッダ
  const sep = ruleHeader.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(deployedRulePath, `<!-- binding: ${binding} -->\n${ruleHeader}${sep}${core[1].trimEnd()}\n`, "utf8");
  copied.set("rules/unity-mcp.md", `binding: ${binding} 合成`);
  for (const ref of BINDING_REF_PATHS) {
    const dest = join(claudeDir, ...ref.split("/"));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(bindingSrc, dest);
    copied.set(ref, `binding: ${binding} 全文`);
  }
  if (existsSync(legacyToolsPath)) {
    rmSync(legacyToolsPath);
    console.log(".claude/rules/unity-mcp-tools.md を削除しました（表は references/ 同梱へ移動）。");
  }
}

// ---- rules/*.md の突き合わせ（差分があれば現物へ戻して要マージにする） ----
// この時点の .claude/rules/*.md ＝ cpSync + バインディング合成が置いた「テンプレの最終内容」。
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

// ---- 状態ファイル setup-sync-state.json への setup-unity キーの記録 ----
// このスキルは settings.json に触れず hook も配らない（従来の契約どおり）。同期チェック hook は
// setup-github が配る単一の setup-sync-check.mjs が担い、この状態ファイルの全キー（setup-github /
// setup-unity）を現行版と比較する。ここでは自分のキー（適用時のプラグイン版と有効フラグ）だけを
// マージ更新し、setup-github のキーや未知フィールドは温存する。ヘルパーはこのファイルに閉じる
// （スキル単体コピーで動くよう外部モジュールに依存しない ＝ upsertWorkflowSection と同方針）。
let syncState = null;
const pluginVersion = readPluginVersion();
if (pluginVersion) {
  const syncFlags = [];
  if (useArchitecture) syncFlags.push("--architecture");
  // 未対応バインディングを温存中のときは --mcp を保存しない（テンプレ同期の再適用が未知値でエラーになるため。
  // その場合は配備済みマーカーからの継承に任せる）。
  if (binding && !bindingUnknownDeployed) syncFlags.push("--mcp", binding);
  writeSyncState("setup-unity", pluginVersion, syncFlags);
  syncState = `setup-unity v${pluginVersion}（flags: ${syncFlags.join(" ") || "なし"}）`;
} else {
  console.log(
    "注意: .claude-plugin/plugin.json のバージョンを読めなかったため setup-sync-state.json を書きませんでした（テンプレ自動追随は無効のまま）。"
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

// 状態ファイル `.claude/setup-sync-state.json` へ自分のキー（skillKey）をマージ更新する。相手のキーや
// 未知フィールドは消さない（読み → 該当キーだけ差し替え → 書き戻し）。
function writeSyncState(skillKey, version, flags) {
  const p = join(claudeDir, "setup-sync-state.json");
  let obj = {};
  if (existsSync(p)) {
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
      if (parsed && typeof parsed === "object") obj = parsed;
    } catch {
      console.log("注意: setup-sync-state.json が不正な JSON のため作り直します（他スキルのキーは失われる可能性あり）。");
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
if (bindingUnknownDeployed) {
  console.log(`バインディング表: ${bindingUnknownDeployed}（このスキルの bindings/ に無い・温存。利用可能: ${availableBindings.join(" / ")}）`);
  console.log(`注意: 配備済みの未対応バインディング表 "${bindingUnknownDeployed}" を検出したため上書きしませんでした（デフォルトへの巻き戻り防止）。この表を更新するには ${bindingsDir} に ${bindingUnknownDeployed}.md を追加するか、--mcp <binding> で明示指定してください。`);
} else {
  console.log(`バインディング表: ${binding}（利用可能: ${availableBindings.join(" / ")}）`);
  if (bindingInherited) {
    console.log("注意: 導入済みのバインディング表を検出したため、--mcp 指定なしでも同じ表を継承しました（巻き戻り防止）。");
  }
}
console.log("配置ファイル:");
for (const [f, layer] of [...copied.entries()].sort()) {
  console.log(`  - .claude/${f}${layer === "base" ? "" : `  (${layer})`}`);
}
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
if (syncState) console.log(`状態ファイル(setup-sync-state.json): ${syncState}`);
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
