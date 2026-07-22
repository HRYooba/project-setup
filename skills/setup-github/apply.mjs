// setup-github インストーラ本体。
//
// 対象プロジェクトに GitHub 開発フロー一式を撒く。冪等（再実行安全）。
//
//   base（常時。ただし pre-push は既定 ON で --no-pre-push で外せる）:
//     - .githooks/pre-push（保護ブランチへの直 push 拒否。全ツール対象・実行時にブランチ検出。
//       既定 ON。--no-pre-push で opt-out。配備済みの場合は削除して選択を貫徹し、撒く githook が
//       他に無ければ core.hooksPath も解除する）
//     - .claude/hooks/pr-code-review-gate.mjs（PR 作成前 gate。ファイルは配るが settings.json
//       からは登録解除して休眠させる。手動再登録で再有効化可。CR_GATE_DISABLE=1 で無効化可）
//     - .claude/hooks/code-review-effort-nudge.mjs（同上・休眠。code-review がユーザー手打ち
//       専用になり Claude 発の起動を前提にした nudge は発火しないため）
//     - .claude/rules/git-conventions.md（templates/base/rules の同梱スナップショットをコピー）
//     - .claude/skills/create-issue/（templates/base/skills の同梱スナップショットをコピー）
//     - .claude/CLAUDE.md へブランチ規約と PR 前レビュー運用（/simplify + /security-review の
//       ソフト運用。強制はしない）を追記
//     - .claude/settings.json へ hooksPath 自動設定(SessionStart) とテンプレ追随(SessionStart)を
//       登録し、旧版が撒いた gate/nudge(PreToolUse) を登録解除する
//     - 実行者の clone へ core.hooksPath を即時設定 + pre-push へ exec bit 付与（mac/linux 対策）
//
//   --pr-copilot（任意）:
//     - Copilot 自動アサイン hook / watch-pr / resolve-pr / review-responder
//     - AGENTS.md 自動生成（.githooks/generate-agents-md.mjs + .githooks/pre-commit。
//       マーカー付き .claude/rules/*.md を連結して Copilot code review に規約を教える。
//       生成スクリプトは Claude hook ではないため .claude/hooks/ ではなく .githooks/ に置く）
//     - .github/workflows/agents-md-sync.yml（AGENTS.md 乖離の CI ガード。--no-verify や
//       Web UI 編集などローカル pre-commit が効かない経路のドリフトを PR で検出）
//     - .claude/settings.json へ PostToolUse(Bash) を登録
//     - （旧版が CLAUDE.md へ撒いた「## PR レビュー」節は再実行時に除去する。watch-pr の
//       起動トリガーは after-pr-create.mjs の additionalContext に一本化）
//
// 使い方: node apply.mjs [target-dir] [--pr-copilot] [--no-pre-push] [--review-targets=src,shared]
//         [--review-excludes=.claude,.github]
//   (target-dir 省略時は cwd)
//   --pr-copilot: PR 自動レビュー一式を入れる。省略しても配備済み（after-pr-create.mjs が
//     ある）なら自動継承する（base のみ再実行で pr-copilot が黙って剥がれる巻き戻りを防ぐ）。
//   --no-pre-push: ブランチ保護 pre-push を入れない（既定は入れる）。配備済みなら削除する。
//     自動継承はしない（既定 ON なのでフラグ無し再実行で入り直す。opt-out の維持は sync-state の
//     記録フラグ経由で無人再適用へ引き継がれる）。
//   --review-targets: レビュー対象フォルダ（カンマ区切り）。配備先の
//     .claude/hooks/review-config.json へ書き込む（reviewable-files.mjs がこれを読む）。
//     ここに無いフォルダのコードは gate・Copilot アサインとも対象外（ベンダーコード導入
//     PR の素通し用）。優先順位: 明示指定 > 配備済み config の温存 > 旧版 lib からの移行
//     > 空＝全フォルダ対象。`--review-targets=`（空値）で明示的に全フォルダ対象へ戻せる。
//   --review-excludes: レビュー除外フォルダ（カンマ区切り）。同じく review-config.json へ。
//     REVIEW_TARGETS より優先して常に対象外。デフォルトは .claude/.github/.githooks
//     （ツール設定系。setup-github の導入 PR を素通しするため）。優先順位: 明示指定 >
//     配備済み config の温存 > 旧版 lib からの移行 > デフォルト。
//     `--review-excludes=`（空値）で明示的に除外なしへ戻せる。
// 依存なし（Node 標準のみ / Node 16.7+ の fs.cpSync を使用）。このスキル 1 ディレクトリで
// 完結する（外部モジュールを import しない＝単体コピーで動く）。

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
/* global process, console */

const here = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(here, "templates");

