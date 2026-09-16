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
// 外部コマンドは 1 つ。失敗しても続行する（配置は決定的に完了させる）:
//   git — 公式 unity プラグイン（skills / commands / agents）を上流から引いて配備先へ入れる

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { consolidateSyncState } from "../sync-setup/state.mjs";
import { pinnedUnityPluginSha } from "../sync-setup/skill-version.mjs";
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

// 前回の記録を先に読む（下の writeSyncState が上書きする前に）。
// 返すのは setup-unity キー全体。何を入れ直すかの判定は読み手ごとに違う
// （CLI 版は文字列比較、プラグインは sha と skill 名の集合）ので、ここでは解釈しない。
function readRecorded() {
  const p = join(claudeDir, "sync-setup-state.json");
  if (!existsSync(p)) return {};
  try {
    const obj = JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
    const v = obj?.["setup-unity"];
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// ---- 公式 unity プラグインを配備先へ入れる ----
// Unity 公式プラグイン（`Unity-Technologies/unity-agent-plugin`）を **プラグイン機構を通さず
// 直接置く**。
//
// プラグインとして入れると、実体は宣言したプロジェクトではなく `~/.claude/plugins/cache/` へ
// コピーされ、そこから読まれる。配備先のリポジトリに置いても同じで、キャッシュを経由しない
// 経路が無い。個人マシンへ実体を残さず、リポジトリの現物をそのまま読ませるには直置きしかない。
//
// **project-setup 側にコピーを持たない。** テンプレートへ写すと Unity 側の更新がこちらの
// 手作業でしか届かなくなる（＝黙って古くなる）。適用のたびに上流を clone して、その sha を
// 状態ファイルへ記録する。記録との食い違いだけが入れ直しの条件になる。
//
// **unity-cli も上流の版をそのまま配る。** `unity skill install` で CLI バイナリ埋め込み版を
// 入れる経路は持たない。実測（CLI 1.0.0-beta.9）で CLI 埋め込み版の CHANGELOG は beta.8 止まり、
// 上流は beta.9 まで載せていて references も 1 本多く、**上流の方が新しかった**。加えて CLI 経由は
// 「同期を回した人のマシンの CLI 版」が配布物になるため、配備先の中身がマシンごとに揺れる。
//
// **どの sha を配るかは、このマシンに登録済みの marketplace が pin した値に従う**（無ければ
// 上流 HEAD）。sync-setup と同じく「記録 ↔ ローカルの現行値」の比較で更新を検出できる形にする
// ため、配る側も同じ値を見る必要がある。HEAD を配ると pin と永久にズレて毎回 drift になる。
//
// 再配布なので LICENSE.md も一緒に置く。
// 上流の差し替え口。**テスト専用**（本物の上流に hooks/ が生えるのを待たずに検出を検証する）。
// 配備先の運用では設定しない。
const UNITY_PLUGIN_REPO =
  process.env.SETUP_UNITY_PLUGIN_REPO || "https://github.com/Unity-Technologies/unity-agent-plugin.git";
const UNITY_PLUGIN_LICENSE = "UNITY-AGENT-PLUGIN-LICENSE.md";
// marketplace の pin を読めたか。読めないマシンでは上流の更新を検出できない（報告で使う）。
let unpinnedWarning = false;

// 上流トップ階層の扱い。プラグインローダーは**ディレクトリ名の規約**で構成要素を拾う
// （plugin.json に宣言は要らない。Codex プラグインが skills / commands / agents / hooks を
// 宣言なしで持つことで確認済み）。よってここも名前で振り分ける。
//
// **ここに無い名前が上流に現れたら報告する。** 黙って無視すると、上流が構成要素を足した更新が
// 「入ったつもりで入っていない」状態になる — エラーも差分も出ないので誰も気づけない。
//
// 配る先は `.claude/<kind>/`。各エントリを丸ごと（`references/` `resources/` `scripts/` ごと）写す。
const PLUGIN_COPY_DIRS = { skills: "SKILL.md", commands: null, agents: null };
// 配備先では何もしないもの。manifest はプラグイン機構が読むもので、直置きでは読み手が居ない。
const PLUGIN_INERT = new Set([
  ".git",
  ".github",
  ".claude-plugin",
  ".agents",
  ".codex-plugin",
  "assets",
  "README.md",
  "LICENSE.md",
]);
// 直置きでは**再現できない**構成要素。hook は `${CLAUDE_PLUGIN_ROOT}` を使い settings.json への
// 登録も要る。MCP も同様。見つけたら配らずに名指しで報告する（黙って落とすと危険な差が出る）。
const PLUGIN_UNSUPPORTED = new Set(["hooks", ".mcp.json"]);

function installUnityPlugin(recorded) {
  const prevPlaced = recorded?.placed && typeof recorded.placed === "object" ? recorded.placed : {};
  const prevOf = (kind) => (Array.isArray(prevPlaced[kind]) ? prevPlaced[kind].map(String) : []);
  const skip = (state) => ({ state, record: recorded, unsupported: [], unknown: [], collided: [] });

  const tmp = mkdtempSync(join(tmpdir(), "unity-plugin-"));
  try {
    const clone = spawnSync(
      "git",
      ["clone", "--depth", "1", "--quiet", UNITY_PLUGIN_REPO, tmp],
      { encoding: "utf8", timeout: 180000 }
    );
    if (clone.error) {
      return skip(
        clone.error.code === "ENOENT" ? "見送りました（git がありません）" : `見送りました（${clone.error.message}）`
      );
    }
    if (clone.status !== 0) {
      const msg = (clone.stderr || clone.stdout || "").trim().split(/\r?\n/).pop() ?? "";
      return skip(`見送りました（clone 失敗 exit ${clone.status}${msg ? `: ${msg}` : ""}）`);
    }

    // marketplace が pin した sha があればそこへ移す。--depth 1 の clone には HEAD しか無いので
    // 個別に fetch する。失敗したら HEAD のまま続ける（配置は決定的に完了させる）。
    const pinned = pinnedUnityPluginSha();
    let pinState = pinned ? "" : "（marketplace の pin が読めないため HEAD）";
    if (pinned) {
      const fetched =
        spawnSync("git", ["-C", tmp, "fetch", "--depth", "1", "origin", pinned], {
          encoding: "utf8",
          timeout: 180000,
        }).status === 0 &&
        spawnSync("git", ["-C", tmp, "checkout", "--quiet", pinned], { encoding: "utf8", timeout: 60000 })
          .status === 0;
      if (!fetched) pinState = `（pin ${pinned.slice(0, 7)} を取得できないため HEAD）`;
    }
    // pin が読めないマシンは、**上流の更新を検出する手立ても無い**（ドリフト検知が比べる
    // 「現行値」がそこに無い）。配置は HEAD で続けるが、このマシンでは自動追随が効かない。
    if (!pinned) unpinnedWarning = true;

    const head = spawnSync("git", ["-C", tmp, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 30000 });
    const sha = head.status === 0 ? (head.stdout ?? "").trim() : null;
    if (!sha) return skip("見送りました（sha を読めませんでした）");

    // 上流の構成を仕分ける。未知と非対応はここで拾い、呼び出し元が報告する。
    const top = readdirSync(tmp);
    const unsupported = top.filter((n) => PLUGIN_UNSUPPORTED.has(n)).sort();
    const unknown = top
      .filter((n) => !PLUGIN_INERT.has(n) && !PLUGIN_UNSUPPORTED.has(n) && !(n in PLUGIN_COPY_DIRS))
      .sort();

    // 配る対象を集める。marker が要るのは skills だけ（SKILL.md を持たないディレクトリは skill でない）。
    //
    // **自前の配布物と名前がぶつかったら上流を配らない。** 上流の agent / command / skill が
    // unity-worker や lint-unity と同名になると、黙って潰して別物へ差し替わる。どちらを採るかは
    // 人の判断なので、ここでは触らずに名指しで報告する。`copied` は今回配ったファイルの相対パス。
    const collided = [];
    const wanted = {};
    for (const [kind, marker] of Object.entries(PLUGIN_COPY_DIRS)) {
      const src = join(tmp, kind);
      if (!existsSync(src) || !statSync(src).isDirectory()) continue;
      const names = [];
      for (const n of readdirSync(src).sort()) {
        if (marker && !existsSync(join(src, n, marker))) continue;
        // 自前の配布物は skills/<name>/SKILL.md、agents/<name>.md の形で copied に載る。
        if (copied.has(`${kind}/${n}`) || copied.has(`${kind}/${n}/${marker ?? "SKILL.md"}`)) {
          collided.push(`${kind}/${n}`);
          continue;
        }
        names.push(n);
      }
      if (names.length) wanted[kind] = names;
    }
    if (!wanted.skills) {
      return skip("見送りました（上流に配れる skills/ がありません。構成が変わった可能性があります）");
    }

    // 記録と一致し、現物も揃っているなら触らない。
    const unchanged =
      recorded?.sha === sha &&
      Object.keys(wanted).length === Object.keys(prevPlaced).length &&
      Object.entries(wanted).every(([kind, names]) => {
        const prev = prevOf(kind);
        return (
          prev.length === names.length &&
          prev.every((n) => names.includes(n) && existsSync(join(claudeDir, kind, n)))
        );
      });
    if (unchanged) {
      const counts = Object.entries(wanted).map(([kind, n]) => `${n.length} ${kind}`);
      return {
        state: `導入済み（${counts.join(" / ")} / ${sha.slice(0, 7)} と一致）${pinState}`,
        record: { sha, placed: wanted },
        unsupported,
        unknown,
        collided,
      };
    }

    for (const [kind, names] of Object.entries(wanted)) {
      const dstDir = join(claudeDir, kind);
      mkdirSync(dstDir, { recursive: true });
      for (const n of names) {
        const dst = join(dstDir, n);
        rmSync(dst, { recursive: true, force: true });
        cpSync(join(tmp, kind, n), dst, { recursive: true });
      }
    }
    // 再配布にはライセンス表記が付いて回る。skills/ と同じ場所に置き、配った skill と一緒に
    // 増減させる（skill を全部消した配備先にライセンスだけ残しても意味がない）。
    const licenseSrc = join(tmp, "LICENSE.md");
    if (existsSync(licenseSrc)) cpSync(licenseSrc, join(claudeDir, "skills", UNITY_PLUGIN_LICENSE));

    // 上流から消えたものを配備先からも消す。**前回配った記録にあるものだけ**を対象にする
    // （lint-unity / unity-parallel / unity-linter などは別経路の配布物なので触ってはいけない）。
    const dropped = [];
    for (const kind of new Set([...Object.keys(prevPlaced), ...Object.keys(wanted)])) {
      const names = wanted[kind] ?? [];
      for (const n of prevOf(kind)) {
        if (names.includes(n)) continue;
        const p = join(claudeDir, kind, n);
        if (!existsSync(p)) continue;
        try {
          rmSync(p, { recursive: true });
          dropped.push(`${kind}/${n}`);
        } catch (e) {
          console.log(`注意: 上流から消えた配布物を削除できませんでした（手で消してください）: .claude/${kind}/${n} — ${e.message}`);
        }
      }
    }

    const prefix = recorded?.sha
      ? `入れ直しました（記録 ${String(recorded.sha).slice(0, 7)} → ${sha.slice(0, 7)}）`
      : `導入しました（${sha.slice(0, 7)}）`;
    const counts = Object.entries(wanted).map(([kind, n]) => `${n.length} ${kind}`);
    const suffix = dropped.length ? `。上流から消えた ${dropped.length} 件を削除: ${dropped.join(" ")}` : "";
    return {
      state: `${prefix}: ${counts.join(" / ")}${suffix}${pinState}`,
      record: { sha, placed: wanted },
      unsupported,
      unknown,
      collided,
    };
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // 一時ディレクトリが残るだけなので握りつぶす
    }
  }
}

// ---- プラグインとして入っている同名 skill を伏せる ----
// 上の installUnityPlugin は skills を `.claude/skills/` へ直接置く。同じプラグインを
// マーケットプレース経由で user スコープに入れているマシンでは、`unity:<name>` へ名前空間化
// された同じ skill が並んで**両方**モデルへ提示される。どちらを引くかは決まっていない。
//
// 潰し合わないので、名指しで伏せる。伏せる名前は**配った skill から導出する**ので、上流の
// 増減に自動で追随する（手で維持する一覧を持たない）。
//
// **既に値があるなら上書きしない。** "on" を明示した配備先は、重複を承知で両方見たいという
// 意思表示なので、こちらが黙って戻すと理由の分からない挙動になる。
//
// **上流から消えた skill の "off" は取り下げる。** 残すと、存在しない skill を名指しする行が
// settings.json に溜まり続ける（消えたことは誰も検出できない）。取り下げるのは値が "off" の
// ものだけ — 別の値が入っているなら配備先の意思なので触らない。
const PLUGIN_NAMESPACE = "unity";

function disablePluginSkills(names, prevNames) {
  const wanted = [...new Set(names)].sort();
  const stale = prevNames.filter((n) => !wanted.includes(n));
  if (wanted.length === 0 && stale.length === 0) return "対象なし";
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
  const next = { ...(overrides ?? {}) };
  const added = [];
  const kept = [];
  const pruned = [];
  for (const n of stale) {
    const key = `${PLUGIN_NAMESPACE}:${n}`;
    if (next[key] !== "off") continue;
    delete next[key];
    pruned.push(key);
  }
  for (const n of wanted) {
    const key = `${PLUGIN_NAMESPACE}:${n}`;
    const current = next[key];
    if (typeof current === "string") {
      if (current !== "off") kept.push(`${key}: ${current}`);
      continue;
    }
    next[key] = "off";
    added.push(key);
  }
  if (added.length || pruned.length) {
    obj.skillOverrides = next;
    writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
  }
  const parts = [];
  parts.push(added.length ? `${added.length} 件を off にしました` : `変更なし（${wanted.length} 件は設定済み）`);
  if (pruned.length) parts.push(`上流から消えた ${pruned.length} 件の off を取り下げ: ${pruned.join(" ")}`);
  if (kept.length) parts.push(`触っていません: ${kept.join(" / ")}（配備先の意思とみなします）`);
  return parts.join("。");
}

const recorded = readRecorded();
const unityPlugin = installUnityPlugin(recorded.unityPlugin);
// 伏せる対象は「実際に配った skill」から導出するので、配置の後に呼ぶ。
// skillOverrides が効くのは skill だけ（command / agent は別の名前空間）。
const pluginOverridesState = disablePluginSkills(
  unityPlugin.record?.placed?.skills ?? [],
  Array.isArray(recorded.unityPlugin?.placed?.skills) ? recorded.unityPlugin.placed.skills.map(String) : []
);

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
  writeSyncState("setup-unity", { skillVersion, flags: syncFlags, unityPlugin: unityPlugin.record });
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
function writeSyncState(skillKey, { skillVersion, flags, unityPlugin }) {
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
  // unityPlugin は「上流プラグインをどの sha から、どの名前で配ったか」。ドリフト検知の
  // 比較対象そのもの。clone できなかった環境では既存の記録を消さない（消すとその配備先が
  // 以後の更新を検出できなくなる）。旧配備先に残る `unityCli` はここで落とす（CLI 経由の
  // 配布をやめたので読み手が居ない）。
  const prevPlugin = obj[skillKey]?.unityPlugin;
  const plugin = unityPlugin ?? (prevPlugin && typeof prevPlugin === "object" ? prevPlugin : undefined);
  obj[skillKey] = { skillVersion, flags };
  if (plugin) obj[skillKey].unityPlugin = plugin;
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
console.log(`公式 unity プラグイン: ${unityPlugin.state}`);
console.log(`プラグイン版の同名 skill（skillOverrides）: ${pluginOverridesState}`);
// 直置きでは再現できない／扱いを決めていない構成要素。**黙って落とさない** — 上流が構成要素を
// 足した更新は、報告しない限り「入ったつもりで入っていない」状態のまま誰にも気づかれない。
if (unityPlugin.unsupported?.length) {
  console.log(
    `警告: 上流に直置きでは再現できない構成要素があります（配っていません）: ${unityPlugin.unsupported.join(" ")}`
  );
  console.log(
    "  hook は ${CLAUDE_PLUGIN_ROOT} の解決と settings.json への登録が要り、MCP も同様です。" +
      "プラグインとして入れるか、setup-unity 側で明示的に対応するか決めてください。"
  );
}
if (unityPlugin.unknown?.length) {
  console.log(`警告: 上流に扱いを決めていない要素があります（配っていません）: ${unityPlugin.unknown.join(" ")}`);
  console.log("  setup-unity の PLUGIN_COPY_DIRS / PLUGIN_INERT / PLUGIN_UNSUPPORTED に足してください。");
}
if (unpinnedWarning) {
  console.log("警告: 公式 unity プラグインを pin している marketplace が見つかりません（上流 HEAD を配りました）。");
  console.log(
    "  このマシンでは上流の更新を検出できません（比べる現行値がローカルに無いため）。" +
      "`claude plugin marketplace add anthropics/claude-plugins-official` を撃つと検出が効きます。"
  );
}
if (unityPlugin.collided?.length) {
  console.log(
    `警告: 上流の配布物が setup-unity 自前のものと同名です（上流側を配っていません）: ${unityPlugin.collided.join(" ")}`
  );
  console.log("  どちらを採るかは人の判断です。上流を採るなら setup-unity 側の配布をやめてください。");
}
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
