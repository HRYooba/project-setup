// setup-unity インストーラ本体。
//
// 対象 Unity プロジェクトの .claude/ に開発規約一式（rules / skills / agents）を撒く。
// --architecture 指定時はレイヤードアーキテクチャ規約のオーバーレイを上書き配置する。
// --mcp <binding> で Unity MCP 実装のバインディング表を選択し、
//   1) 表の core 節（常時必要な操作）を rules/unity-mcp.md へ合成（常時コンテキスト）
//   2) 表の全文を test-unity / lint-unity 各 skill の references/unity-mcp-tools.md へ配置（遅延参照）
// する（bindings/ に表を追加すれば新実装に対応できる）。旧配置 rules/unity-mcp-tools.md は削除する。
// 冪等（再実行安全）。
//
// 使い方: node apply.mjs [target-dir] [--architecture] [--mcp <binding>]
//         (target-dir 省略時は cwd、--mcp 省略時は導入済みの表を継承、初回は mcp-for-unity)
//
// 依存なし（Node 標準のみ / Node 16.7+ の fs.cpSync を使用）。

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// `## 開発ワークフロー` 見出しの下へ箇条書きをマージする（冪等・単一見出し）。
// bullets: [{ mark, text }]（mark = 冪等判定の一意な部分文字列 / text = 追記する 1 行）。
// 返り値: { bullets: [{ mark, state }] }（state = "present" | "added"）。
// ヘルパーはこのファイル内に閉じる（スキル単体コピーで動くよう外部モジュールに依存しない）。
function upsertWorkflowSection(mdPath, heading, bullets) {
  const joinSep = (c) => (c.endsWith("\n\n") ? "" : c.endsWith("\n") ? "\n" : "\n\n");
  const result = { bullets: [] };
  const makeNewSection = (existing) => {
    const missing = bullets.filter((b) => !(existing && existing.includes(b.mark)));
    for (const b of bullets) {
      result.bullets.push({
        mark: b.mark,
        state: existing && existing.includes(b.mark) ? "present" : "added",
      });
    }
    if (missing.length === 0) return existing;
    const section = `${heading}\n\n${missing.map((b) => b.text).join("\n")}\n`;
    return existing === null ? section : existing + joinSep(existing) + section;
  };
  if (!existsSync(mdPath)) {
    writeFileSync(mdPath, makeNewSection(null), "utf8");
    return result;
  }
  const content = readFileSync(mdPath, "utf8");
  const lines = content.split("\n");
  const headingIdx = lines.findIndex((l) => l.trim() === heading);
  if (headingIdx === -1) {
    const out = makeNewSection(content);
    if (out !== content) writeFileSync(mdPath, out, "utf8");
    return result;
  }
  let end = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const missing = [];
  for (const b of bullets) {
    const present = content.includes(b.mark);
    result.bullets.push({ mark: b.mark, state: present ? "present" : "added" });
    if (!present) missing.push(b.text);
  }
  if (missing.length === 0) return result;
  let insertAt = end;
  while (insertAt > headingIdx + 1 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, ...missing);
  writeFileSync(mdPath, lines.join("\n"), "utf8");
  return result;
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
// マーカーは合成先 rules/unity-mcp.md の先頭行（旧配置 rules/unity-mcp-tools.md からの移行も読む）。
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
  // references / 旧配置の表もそのまま温存する（テンプレートコピーは references を触らない）。
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
    console.log("旧配置の .claude/rules/unity-mcp-tools.md を削除しました（references/ 同梱へ移行）。");
  }
}

// プロジェクト CLAUDE.md へ開発ワークフロー（コンパイル確認・テスト・lint）を追記（冪等）。
// 既存の `## 開発ワークフロー` 見出しがあればその節へマージする（無ければ新設。見出し重複防止）。
const claudeMdPath = join(claudeDir, "CLAUDE.md");
// 旧文言（rules/unity-mcp-tools.md 参照）が残っていれば新文言へ差し替える（配置移行に追随）。
if (existsSync(claudeMdPath)) {
  const md = readFileSync(claudeMdPath, "utf8");
  const migrated = md.replace(
    "- 実装後は `rules/unity-mcp-tools.md`（バインディング表）の「コンパイル確認」を実行（`rules/unity-mcp.md`）",
    "- 実装後は `rules/unity-mcp.md` の「コンパイル確認」を実行",
  );
  if (migrated !== md) writeFileSync(claudeMdPath, migrated, "utf8");
}
const workflow = upsertWorkflowSection(claudeMdPath, "## 開発ワークフロー", [
  {
    mark: "「コンパイル確認」を実行",
    text: "- 実装後は `rules/unity-mcp.md` の「コンパイル確認」を実行",
  },
  {
    mark: "/test-unity",
    text: "- テストは `/test-unity`、アセット検証は `/lint-unity` を使用（`rules/testing.md`）",
  },
]);
const claudeMdState = workflow.bullets.map((b) => b.state).join(" / ");

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
console.log(`CLAUDE.md: 開発ワークフロー節 ${claudeMdState}`);
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