const args = process.argv.slice(2);
const KNOWN_FLAGS = new Set(["--pr-copilot", "--no-pre-push"]);
const unknownFlags = args.filter(
  (a) =>
    a.startsWith("--") &&
    !KNOWN_FLAGS.has(a) &&
    !a.startsWith("--review-targets=") &&
    !a.startsWith("--review-excludes=")
);
if (unknownFlags.length) {
  console.error(
    `不明なオプション: ${unknownFlags.join(" ")}（使用可能: --pr-copilot / --no-pre-push / --review-targets=<csv> / --review-excludes=<csv>）`
  );
  process.exit(1);
}
// ブランチ保護 pre-push は既定 ON。--no-pre-push で opt-out する（配備済みなら削除して選択を貫徹）。
// pr-copilot と違い自動継承はしない（既定 ON なのでフラグ無し再実行で常に入り直す。opt-out を
// 維持したいときは sync-state に記録された --no-pre-push が無人再適用へ引き継がれる）。
const prePush = !args.includes("--no-pre-push");
// pr-copilot は明示指定 or 配備済み（after-pr-create.mjs がある）なら自動継承する。
// base のみで再実行すると lib だけ最新化され、それを import する pr-copilot hook が
// 旧版のまま残ってバージョンスキュー（import エラー等）を起こすため、剥がさない。
const target = args.find((a) => !a.startsWith("--")) ?? process.cwd();
const claudeDir = join(target, ".claude");
const prCopilotDeployed = existsSync(join(claudeDir, "hooks", "after-pr-create.mjs"));
const prCopilotInherited = !args.includes("--pr-copilot") && prCopilotDeployed;
const prCopilot = args.includes("--pr-copilot") || prCopilotDeployed;

// レビュー対象フォルダ。ルート相対プレフィックスへ正規化（区切りは / ・末尾 / 付き）。
// 配備先 config への入力を整える用途。lib 側 normalizeEntries も読み込み時に同じ正規化を
// かける（防御の二重化。層が違う＝入力サニタイズと実行時防御なので重複を許容する）。
function normTarget(s) {
  const t = String(s)
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  return t ? `${t}/` : "";
}
const rtArg = args.find((a) => a.startsWith("--review-targets="));
const reviewTargets = rtArg
  ? rtArg.slice("--review-targets=".length).split(",").map(normTarget).filter(Boolean)
  : [];
const rxArg = args.find((a) => a.startsWith("--review-excludes="));
const reviewExcludes = rxArg
  ? rxArg.slice("--review-excludes=".length).split(",").map(normTarget).filter(Boolean)
  : null; // null = 指定なし（温存 or デフォルトに任せる）

if (!existsSync(join(templatesDir, "base"))) {
  console.error(`テンプレートが見つかりません: ${join(templatesDir, "base")}`);
  process.exit(1);
}

const copied = [];
const removed = [];
const warnings = [];

