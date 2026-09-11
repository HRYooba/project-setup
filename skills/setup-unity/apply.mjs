// setup-unity インストーラ本体。
//
// 対象 Unity プロジェクトの .claude/ に開発規約一式（rules / skills / agents）を撒く。
// --architecture 指定時はレイヤードアーキテクチャ規約のオーバーレイを上書き配置する。
// templates/project/ は .claude/ ではなく Unity プロジェクト本体へ配る（常時）:
// Roslyn analyzer（Assets/Analyzers/。Unity は Assets 配下の RoslynAnalyzer ラベル付き DLL だけを
// csc へ渡すので置き場所が動作条件そのもの）と、プロジェクト整合性を見る GitHub Actions（.github/）。
// Unity 操作の手段は Unity CLI に固定。配備先に OBSOLETE_PATHS のファイルがあれば取り除く。
// 冪等（再実行安全）。
//
// 使い方: node apply.mjs [target-dir] [--architecture] [--app-root=<パス>]
//                          [--review-target | --no-review-target]
//         (target-dir 省略時は cwd)
//
// 依存なし（Node 標準のみ / Node 16.7+ の fs.cpSync を使用）。
// 例外は unity の呼び出し 1 箇所（公式 unity-cli skill を配備先へ入れる。失敗しても続行する）。

import { spawnSync } from "node:child_process";
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
// Unity CLI の使い方は公式 unity-cli skill が持つので、こちらは rules を持たない
// （方針の 2 行だけ CLAUDE.md にある）。残っていると古い基準で動き、常時コンテキストにも二重に載る。
const OBSOLETE_PATHS = [
  "rules/unity-cli.md",
  "rules/unity-mcp.md",
  "rules/unity-mcp-tools.md",
  "rules/testing.md",
  "rules/dev-flow.md",
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
const KNOWN_FLAGS = new Set(["--architecture", "--review-target", "--no-review-target"]);
// 値を取るフラグ（`--name=value` 形式のみ受ける）。
const KNOWN_VALUE_FLAGS = new Set(["--app-root"]);
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
const unknownFlags = args.filter(
  (a) => a.startsWith("--") && !KNOWN_FLAGS.has(a) && !KNOWN_VALUE_FLAGS.has(a.split("=")[0])
);
if (unknownFlags.length) {
  console.error(
    `不明なオプション: ${unknownFlags.join(" ")}（使用可能: --architecture / --app-root=<パス> / --review-target / --no-review-target）`
  );
  process.exit(1);
}
let useArchitecture = args.includes("--architecture");
// レビュー対象フォルダの宣言。両立しない 2 つを同時に渡されたら黙って片方を採らずに落とす
// （どちらが勝ったか分からないまま review-config.json が書き換わるのを避ける）。
const wantsReviewTarget = args.includes("--review-target");
const dropsReviewTarget = args.includes("--no-review-target");
if (wantsReviewTarget && dropsReviewTarget) {
  console.error("--review-target と --no-review-target は同時に指定できません。");
  process.exit(1);
}

// アプリ本体の置き場。規約（folder-structure / lint-unity / analyzer）の適用範囲そのもので、
// テンプレートの `{{APP_ROOT}}` へ差し込む唯一の値。既定は Assets/App/。
//
// Unity がコンパイルへ載せるのは Assets/ と Packages/ の下だけで、規約が対象にするのは前者。
// analyzer 側のマーカー探索も Assets/ セグメントを起点にするため、ここで Assets/ 配下に限る
// （外すと analyzer だけ黙って既定へ倒れ、lint と食い違う）。
const APP_ROOT_TOKEN = "{{APP_ROOT}}";
const DEFAULT_APP_ROOT = "Assets/App/";
const appRootArg = args.find((a) => a.split("=")[0] === "--app-root");
const appRoot = normalizeAppRoot(appRootArg ? appRootArg.slice("--app-root=".length) : DEFAULT_APP_ROOT);

function normalizeAppRoot(raw) {
  const t = String(raw).replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "").trim();
  if (!t) {
    console.error("--app-root に空のパスは指定できません。");
    process.exit(1);
  }
  if (!/^Assets(\/|$)/i.test(t)) {
    console.error(`--app-root は Assets/ 配下を指定してください（指定値: ${t}）。`);
    console.error("  Unity がコンパイルへ載せるのは Assets/ と Packages/ の下だけで、規約が対象にするのは前者です。");
    process.exit(1);
  }
  return `${t}/`;
}
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

// テンプレートは `{{APP_ROOT}}` を埋め込んだ形で持ち、配置の直後に実値へ差し替える。
// 配備先ごとの値をテンプレ本体へ焼き込まないための一手（値を持つのは --app-root だけ）。
// **rules の突き合わせより前に**やること。置換前の内容と現物を比べると、置き場を変えた
// 配備先が毎回「要マージ」になる。
substituteInTree(claudeDir);

/** ディレクトリ配下の Markdown と txt の `{{APP_ROOT}}` を実値へ置き換える。 */
function substituteInTree(dir) {
  for (const f of walk(dir)) {
    if (!/\.(md|txt)$/i.test(f)) continue;
    const before = readFileSync(f, "utf8");
    if (!before.includes(APP_ROOT_TOKEN)) continue;
    writeFileSync(f, substituteAppRoot(before), "utf8");
  }
}

function substituteAppRoot(text) {
  return text.split(APP_ROOT_TOKEN).join(appRoot);
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
const claudeMdPath = join(claudeDir, "CLAUDE.md");
const claudeMdSrc = join(here, "templates", "claude-md.md");
const claudeMdSection = substituteAppRoot(readFileSync(claudeMdSrc, "utf8"));

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
  // 置換前のテンプレを渡すと、統合する Claude が `{{APP_ROOT}}` をそのまま書き写す。
  needsMerge.push({
    label: ".claude/CLAUDE.md",
    dst: claudeMdPath,
    src: stageTemplate("claude-md.md", claudeMdSection),
  });
  claudeMdState = "要マージ";
}

// ---- 公式 unity-cli skill の導入（CLI 自身が配るリファレンス） ----
// CLI の詳細（コマンド一覧・フラグ・exit code・ログの場所・Safe Mode の復旧）は
// **我々が写さない**。CLI バイナリに埋め込まれた版を `--local` で配備先へ入れる。
// **グローバル（~/.claude/skills/）には入れない** — 配備先ごとに CLI の版が違いうる。
//
// **版を状態ファイルへ記録し、CLI と食い違ったときだけ入れ直す。** skill の中身は
// 「撃ったマシンの CLI」に従うので、記録が無いと、古い CLI のマシンがテンプレ同期を
// 走らせたときに skill が古い版へ**黙って**戻る。記録を git に乗せると、その巻き戻りが
// 同期 PR の差分として見えるので、人のレビューで止められる。
//
// CLI 本体はここで入れない（マシン単位の話で、SKILL.md の Step 2.6 が担う）。
// 失敗しても導入は止めない（CLI 未導入の環境でも配置は決定的に完了させる）。
function unityCliVersion() {
  const res = spawnSync("unity", ["--version"], { encoding: "utf8", timeout: 30000 });
  if (res.error || res.status !== 0) return null;
  return (res.stdout ?? "").trim().split(/\r?\n/)[0] || null;
}

function installUnityCliSkill(cliVersion, recordedCli) {
  const skillMd = join(claudeDir, "skills", "unity-cli", "SKILL.md");
  if (existsSync(skillMd) && cliVersion && recordedCli === cliVersion) {
    return `導入済み（CLI ${cliVersion} と一致）`;
  }
  if (existsSync(skillMd) && !cliVersion) {
    return "導入済み（unity コマンドが無いため版を照合できません）";
  }
  const res = spawnSync("unity", ["skill", "install", "claude-code", "--local", "--yes"], {
    cwd: target,
    encoding: "utf8",
    timeout: 120000,
  });
  if (res.error) {
    return res.error.code === "ENOENT"
      ? "見送りました（unity コマンドがありません。CLI 導入後に再実行すると入ります）"
      : `見送りました（${res.error.message}）`;
  }
  if (res.status !== 0) {
    // 既に別物が置かれている場合は --force が要る。奪うかはユーザーの判断なので勧めない。
    const msg = (res.stderr || res.stdout || "").trim().split(/\r?\n/).pop() ?? "";
    return `見送りました（exit ${res.status}${msg ? `: ${msg}` : ""}）`;
  }
  if (!existsSync(skillMd)) return "コマンドは成功しましたが SKILL.md が見つかりません";
  return recordedCli && recordedCli !== cliVersion
    ? `入れ直しました（記録 ${recordedCli} → CLI ${cliVersion}）`
    : `導入しました（CLI ${cliVersion}）`;
}