// git をシェル非経由で実行。失敗時は null。
function git(...a) {
  try {
    return execFileSync("git", ["-C", target, ...a], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

// このプラグインの現行版を読む（`.claude-plugin/plugin.json`）。apply.mjs は
// skills/setup-github/ にあるので plugin root は 2 つ上。cache 版（.../<version>/skills/...）でも
// dev repo（project-setup/skills/...）でも同じ相対で当たる。読めなければ null。
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

// 状態ファイル `.claude/setup-sync-state.json` へ自分のキー（skillKey）をマージ更新する。
// setup-github / setup-unity が同じファイルに各自のキーで書くため、相手のキーや未知フィールドは
// 消さない（読み → 該当キーだけ差し替え → 書き戻し）。SessionStart hook（setup-sync-check.mjs）が
// このファイルの記録版と現行版を比較して、更新時に `/setup-sync`（sync-run.mjs）の実行を促す。
function writeSyncState(skillKey, version, flags) {
  const p = join(claudeDir, "setup-sync-state.json");
  let obj = {};
  if (existsSync(p)) {
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
      if (parsed && typeof parsed === "object") obj = parsed;
    } catch {
      warnings.push("setup-sync-state.json が不正な JSON のため作り直します（他スキルのキーは失われる可能性あり）");
    }
  }
  obj[skillKey] = { version, flags };
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

// ---- 1. base テンプレートのコピー ----
mkdirSync(claudeDir, { recursive: true });

// レビュー対象/除外フォルダは配備先の review-config.json に保存する（reviewable-files.mjs が
// これを読む）。設定を生成コードへ正規表現で注入・回収する方式は、テンプレートの宣言形式が
// 変わると温存が黙って壊れるため廃止。config は独立ファイルなので cpSync に消されず、温存＝
// そのまま読むだけで済む。
//
// 優先順位: 明示フラグ > 配備済み config の温存 > 旧版 lib からの移行 > デフォルト。
// 旧版（config 以前）の配備は lib に `export const REVIEW_TARGETS = [...]` を持つため、
// config が無いときだけ lib を scrape して 1 度だけ config へ移行する。
const configPath = join(claudeDir, "hooks", "review-config.json");
const libPath = join(claudeDir, "hooks", "lib", "reviewable-files.mjs");

// 既存 config（前回実行の保存値）。壊れていれば無視して次の候補へ。
function readDeployedConfig() {
  if (!existsSync(configPath)) return null;
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
    return {
      targets: Array.isArray(cfg.reviewTargets)
        ? cfg.reviewTargets.map(normTarget).filter(Boolean)
        : undefined,
      excludes: Array.isArray(cfg.reviewExcludes)
        ? cfg.reviewExcludes.map(normTarget).filter(Boolean)
        : undefined,
    };
  } catch {
    warnings.push("配備済み review-config.json を解析できませんでした（無視して既定/指定で上書きします）");
    return null;
  }
}

// 旧版 lib（config 以前）からの移行用 scrape。config が無いときだけ使う。
function scrapeOldLib(name) {
  if (!existsSync(libPath)) return undefined;
  const m = readFileSync(libPath, "utf8").match(new RegExp(`export const ${name} = \\[([^\\]]*)\\];`));
  if (!m) return undefined;
  try {
    return JSON.parse(`[${m[1]}]`).map(normTarget).filter(Boolean);
  } catch {
    return undefined;
  }
}

const deployedConfig = readDeployedConfig();

// targets: 指定 > config 温存 > 旧 lib 移行 > 空（全フォルダ）
let effectiveTargets;
let targetsSource;
if (rtArg !== undefined) {
  effectiveTargets = reviewTargets;
  targetsSource = "指定";
} else if (deployedConfig?.targets !== undefined) {
  effectiveTargets = deployedConfig.targets;
  targetsSource = "温存";
} else {
  const migrated = scrapeOldLib("REVIEW_TARGETS");
  if (migrated !== undefined) {
    effectiveTargets = migrated;
    targetsSource = "移行";
  } else {
    effectiveTargets = [];
    targetsSource = "なし";
  }
}

// excludes: 指定（空値含む）> config 温存 > 旧 lib 移行 > デフォルト
const DEFAULT_EXCLUDES = [".claude/", ".github/", ".githooks/"];
let effectiveExcludes;
let excludesSource;
if (rxArg !== undefined) {
  effectiveExcludes = reviewExcludes; // [] もあり得る（除外なしの明示）
  excludesSource = "指定";
} else if (deployedConfig?.excludes !== undefined) {
  effectiveExcludes = deployedConfig.excludes;
  excludesSource = "温存";
} else {
  const migrated = scrapeOldLib("REVIEW_EXCLUDES");
  if (migrated !== undefined) {
    effectiveExcludes = migrated;
    excludesSource = "移行";
  } else {
    effectiveExcludes = DEFAULT_EXCLUDES;
    excludesSource = "デフォルト";
  }
}

cpSync(join(templatesDir, "base", "hooks"), join(claudeDir, "hooks"), { recursive: true });
copied.push(
  ".claude/hooks/pr-code-review-gate.mjs",
  ".claude/hooks/code-review-effort-nudge.mjs",
  ".claude/hooks/setup-sync-check.mjs",
  ".claude/hooks/lib/reviewable-files.mjs"
);

// ---- 1b. review-config.json の書き込み ----
// テンプレートには含めず apply.mjs が生成・更新する（cpSync で消えない独立ファイル）。
writeFileSync(
  configPath,
  JSON.stringify({ reviewTargets: effectiveTargets, reviewExcludes: effectiveExcludes }, null, 2) + "\n",
  "utf8"
);
copied.push(".claude/hooks/review-config.json");

// ブランチ保護 pre-push（既定 ON）。opt-out（--no-pre-push）時は配備済みファイルを削除する。
// 削除の stage は Step 6 の git ブロックで行う（コミットに乗せるため）。
const prePushDst = join(target, ".githooks", "pre-push");
if (prePush) {
  cpSync(join(templatesDir, "base", "githooks"), join(target, ".githooks"), { recursive: true });
  copied.push(".githooks/pre-push");
} else if (existsSync(prePushDst)) {
  rmSync(prePushDst);
  removed.push(".githooks/pre-push（ブランチ保護 opt-out）");
}

// .githooks/ 配下（pre-push / pr-copilot の pre-commit 等）を撒く構成のときだけ、
// git 属性と整形除外を整える。撒く githook が無ければ何もしない。
if (prePush || prCopilot) {
  // git hook は拡張子が無く、一般的な `*.sh eol=lf` ルールに載らない。core.autocrlf=true の
  // Windows で fresh clone が CRLF になるのを防ぐため、.gitattributes に LF 固定を追記する
  // （現行 Git for Windows は CRLF の hook も動くが、ツールチェーン依存にしない）。
  const gaPath = join(target, ".gitattributes");
  if (!existsSync(gaPath) || !readFileSync(gaPath, "utf8").includes(".githooks/")) {
    const ga = existsSync(gaPath) ? readFileSync(gaPath, "utf8") : "";
    const sep = ga === "" || ga.endsWith("\n") ? "" : "\n";
    writeFileSync(
      gaPath,
      ga + sep + "\n# git hooks（拡張子なし）は LF 固定。CRLF だと shebang が壊れる環境があるため。\n.githooks/* text eol=lf\n",
      "utf8"
    );
    copied.push(".gitattributes（.githooks の LF 固定を追記）");
  }

  // .githooks/ 配下はテンプレート由来（再実行で上書きされる）ため、プロジェクトの
  // Prettier に整形させない。ただし .prettierignore が既に存在するプロジェクトだけ追記する
  // （Prettier を使わないプロジェクトへ無意味なファイルを作らないため）。
  const piPath = join(target, ".prettierignore");
  if (existsSync(piPath) && !readFileSync(piPath, "utf8").includes(".githooks/")) {
    const pi = readFileSync(piPath, "utf8");
    const sep = pi === "" || pi.endsWith("\n") ? "" : "\n";
    writeFileSync(
      piPath,
      pi + sep + "\n# setup-github が配布するテンプレート（再実行で上書きされるため整形しない）\n.githooks/\n",
      "utf8"
    );
    copied.push(".prettierignore（.githooks/ の除外を追記）");
  }
}

// ---- 2. 同梱スナップショットのコピー（plugin 単体で完結。~/.claude は参照しない） ----
// git-conventions.md はプロジェクト側でカスタマイズされ得る（例: GitHub Flow / main 単一へ
// 書き換え）。同梱版と異なる内容が既にある場合は上書きせず警告に留める。
// 無条件上書きにすると、再実行のたびにプロジェクト固有のブランチ戦略が消えるため。
const conventionsSrc = join(templatesDir, "base", "rules", "git-conventions.md");
const conventionsDst = join(claudeDir, "rules", "git-conventions.md");
const conventionsContent = readFileSync(conventionsSrc, "utf8");
if (existsSync(conventionsDst) && readFileSync(conventionsDst, "utf8") !== conventionsContent) {
  warnings.push(
    ".claude/rules/git-conventions.md はプロジェクト側でカスタマイズされているため上書きしませんでした（同梱版との差分は手動で確認してください）"
  );
} else {
  mkdirSync(join(claudeDir, "rules"), { recursive: true });
  cpSync(conventionsSrc, conventionsDst);
  copied.push(".claude/rules/git-conventions.md");
}

cpSync(join(templatesDir, "base", "skills", "create-issue"), join(claudeDir, "skills", "create-issue"), {
  recursive: true,
});
copied.push(".claude/skills/create-issue/");

// ---- 3. --pr-copilot テンプレートのコピー ----
// githooks/ はリポジトリルートの .githooks/、workflows/ は .github/workflows/ へ配置し、
// それ以外は .claude/ 配下へ入れるため、サブフォルダ単位でコピーする
// （base の hooks / githooks の分離と同じ構造）。
if (prCopilot) {
  for (const d of ["hooks", "skills", "agents"]) {
    cpSync(join(templatesDir, "pr-copilot", d), join(claudeDir, d), { recursive: true });
  }
  cpSync(join(templatesDir, "pr-copilot", "githooks"), join(target, ".githooks"), {
    recursive: true,
  });
  // CI ガード: AGENTS.md と .claude/rules の乖離を PR で検証する。ローカル pre-commit は
  // --no-verify / Web UI 編集 / hooksPath 未設定 clone で素通りするため、CI が最後の砦。
  cpSync(join(templatesDir, "pr-copilot", "workflows"), join(target, ".github", "workflows"), {
    recursive: true,
  });
  copied.push(
    ".claude/hooks/after-pr-create.mjs",
    ".claude/skills/watch-pr/",
    ".claude/skills/resolve-pr/",
    ".claude/agents/review-responder.md",
    ".githooks/pre-commit",
    ".githooks/generate-agents-md.mjs",
    ".github/workflows/agents-md-sync.yml"
  );
}

// ---- 3b. AGENTS.md の初回生成 ----
// 以後の同期は .githooks/pre-commit がコミットごとに行う（再生成 → 差分があれば stage）。
// 手書きの AGENTS.md（生成ヘッダー無し）は生成スクリプトが検知して上書きしない。
let agentsState = null;
if (prCopilot) {
  // spawnSync で stderr も回収する（generator の LINE_LIMIT 超過警告は stderr に出る。
  // execFileSync の pipe だと握り潰されて導入時レポートに現れないため）。
  const res = spawnSync(
    process.execPath,
    [join(target, ".githooks", "generate-agents-md.mjs"), target],
    { encoding: "utf8" }
  );
  if (res.status === 0 && typeof res.stdout === "string") {
    agentsState = res.stdout.trim().split("\n")[0]; // 機械判定は先頭行
    if (agentsState.startsWith("skipped:")) {
      warnings.push(agentsState.replace(/^skipped:\s*/, "AGENTS.md: "));
    }
    const stderr = (res.stderr || "").trim();
    if (stderr) warnings.push(`AGENTS.md 生成時の警告: ${stderr}`);
  } else {
    warnings.push("AGENTS.md の初回生成に失敗しました（次回コミット時に pre-commit が再試行します）");
  }
}

// ---- 4. CLAUDE.md への追記（マーカー検知で冪等） ----
// 開発ワークフローの箇条書きは、既存の `## 開発ワークフロー` 見出しがあればその節へ
// upsertWorkflowSection でマージする（無ければ新設。他ツールが同じ見出しを使っても重複しない）。
// ヘルパーはこのファイル内に閉じる（スキル単体コピーで動くよう外部モジュールに依存しない）。
const claudeMdJoinSep = (content) =>
  content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";

// `## 開発ワークフロー` 見出しの下へ箇条書きをマージ（冪等・単一見出し）。
// bullets: [{ mark, text }]（mark = 冪等判定の一意な部分文字列 / text = 追記する 1 行）。
// 返り値: { bullets: [{ mark, state }] }（state = "present" | "added"）。
function upsertWorkflowSection(mdPath, heading, bullets) {
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
    return existing === null ? section : existing + claudeMdJoinSep(existing) + section;
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

const claudeMdPath = join(claudeDir, "CLAUDE.md");

const WORKFLOW_HEADING = "## 開発ワークフロー";
const BRANCH_MARK = "**ブランチ**:";
const BRANCH_BULLET =
  "- **ブランチ**: 実装前に必ずデフォルトブランチから作業ブランチを切る。デフォルトブランチへの直接コミット・直接 push は禁止。変更は必ず作業ブランチ経由の PR で入れる";

// 簡素化レビュー: PR 作成前に /simplify を 1 回。gate 登録解除に伴いソフト運用（強制なし）。
// 旧テンプレは code-review 必須（gate 強制）だったが、code-review が原則ユーザー手打ち専用に
// なったため、Claude が自走で回せる /simplify（品質整理）へ差し替える。バグ探索が要る変更は
// ユーザーが手動で /code-review を回す運用。
const SIMPLIFY_MARK = "**簡素化**:";
const SIMPLIFY_LINE =
  "- **簡素化**: PR 作成前（変更コミット後）に `/simplify` を 1 回実行し、再利用・簡素化・効率の観点でコードを整理する";
// 旧 code-review 運用行（古い順）。gate 登録解除に伴い /simplify 行へ移行する。完全一致のみ。
const REVIEW_GUARD_LINES_OLD = [
  "- **レビュー**: PR 作成前（変更コミット後）に `node .claude/hooks/pr-code-review-gate.mjs --required` で推奨 effort を確認し、`/code-review <effort>` と effort を明示して 1 回実行する（effort 未指定の起動は hook が差し戻す。実行漏れは PR 作成時にブロック）",
  "- **レビュー**: PR 作成前に `/code-review` を実行する（実行漏れ・effort 不足は hook が PR 作成時にブロックして知らせる）",
  "- **レビュー**: PR 作成前（変更コミット後）に `node .claude/hooks/pr-code-review-gate.mjs --required` で必要 effort を確認し、その effort で `/code-review` を実行する（実行漏れ・effort 不足は hook が PR 作成時にブロックして知らせる）",
  "- **レビュー**: PR 作成前（変更コミット後）に `/code-review` を 1 回実行する。effort は `node .claude/hooks/pr-code-review-gate.mjs --required` の算出値を推奨（実行漏れは hook が PR 作成時にブロックして知らせる）",
];

const SECURITY_GUARD_MARK = "**セキュリティレビュー**:";
const SECURITY_GUARD_LINE =
  "- **セキュリティレビュー**: PR 作成前（変更コミット後）に `/security-review` を 1 回実行する";
// 旧 security 運用行（ブロック文言つき）。gate 登録解除でソフト版へ移行する。完全一致のみ。
const SECURITY_GUARD_LINES_OLD = [
  "- **セキュリティレビュー**: PR 作成前（変更コミット後）に `/security-review` を 1 回実行する（コード変更を含む PR での実行漏れは PR 作成時にブロック）",
];

// 旧 pr-copilot テンプレが CLAUDE.md へ撒いていた「## PR レビュー」節は配布を廃止した。
// watch-pr の起動トリガーは after-pr-create.mjs hook の additionalContext のみ
// （コード変更を含む PR に限る条件付き）。CLAUDE.md 側の無条件「PR 作成後 /watch-pr」は
// hook のガードを迂回し、レビューが来ない PR への空監視（30 分 TIMEOUT）を生んでいた。
// 「1 PR 1 回のみ」の制約は watch-pr skill 本体へ移した。ここでは配備済みの旧節を
// 再実行時に除去する（旧テンプレと完全一致のときだけ。手編集された節は触らない）。
const REVIEW_MARK = "**レビュー対応**:";
// 旧文面の 2 形態を除去対象にする。節形（テンプレそのまま）と箇条書き形
// （導入時に既存の「## 開発ワークフロー」節へ手動マージされた配備が実在する）。
// 文面本体が完全一致するときだけ消す（それ以外の手編集は kept-custom で警告）。
const REVIEW_LINE_OLD =
  "\\*\\*レビュー対応\\*\\*: PR 作成後 `\\/watch-pr` でレビューを監視し、指摘があれば `\\/resolve-pr` で対応。`\\/watch-pr` は 1 PR につき 1 回のみ（Copilot は 1 PR に 1 回しかレビューしないため）";
const REVIEW_SECTION_OLD_RES = [
  new RegExp(`## PR レビュー\\r?\\n(?:\\r?\\n)?${REVIEW_LINE_OLD}(?:\\r?\\n)?`),
  new RegExp(`^- ${REVIEW_LINE_OLD}\\r?\\n?`, "m"),
];

// 旧文面の移行: 旧 code-review 行を /simplify 行へ、旧 security 行（ブロック文言つき）を
// soft 版へ置き換える。gate を登録解除するので「PR 作成時にブロック」の案内が残ると運用が
// 食い違う。ユーザーが文面を独自編集している可能性があるので、旧テンプレと完全一致のときだけ
// 置換する。upsert より前に行い、置換後は各マーカーが在るので二重追記されない。
let reviewLineMigrated = false;
let securityLineMigrated = false;
if (existsSync(claudeMdPath)) {
  let content = readFileSync(claudeMdPath, "utf8");
  let changed = false;
  const oldReview = REVIEW_GUARD_LINES_OLD.find((l) => content.includes(l));
  if (oldReview) {
    content = content.replace(oldReview, SIMPLIFY_LINE);
    reviewLineMigrated = true;
    changed = true;
  }
  const oldSecurity = SECURITY_GUARD_LINES_OLD.find((l) => content.includes(l));
  if (oldSecurity) {
    content = content.replace(oldSecurity, SECURITY_GUARD_LINE);
    securityLineMigrated = true;
    changed = true;
  }
  if (changed) writeFileSync(claudeMdPath, content, "utf8");
  // 移行しきれない旧 code-review 行（手編集で完全一致しない）が残っていれば警告する。
  // マーカーが変わった（レビュー→簡素化）ので、放置すると重複行になり得る。
  if (!reviewLineMigrated && content.includes("**レビュー**:")) {
    warnings.push(
      "CLAUDE.md に旧「**レビュー**:」行（code-review 運用）が残っています。gate 登録解除に伴い /simplify へ移行する方針なので、手動で `**簡素化**: /simplify` 行へ置き換えてください"
    );
  }
}

// 旧「## PR レビュー」節の除去移行（配布廃止の後始末。理由は REVIEW_SECTION_OLD_RES 上部を参照）。
let reviewSectionState = null;
if (existsSync(claudeMdPath)) {
  const content = readFileSync(claudeMdPath, "utf8");
  const matched = REVIEW_SECTION_OLD_RES.find((re) => re.test(content));
  if (matched) {
    const removed = content
      .replace(matched, "")
      .replace(/(\r?\n){3,}/g, "\n\n")
      .replace(/(\r?\n)+$/, "\n");
    writeFileSync(claudeMdPath, removed, "utf8");
    reviewSectionState = "removed";
  } else if (content.includes(REVIEW_MARK)) {
    reviewSectionState = "kept-custom";
    warnings.push(
      "CLAUDE.md の「**レビュー対応**:」節が旧テンプレ文面と異なるため除去しませんでした（watch-pr の起動は hook 指示のみで行う方針です。無条件の「PR 作成後 /watch-pr」が残っていないか手動で確認してください）"
    );
  }
}

const workflow = upsertWorkflowSection(claudeMdPath, WORKFLOW_HEADING, [
  { mark: BRANCH_MARK, text: BRANCH_BULLET },
  { mark: SIMPLIFY_MARK, text: SIMPLIFY_LINE },
  { mark: SECURITY_GUARD_MARK, text: SECURITY_GUARD_LINE },
]);
const wfState = (mark) => workflow.bullets.find((b) => b.mark === mark)?.state ?? "?";
const claudeMdStates = [`ブランチ規約: ${wfState(BRANCH_MARK)}`];
claudeMdStates.push(`簡素化(/simplify): ${reviewLineMigrated ? "migrated-from-code-review" : wfState(SIMPLIFY_MARK)}`);
claudeMdStates.push(`セキュリティレビュー: ${securityLineMigrated ? "updated" : wfState(SECURITY_GUARD_MARK)}`);
if (reviewSectionState) claudeMdStates.push(`レビュー運用(旧節): ${reviewSectionState}`);

// ---- 5. .claude/settings.json へのフック登録（マージ・冪等） ----
const settingsPath = join(claudeDir, "settings.json");
let settings = {};
let settingsReadable = true;
if (existsSync(settingsPath)) {
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    settingsReadable = false;
    warnings.push(`settings.json が不正な JSON のためフック登録をスキップしました: ${settingsPath}`);
  }
}

const hookStates = [];
if (settingsReadable) {
  settings.hooks ??= {};

  // 登録 or 更新: owns(command) が真の既存 hook を「自分が撒いたもの」とみなし、テンプレの
  // 最新形へ置き換える（旧版で撒いた timeout/if 無しの定義を追従）。無ければ新規追加。
  // 所有権は部分一致 needle をやめ、スクリプト hook は一意なファイル名、hooksPath は完全一致で
  // 判定する。似ているが別物（conflicts）を見つけたら上書きせず警告してスキップする
  // （例: ユーザー独自の `git config core.hooksPath .husky && ...` を壊さない）。
  let settingsChanged = false;
  const register = (event, { label, owns, conflicts, conflictWarn, entry }) => {
    const groups = settings.hooks[event] ?? [];
    for (const g of groups) {
      const i = (g?.hooks ?? []).findIndex((h) => typeof h?.command === "string" && owns(h.command));
      if (i >= 0) {
        const desired = entry.hooks[0];
        if (JSON.stringify(g.hooks[i]) !== JSON.stringify(desired)) {
          g.hooks[i] = desired;
          settingsChanged = true;
          hookStates.push(`${event}(${label}): updated`);
        } else {
          hookStates.push(`${event}(${label}): already-registered`);
        }
        return;
      }
    }
    if (conflicts) {
      for (const g of groups) {
        const c = (g?.hooks ?? []).find((h) => typeof h?.command === "string" && conflicts(h.command));
        if (c) {
          warnings.push(`${conflictWarn}（既存: ${c.command}）`);
          hookStates.push(`${event}(${label}): skipped-conflict`);
          return;
        }
      }
    }
    settings.hooks[event] ??= [];
    settings.hooks[event].push(entry);
    settingsChanged = true;
    hookStates.push(`${event}(${label}): registered`);
  };

  // 登録解除: 自分が過去に撒いた hook を settings.json から外す（owns 一致で除去し、
  // 空になったグループは畳む）。既存配備先の再実行で「休眠化」を貫徹するため。
  // 自分の hook だけを外し、他人の hook や未知構造のグループには触れない。
  const deregister = (event, { label, owns }) => {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) {
      hookStates.push(`${event}(${label}): not-present`);
      return;
    }
    let removed = false;
    for (const g of groups) {
      if (!Array.isArray(g?.hooks)) continue;
      const before = g.hooks.length;
      g.hooks = g.hooks.filter((h) => !(typeof h?.command === "string" && owns(h.command)));
      if (g.hooks.length !== before) removed = true;
    }
    if (!removed) {
      hookStates.push(`${event}(${label}): not-present`);
      return;
    }
    // 自分の hook を抜いて空になったグループだけ落とす（他人の空グループも巻き添えに
    // なり得るが害はない）。イベント配列ごと空なら key を消す。
    settings.hooks[event] = groups.filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
    settingsChanged = true;
    hookStates.push(`${event}(${label}): deregistered`);
  };

  // PR 作成 gate / effort nudge は登録解除して休眠させる（ファイルは cpSync で残すが
  // settings.json からは外す）。理由: 最新の Claude Code では /code-review が原則ユーザー
  // 手打ち専用になり、Claude 発の起動を前提にした nudge は発火しない。gate 本体の
  // typedRe バグ（手打ちレビューの取りこぼし→ループ）は修正済みだが、レビュー強制は
  // CLAUDE.md のソフト運用（/simplify + /security-review）へ移行するため既定では無効化する。
  // 再有効化したい場合はこの 2 hook を settings.json へ手動登録すればよい。
  deregister("PreToolUse", {
    label: "pr-code-review-gate.mjs",
    owns: (cmd) => cmd.includes("pr-code-review-gate.mjs"),
  });
  deregister("PreToolUse", {
    label: "code-review-effort-nudge.mjs",
    owns: (cmd) => cmd.includes("code-review-effort-nudge.mjs"),
  });

  // core.hooksPath 自動設定は「撒く githook がある」構成でだけ登録する。pre-push を opt-out し
  // pr-copilot も入れない構成では .githooks/ が空になるため、自分が撒いた設定 hook を登録解除する
  // （空 dir を指す無意味な hook を残さない。他ツールの core.hooksPath 設定には触れない）。
  if (prePush || prCopilot) {
    register("SessionStart", {
      label: "core.hooksPath",
      // 完全一致のみ「自分」とみなす。core.hooksPath を含む別コマンド（ユーザーの独自設定）は
      // conflicts で検出して上書きせずスキップする。
      owns: (cmd) => cmd.trim() === "git config core.hooksPath .githooks",
      conflicts: (cmd) => cmd.includes("core.hooksPath"),
      conflictWarn:
        "SessionStart に既存の core.hooksPath 設定 hook があるため上書きしませんでした。手動で .githooks への設定を確認してください",
      entry: {
        hooks: [{ type: "command", command: "git config core.hooksPath .githooks", timeout: 10 }],
      },
    });
  } else {
    deregister("SessionStart", {
      label: "core.hooksPath",
      owns: (cmd) => cmd.trim() === "git config core.hooksPath .githooks",
    });
  }

  register("SessionStart", {
    label: "setup-sync-check.mjs",
    owns: (cmd) => cmd.includes("setup-sync-check.mjs"),
    entry: {
      hooks: [
        {
          type: "command",
          command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/setup-sync-check.mjs"',
          // 差が無ければ即 exit する軽量比較のみ。念のため短めのタイムアウトを付ける。
          timeout: 10,
        },
      ],
    },
  });

  if (prCopilot) {
    register("PostToolUse", {
      label: "after-pr-create.mjs",
      owns: (cmd) => cmd.includes("after-pr-create.mjs"),
      entry: {
        matcher: "Bash",
        hooks: [
          {
            type: "command",
            command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/after-pr-create.mjs"',
            // gate 側と同様、gh pr create のときだけ起動して毎 Bash の node 起動税を避ける
            if: "Bash(gh pr create *)",
            timeout: 15,
          },
        ],
      },
    });
  }

  if (settingsChanged) {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  }
}

// ---- 5b. 状態ファイル setup-sync-state.json の書き込み ----
// 適用時のプラグイン版と有効フラグを記録する。SessionStart hook がこれと現行版を比較し、
// 更新時に `/setup-sync`（sync-run.mjs）の実行を促す。フラグは「有効値」を明示保存する
// （配備済み設定からの継承に依存せず、無人再適用が決定的に同じ構成を再現できるように）。
const syncStates = [];
const pluginVersion = readPluginVersion();
if (pluginVersion) {
  // csv 化は末尾スラッシュを外して可読性を上げる（apply.mjs 側の normTarget が付け直す）。
  const csv = (arr) => arr.map((s) => s.replace(/\/+$/, "")).join(",");
  const syncFlags = [];
  if (prCopilot) syncFlags.push("--pr-copilot");
  if (!prePush) syncFlags.push("--no-pre-push");
  syncFlags.push(`--review-targets=${csv(effectiveTargets)}`);
  syncFlags.push(`--review-excludes=${csv(effectiveExcludes)}`);
  writeSyncState("setup-github", pluginVersion, syncFlags);
  copied.push(".claude/setup-sync-state.json");
  syncStates.push(`setup-github v${pluginVersion}（flags: ${syncFlags.join(" ") || "なし"}）`);
} else {
  warnings.push(
    ".claude-plugin/plugin.json のバージョンを読めなかったため setup-sync-state.json を書きませんでした（テンプレ自動追随は無効のまま）"
  );
}

// ---- 6. git 操作: 実行者の clone へ即時 opt-in + pre-push の exec bit ----
const gitStates = [];
if (git("rev-parse", "--is-inside-work-tree") === "true") {
  if (prePush || prCopilot) {
    gitStates.push(
      git("config", "core.hooksPath", ".githooks") !== null
        ? "core.hooksPath=.githooks を設定しました（この clone で git hook が有効）"
        : "core.hooksPath の設定に失敗しました"
    );
  } else {
    // 撒く githook が無い構成: 自分が設定した .githooks 指定だけ外す（他値・未設定は触らない）。
    const cur = git("config", "core.hooksPath");
    if (cur === ".githooks") {
      gitStates.push(
        git("config", "--unset", "core.hooksPath") !== null
          ? "core.hooksPath（.githooks）を解除しました（撒く git hook が無いため）"
          : "core.hooksPath の解除に失敗しました"
      );
    }
  }
  // mac/linux の clone で hook が実行可能になるよう、撒いた hook に index の exec bit を立てる。
  // 副作用として対象 hook が stage される。
  const hookFiles = [
    ...(prePush ? [".githooks/pre-push"] : []),
    ...(prCopilot ? [".githooks/pre-commit"] : []),
  ];
  for (const hf of hookFiles) {
    if (git("add", hf) !== null && git("update-index", "--chmod=+x", hf) !== null) {
      gitStates.push(`${hf} に exec bit を付与しました（stage されています）`);
    } else {
      gitStates.push(`${hf} への exec bit 付与に失敗しました（mac/linux では手動で chmod +x が必要）`);
    }
  }
  // opt-out で削除した pre-push は削除を stage する（コミットに乗せて配布先からも消えるように）。
  if (!prePush && removed.some((r) => r.startsWith(".githooks/pre-push"))) {
    if (git("add", ".githooks/pre-push") !== null) {
      gitStates.push(".githooks/pre-push の削除を stage しました");
    }
  }
} else {
  warnings.push("git リポジトリではないため core.hooksPath 設定と exec bit 付与をスキップしました");
}

// ---- 7. レポート ----
const sourceNote = {
  指定: "指定",
  温存: "配備済み設定を温存",
  移行: "旧版 lib から移行",
  なし: "全フォルダ",
  デフォルト: "デフォルト",
};
console.log(`インストール先: ${claudeDir}`);
console.log(
  `モード: base${prCopilot ? " + pr-copilot" : ""}${prCopilotInherited ? "（pr-copilot は配備済みを自動継承）" : ""}`
);
console.log(`ブランチ保護 pre-push: ${prePush ? "有効" : "無効（--no-pre-push）"}`);
console.log(
  `レビュー対象フォルダ: ${
    effectiveTargets.length
      ? `${effectiveTargets.join(", ")}（${sourceNote[targetsSource]}）`
      : `指定なし（全フォルダ）`
  }`
);
console.log(
  `レビュー除外フォルダ: ${
    effectiveExcludes.length
      ? `${effectiveExcludes.join(", ")}（${sourceNote[excludesSource]}）`
      : `除外なし（${sourceNote[excludesSource]}）`
  }`
);
console.log("配置ファイル:");
for (const f of copied) console.log(`  - ${f}`);
if (removed.length) {
  console.log("削除ファイル:");
  for (const f of removed) console.log(`  - ${f}`);
}
console.log("CLAUDE.md:");
for (const s of claudeMdStates) console.log(`  - ${s}`);
console.log("settings.json:");
for (const s of hookStates) console.log(`  - ${s}`);
console.log("git:");
for (const s of gitStates) console.log(`  - ${s}`);
if (syncStates.length) {
  console.log("状態ファイル(setup-sync-state.json):");
  for (const s of syncStates) console.log(`  - ${s}`);
}
if (agentsState) {
  console.log("AGENTS.md:");
  console.log(`  - ${agentsState}`);
}
if (warnings.length) {
  console.log("警告:");
  for (const w of warnings) console.log(`  ! ${w}`);
}