// 記録済みの CLI 版を先に読む（下の writeSyncState が上書きする前に）。
function readRecordedCli() {
  const p = join(claudeDir, "sync-setup-state.json");
  if (!existsSync(p)) return null;
  try {
    const obj = JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
    const v = obj?.["setup-unity"]?.unityCli;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

// ---- 公式 unity プラグインが同梱する unity-cli skill を伏せる ----
// Unity 公式プラグイン（`unity@unity-agent-plugin`）は unity-cli skill を同梱するが、
// その中身はプラグインのリリース時点で固定される。上の installUnityCliSkill が入れる
// 「このマシンの CLI が吐いた版」とは別物で、プラグイン側が古いことがある。
//
// 両者は潰し合わない。プラグイン skill は `unity:unity-cli` へ名前空間化されるので、
// `unity-cli`（配備先ローカル）と並んで**両方**モデルへ提示される。どちらを引くかは
// 決まっていないので、古い方を引いて存在しないフラグや古い手順を返す余地が残る。
//
// `skillOverrides` で名指しして伏せる。配備先の settings.json に置くので、Unity 案件
// だけで効く（他プロジェクトの設定は触らない）。
//
// **既に値があるなら上書きしない。** "on" を明示した配備先は、重複を承知で両方見たい
// という意思表示なので、こちらが黙って戻すと理由の分からない挙動になる。
const BUNDLED_CLI_SKILL = "unity:unity-cli";

function disableBundledUnityCliSkill() {
  const p = join(claudeDir, "settings.json");
  let obj = {};
  if (existsSync(p)) {
    try {
      obj = JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
    } catch {
      return "見送りました（settings.json が不正な JSON です。手で直してから再実行してください）";
    }
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
      return "見送りました（settings.json のトップレベルがオブジェクトではありません）";
    }
  }
  const overrides = obj.skillOverrides;
  if (overrides !== undefined && (typeof overrides !== "object" || overrides === null || Array.isArray(overrides))) {
    return "見送りました（settings.json の skillOverrides がオブジェクトではありません）";
  }
  const current = overrides?.[BUNDLED_CLI_SKILL];
  if (typeof current === "string") {
    return current === "off"
      ? `設定済み（${BUNDLED_CLI_SKILL}: off）`
      : `触っていません（${BUNDLED_CLI_SKILL}: ${current} が設定済み。配備先の意思とみなします）`;
  }
  obj.skillOverrides = { ...(overrides ?? {}), [BUNDLED_CLI_SKILL]: "off" };
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
  return `設定しました（${BUNDLED_CLI_SKILL}: off）`;
}

const cliVersion = unityCliVersion();
const unityCliSkillState = installUnityCliSkill(cliVersion, readRecordedCli());
const bundledCliSkillState = disableBundledUnityCliSkill();

// ---- Unity プロジェクト本体へ配るもの（.claude/ の外）----
// Roslyn analyzer は Assets 配下にあり RoslynAnalyzer ラベルの付いた DLL だけが csc へ渡るため、
// 置き場所と .meta が動作条件そのものになる。PR ゲートの workflow は .github/ へ。
// どちらもビルド成果物・配布物なので無条件に上書きする（設定ファイルは配らないので、
// 配備先が育てる余地のあるファイルはここに無い ＝ マージ判定が要らない）。
const projectStates = [];
cpSync(projectTemplate, target, { recursive: true });
// Assets/Analyzers/analyzable-root.txt が analyzer へ --app-root を届ける唯一の経路。
// .editorconfig / .globalconfig は Unity が C# コンパイラへ渡さないため使えない
// （analyzers/README.md が正本）。README.md ともども置換が要る。
substituteInTree(join(target, "Assets", "Analyzers"));
for (const f of walk(projectTemplate)) {
  projectStates.push(`${relative(projectTemplate, f).split(sep).join("/")}: 配置`);
}
projectStates.sort();

// ---- レビュー対象フォルダの宣言（setup-github が配る review-config.json へ書く）----
// 「このリポの自作コードはどこか」はプロジェクト構成を知っている側の事実なので、汎用の
// setup-github ではなくここが宣言する。読み手は 2 つ（どちらも setup-github の配布物）:
//   - .claude/hooks/lib/reviewable-files.mjs → Copilot 自動アサインの対象判定
//   - .claude/CLAUDE.md の /code-review / /security-review 指示 → コマンドの対象範囲
// ファイルが無い（= setup-github 未実行）ときは**作らない**。config だけあっても読み手が
// 居ないので効かず、あとで setup-github が「温存」と解釈して質問の既定値まで汚す。
// レビュー対象は規約の適用範囲と同じ。別々に持つと「lint は見るのにレビューは見ない」ズレが出る。
const REVIEW_TARGET = appRoot;
const reviewConfigPath = join(claudeDir, "hooks", "review-config.json");

function updateReviewTargets() {
  if (!wantsReviewTarget && !dropsReviewTarget) return "指定なし（現状のまま）";
  if (!existsSync(reviewConfigPath)) {
    return "未配置（setup-github 未実行のため書きませんでした）";
  }
  let cfg;
  try {
    const parsed = JSON.parse(readFileSync(reviewConfigPath, "utf8").replace(/^\uFEFF/, ""));
    cfg = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    cfg = null;
  }
  if (!cfg) {
    return "解析できず（不正な JSON のため書きませんでした。setup-github を再実行してください）";
  }
  const before = Array.isArray(cfg.reviewTargets) ? cfg.reviewTargets.map(String) : [];
  // 末尾スラッシュ・区切り・./ 前置のゆらぎを吸収して比較する（reviewable-files.mjs の
  // normalizeEntries と同じ規則。片方だけ直すと重複追加が起きる）。
  const norm = (t) =>
    t.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
  const kept = before.filter((t) => norm(t) !== norm(REVIEW_TARGET));
  const after = wantsReviewTarget ? [...kept, REVIEW_TARGET] : kept;
  if (before.length === after.length && before.every((t, i) => t === after[i])) {
    return `変更なし（reviewTargets: ${after.length ? after.join(" ") : "空（全フォルダ対象）"}）`;
  }
  cfg.reviewTargets = after;
  writeFileSync(reviewConfigPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  const shown = after.length ? after.join(" ") : "空（全フォルダ対象）";
  return `${wantsReviewTarget ? "追加" : "除去"}（reviewTargets: ${shown}）`;
}

const reviewTargetState = updateReviewTargets();

// 旧名の状態ファイルを正名へ畳んで消す。規則は skills/sync-setup/state.mjs が正本
// （読み手側も同じ規則で旧名を解決する。片方だけ直すと配備先が黙って同期対象外になる）。
const migratedState = consolidateSyncState(claudeDir);
if (migratedState) console.log(`状態ファイル: ${migratedState}`);

// ---- 状態ファイル sync-setup-state.json への setup-unity キーの記録 ----
// このスキルが settings.json へ書くのは skillOverrides の 1 キーだけで、hook は配らない。同期チェック hook は
// setup-github が配る単一の sync-setup-check.mjs が担い、この状態ファイルの全キー（setup-github /
// setup-unity）を現行の skill 版と比較する。ここでは自分のキー（適用時の skill 版と有効フラグ）
// だけをマージ更新し、setup-github のキーや未知フィールドは温存する。ヘルパーはこのファイルに閉じる
// （スキル単体コピーで動くよう外部モジュールに依存しない ＝ upsertWorkflowSection と同方針）。
let syncState = null;
const skillVersion = readOwnSkillVersion();
if (skillVersion) {
  const syncFlags = [];
  if (useArchitecture) syncFlags.push("--architecture");
  // 既定と同じ値は書かない。既定を変えたときに、保存フラグが古い既定へ固定するのを避ける。
  if (appRoot !== DEFAULT_APP_ROOT) syncFlags.push(`--app-root=${appRoot}`);
  // レビュー対象の宣言は「触らない」も状態なので、指定があったときだけ記録する。
  // 記録しないと次のテンプレ同期が無指定で走り、配備先の設定は温存される（＝現状維持）。
  if (wantsReviewTarget) syncFlags.push("--review-target");
  else if (dropsReviewTarget) syncFlags.push("--no-review-target");
  writeSyncState("setup-unity", skillVersion, syncFlags, cliVersion);
  syncState = `setup-unity v${skillVersion}（flags: ${syncFlags.join(" ") || "なし"}）`;
} else {
  console.log(
    "注意: SKILL.md の version を読めなかったため sync-setup-state.json を書きませんでした（テンプレ自動追随は無効のまま）。"
  );
}

// このスキル自身の版を読む（同じディレクトリの `SKILL.md` の frontmatter `version:`）。
// **プラグイン全体の版ではない。** プラグイン版は marketplace の更新トリガーであって
// 「どの skill が変わったか」を表さないため、これで判定すると他スキルの更新でも
// 配備先が drift 扱いになる。本文の `version:` 行を拾わないよう frontmatter だけを見る。
// 読めなければ null（＝状態ファイルを書かない＝自動追随は無効のまま）。
function readOwnSkillVersion() {
  try {
    const src = readFileSync(join(here, "SKILL.md"), "utf8").replace(/^\uFEFF/, "");
    const fm = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) return null;
    const m = fm[1].match(/^version:[ \t]*["']?(\d+(?:\.\d+){0,2})["']?[ \t]*$/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// 状態ファイル `.claude/sync-setup-state.json` へ自分のキー（skillKey）をマージ更新する。相手のキーや
// 未知フィールドは消さない（読み → 該当キーだけ差し替え → 書き戻し）。
//
// 記録するのは skill 版だけ。プラグイン版は書かない（同期コミットの subject が git 履歴に残す）。
// 旧配備先に残る `version`（プラグイン版）は読み手のフォールバックが読み、初回同期で置き換わる。
function writeSyncState(skillKey, skillVersion, flags, unityCli) {
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
  // unityCli は「配布した unity-cli skill がどの CLI 版から出たか」。unity が無い環境では
  // 既存の記録を消さない（消すと次の適用が版の食い違いを検出できなくなる）。
  const prevCli = obj[skillKey]?.unityCli;
  const cli = unityCli ?? (typeof prevCli === "string" ? prevCli : undefined);
  obj[skillKey] = cli ? { skillVersion, flags, unityCli: cli } : { skillVersion, flags };
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

console.log(`インストール先: ${claudeDir}`);
console.log(`モード: ${useArchitecture ? "architecture（レイヤードアーキテクチャ規約込み）" : "base（アーキテクチャ規約なし）"}`);
if (architectureInherited) {
  console.log("注意: 導入済みの architecture 規約を検出したため、--architecture 指定なしでも architecture モードで適用しました（巻き戻り防止）。");
}
console.log(`アプリ本体の置き場（--app-root）: ${appRoot}${appRoot === DEFAULT_APP_ROOT ? "（既定）" : ""}`);
console.log(`レビュー対象フォルダ（review-config.json の reviewTargets）: ${reviewTargetState}`);
console.log("Unity 操作: Unity CLI（方針は CLAUDE.md、使い方は unity-cli skill）");
console.log(`公式 unity-cli skill: ${unityCliSkillState}`);
console.log(`公式プラグイン同梱の ${BUNDLED_CLI_SKILL}: ${bundledCliSkillState}`);
if (droppedFlags.length) {
  console.log(`注意: 廃止したオプションを無視しました: ${droppedFlags.join(" / ")}`);
  console.log(
    "  Unity 操作は Unity CLI に固定、analyzer は常時配置・severity は Warning 固定です" +
      "（PR の gate は .github/workflows/unity-ci.yml が担います）。"
  );
}
if (removedLegacy.length) {
  console.log("取り除いたファイル（現行の手順と二重になるため）:");
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
// 展開範囲外を「無い」と読まない。テンプレ同期は sparse-checkout の worktree の中で apply を
// 走らせる（Unity リポを全展開すると Windows の MAX_PATH に当たるため）。その worktree に
// アプリ本体のフォルダは無いので、この検査は**必ず**「存在しません」と言う。sync-run はこの注意行を
// PR 本文へ転記するので、毎回の同期 PR が嘘を載せることになる（警告を無視する習慣がつく）。
//
// 展開範囲は sync-run.mjs が決めるので、部分展開かどうかも呼び手しか知らない。
// フラグではなく環境変数で受け取る: これは「その実行の性質」であって、状態ファイルへ保存して
// 再現すべき構成ではない（保存フラグに混ざると、次の適用が理由もなく検査を飛ばす）。
if (process.env.SYNC_SETUP_SPARSE_WORKTREE === "1") {
  console.log(`注意: 作業ツリーが部分展開のため、${appRoot} の存在確認は省略しました。`);
} else if (!existsSync(join(target, ...appRoot.replace(/\/$/, "").split("/")))) {
  console.log(`注意: ${appRoot} が存在しません。規約はアプリ本体を ${appRoot} 配下に置く前提です。`);
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
