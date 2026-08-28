// テンプレート同期の実行本体。
//
// SessionStart hook（sync-setup-check.mjs）は検知して知らせるだけに徹し、実際の同期は
// **ユーザーのセッションにいる Claude** が `/sync-setup` を実行して行う。要マージ .md の統合は
// LLM の判断を含む工程なので、進行も判断も見えている場所で走らせる。
//
// このスクリプトが「コードで担保」すること（SKILL.md の指示文には委ねない）:
//   1. 重複防止: 同一同期ブランチの open PR が既にあれば起動しない
//   2. 試行上限: 同一版につき最大 SYNC_SETUP_MAX_ATTEMPTS 回（既定 2）。データファイルで管理
//   3. merge しない: PR を作るところで止める（不可逆操作は人間のゲートに残す）
//   4. 作業ツリーを汚さない: 対象リポジトリのブランチは切り替えない。origin の default から
//      使い捨て worktree を切り、その中だけで apply / commit / push / PR を行う
//
// worktree は sparse-checkout（.claude / .github / .githooks + ルート直下）で展開する。
// Unity リポジトリを全展開すると Windows の MAX_PATH（260 字）に当たり、数 GB と数分を払う。
//
// drift 判定（記録版 vs 現行版）と現行版の読み取りは sync-setup-check.mjs と同じロジックを
// 持つ。hook は配備先へ単体コピーされる制約上 import できず共有 lib 化できないため、ここは
// 意図的な重複。挙動を変えるときは両方を揃える（cmpVer / installed_plugins.json の読み方）。
//
// 実行は 2 フェーズに分かれる。間に「Claude が .md をマージする」工程が挟まるため。
// apply.mjs は rules/*.md と CLAUDE.md を書かず「要マージ」として報告するだけなので、
// commit まで一息に走らせると .md 更新が反映されないまま PR が出る。
//   --phase=apply   … 重複チェック → 試行上限 → worktree 作成 → apply 再適用（ここで停止）
//   〈この間に SKILL 手順で Claude が worktree 内の要マージ .md を統合する〉
//   --phase=publish … commit → push → PR 作成（merge はしない）→ worktree 撤去
// フェーズ間の引き継ぎ（同期計画・警告・worktree パス）は attempts と同じデータディレクトリの
// sync-plan.json に置く。対象リポジトリ内に置くと git add -A で PR に混入するため。
//
// 使い方:
//   node sync-run.mjs [target-dir] --phase=apply|publish
//   node sync-run.mjs [target-dir] --dry-run
//     target-dir 省略時は CLAUDE_PROJECT_DIR → cwd の順。対象は常に**リポジトリのルート**を
//     渡す（worktree の中を渡さない）。
//     --dry-run: git/gh を一切叩かず、同期計画（対象スキル・フラグ・ブランチ・試行回数）を
//                出力して終了する（試行回数も増やさない）。テストと事前確認用。--phase は不要。
//   環境変数（主にテスト用の差し替え）:
//     SYNC_SETUP_PLUGINS_JSON  installed_plugins.json のパス
//     SYNC_SETUP_ATTEMPTS_JSON 試行回数ファイルのパス
//     SYNC_SETUP_MAX_ATTEMPTS  試行上限（既定 2）
//     SYNC_SETUP_PLAN_JSON     フェーズ間引き継ぎファイルのパス
//     SYNC_SETUP_DATA_DIR      worktree を置くデータディレクトリ
//
// 依存なし（Node 標準のみ）。

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
/* global process, console */

const here = dirname(fileURLToPath(import.meta.url));

const SKILL_KEYS = ["setup-github", "setup-unity"];

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function readJson(path) {
  try {
    const raw = readFileSync(path, "utf8");
    const s = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// "1.2.0" 同士を数値比較。a > b で正（sync-setup-check.mjs と同一仕様）。
function cmpVer(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10));
  const pb = String(b).split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// git をシェル非経由で実行。失敗時は null。
function git(target, ...a) {
  try {
    return execFileSync("git", ["-C", target, ...a], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

// origin の default ブランチ名。symbolic-ref が未設定のリポジトリのために fallback を持つ。
function resolveDefaultBranch(repo) {
  const sym = git(repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
  if (sym) return sym.replace(/^origin\//, "");
  // origin/HEAD 未設定。remote から引き直してもう一度試す。
  git(repo, "remote", "set-head", "origin", "--auto");
  const sym2 = git(repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
  if (sym2) return sym2.replace(/^origin\//, "");
  for (const b of ["main", "develop", "master"]) {
    if (git(repo, "rev-parse", "--verify", `origin/${b}`) !== null) return b;
  }
  return null;
}

// worktree ディレクトリ名。パスだけから決める（同じリポジトリなら毎回同じ場所を使い、
// 前回の残骸をそのまま踏み直せる）。
function worktreeKey(dir) {
  const norm = resolve(dir).replace(/[\\/]+$/, "");
  const canon = process.platform === "win32" ? norm.toLowerCase() : norm;
  let h = 0;
  for (let i = 0; i < canon.length; i++) h = (Math.imul(h, 31) + canon.charCodeAt(i)) | 0;
  const name = (canon.split(/[\\/]/).pop() || "repo").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
  return `${name}-${(h >>> 0).toString(16)}`;
}

// worktree の撤去。**掃除の失敗は掃除だけで閉じる**。
// Windows では rmSync が投げることがあり、まとめて try に入れると後段の掃除に届かない。
function removeWorktree(repo, wt) {
  git(repo, "worktree", "remove", "--force", wt);
  try {
    rmSync(wt, { recursive: true, force: true });
  } catch {
    /* Windows ではハンドルが残ると空 dir が消えないことがある。次回の apply が上書きする */
  }
  git(repo, "worktree", "prune");
}

// ---- 引数 ----
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const phaseArg = args.find((a) => a.startsWith("--phase="));
const phase = phaseArg ? phaseArg.slice("--phase=".length) : null;
if (!dryRun && !["apply", "publish"].includes(phase)) {
  fail(
    "--phase=apply または --phase=publish が必要です。\n" +
      "  apply   … ブランチ作成とテンプレ再適用（この後 Claude が要マージの .md を統合する）\n" +
      "  publish … commit / push / PR 作成\n" +
      "計画だけ見たいときは --dry-run。"
  );
}
const target = args.find((a) => !a.startsWith("--")) || process.env.CLAUDE_PROJECT_DIR || process.cwd();

// ---- 現行プラグイン版と installPath の解決（hook と同じ読み方） ----
const pluginsJsonPath =
  process.env.SYNC_SETUP_PLUGINS_JSON || join(homedir(), ".claude", "plugins", "installed_plugins.json");
const installed = readJson(pluginsJsonPath);
if (!installed || !installed.plugins) {
  fail(
    `インストール済みプラグイン情報を読めませんでした: ${pluginsJsonPath}\n` +
      "project-setup が導入されているか、SYNC_SETUP_PLUGINS_JSON の指定を確認してください。"
  );
}
const key = Object.keys(installed.plugins).find((k) => /^project-setup@/.test(k));
if (!key) fail("installed_plugins.json に project-setup のエントリが見つかりません。");
const entries = installed.plugins[key];
if (!Array.isArray(entries) || entries.length === 0) fail("project-setup のインストールエントリが空です。");
const entry = entries
  .slice()
  .sort((a, b) => String(b.lastUpdated || "").localeCompare(String(a.lastUpdated || "")))[0];
let installPath = entry.installPath;
let currentVersion = entry.version;
if (!currentVersion || currentVersion === "unknown") {
  const pj = installPath && readJson(join(installPath, ".claude-plugin", "plugin.json"));
  currentVersion = pj?.version;
}
// installPath が無ければ、この sync-run.mjs の位置から plugin root を推定（skills/sync-setup/ の 2 つ上）。
if (!installPath) installPath = join(here, "..", "..");
if (!currentVersion) fail("現行プラグイン版を特定できませんでした（installed_plugins.json も plugin.json も読めず）。");

const branch = `chore/sync-setup-v${currentVersion}`;

// ---- 試行回数（同一版につき上限まで）とフェーズ間引き継ぎ ----
const maxAttempts = parseInt(process.env.SYNC_SETUP_MAX_ATTEMPTS || "2", 10);
const dataDir =
  process.env.SYNC_SETUP_DATA_DIR || join(homedir(), ".claude", "plugins", "data", "project-setup");
const attemptsPath = process.env.SYNC_SETUP_ATTEMPTS_JSON || join(dataDir, "sync-attempts.json");
const planPath = process.env.SYNC_SETUP_PLAN_JSON || join(dataDir, "sync-plan.json");
// .md 統合で矛盾が出たとき Claude が書き残すメモ。publish が PR 本文へ転記して消す。
const notesPath = process.env.SYNC_SETUP_NOTES_MD || join(dataDir, "sync-notes.md");
const repoId = git(target, "remote", "get-url", "origin") || target;
const attemptKey = `${repoId}@v${currentVersion}`;
const attempts = readJson(attemptsPath) || {};
const attemptCount = Number.isFinite(attempts[attemptKey]) ? attempts[attemptKey] : 0;

// ---- drift 判定 ----
// publish フェーズでは apply が済んでいて状態ファイルが新版に書き換わっているため、
// ここで判定すると必ず「同期不要」になる。apply が残した同期計画を読んで引き継ぐ。
let drifted;
let carriedWarnings = [];
let planWorktree = null;
if (phase === "publish") {
  const plan = readJson(planPath);
  if (!plan || plan.key !== attemptKey || !Array.isArray(plan.drifted)) {
    fail(
      `同期計画が見つかりません（${planPath}）。先に --phase=apply を実行してください。\n` +
        "（apply → Claude による .md マージ → publish の順で実行します）"
    );
  }
  drifted = plan.drifted;
  carriedWarnings = Array.isArray(plan.warnings) ? plan.warnings : [];
  planWorktree = plan.worktree || null;
} else {
  const statePath = join(target, ".claude", "sync-setup-state.json");
  if (!existsSync(statePath)) {
    console.log(`同期対象外: ${statePath} がありません（未セットアップ、またはバックフィル前）。`);
    process.exit(0);
  }
  const state = readJson(statePath);
  if (!state || typeof state !== "object") fail(`状態ファイルが不正な JSON です: ${statePath}`);

  drifted = [];
  for (const k of SKILL_KEYS) {
    const rec = state[k];
    if (!rec || typeof rec !== "object" || !rec.version) continue;
    if (cmpVer(currentVersion, rec.version) > 0) {
      drifted.push({ skill: k, from: rec.version, flags: Array.isArray(rec.flags) ? rec.flags : [] });
    }
  }
  if (drifted.length === 0) {
    console.log(`同期不要: 記録版と現行版（v${currentVersion}）に差がありません。`);
    process.exit(0);
  }
}

function describePlan() {
  console.log(`同期計画:`);
  console.log(`  対象リポジトリ: ${target}`);
  console.log(`  現行版: v${currentVersion}`);
  console.log(`  ブランチ: ${branch}`);
  console.log(`  試行回数: ${attemptCount}/${maxAttempts}`);
  for (const d of drifted) {
    console.log(`  - ${d.skill}: v${d.from} → v${currentVersion}（flags: ${d.flags.join(" ") || "なし"}）`);
  }
}

// ---- dry-run: 計画のみ（git/gh を叩かない・試行回数も増やさない）----
if (dryRun) {
  describePlan();
  console.log("dry-run: 変更・PR 作成は行いません。");
  process.exit(0);
}

// gh は git と違い -C を持たない。対象リポジトリの解決は cwd で行う
// （worktree の中で呼んでも同じ origin を指す）。
function gh(cwd, ...a) {
  return execFileSync("gh", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// ============================ apply フェーズ ============================
// ガード → ブランチ作成 → テンプレ再適用まで。commit はしない。
// apply.mjs は rules/*.md と CLAUDE.md を書かず「要マージ」として報告するので、
// この後 SKILL 手順で Claude がそれらを統合してから publish フェーズへ進む。
if (phase === "apply") {
  // ---- 試行上限ガード（コード担保）----
  if (attemptCount >= maxAttempts) {
    console.log(
      `試行上限に到達しています（${attemptCount}/${maxAttempts}, key=${attemptKey}）。\n` +
        "自動同期は行いません。手動で apply.mjs を実行するか、原因を解消してから再試行してください。"
    );
    process.exit(0);
  }

  // ---- 重複 PR 防止ガード（コード担保）----
  // 判定はブランチ名で行う（タイトルは `chore: テンプレ同期 v<ver>` で一意ではない）。
  // 古い版の同期 PR は「ここで止める」ではなく publish 後に畳む。
  // 止めると新しい版が永久に届かなくなるため。
  // gh が使えない/認証されていない場合は dedup できないが、試行上限ガードが暴走を防ぐため続行する。
  try {
    const raw = gh(target, "pr", "list", "--state", "open", "--json", "number,title,headRefName", "--limit", "100");
    const prs = JSON.parse(raw);
    const dup = prs.find((p) => p.headRefName === branch);
    if (dup) {
      console.log(`既に同期 PR が存在します（#${dup.number} ${dup.title}）。二重作成を避けて終了します。`);
      process.exit(0);
    }
  } catch (e) {
    console.error(
      `警告: 既存 PR の確認に失敗しました（gh 未認証か非 GitHub リポジトリの可能性）。続行します: ${String(e.message || e).trim()}`
    );
  }

  // ここから副作用。crash しても試行としてカウントされるよう、先に試行回数を +1 して保存する。
  mkdirSync(dirname(attemptsPath), { recursive: true });
  attempts[attemptKey] = attemptCount + 1;
  writeFileSync(attemptsPath, JSON.stringify(attempts, null, 2) + "\n", "utf8");

  describePlan();

  if (git(target, "rev-parse", "--is-inside-work-tree") !== "true") {
    fail("対象が git リポジトリではありません。");
  }

  // ---- 起点を origin の default ブランチに固定 ----
  // ユーザーがいま乗っているブランチから同期ブランチを生やすと、無関係なコミットごと PR に載る。
  if (git(target, "fetch", "origin", "--prune", "--quiet") === null) {
    fail("git fetch origin に失敗しました（ネットワーク / 認証を確認してください）。");
  }
  const base = resolveDefaultBranch(target);
  if (!base) fail("origin の default ブランチを特定できませんでした。");

  // ---- 使い捨て worktree ----
  // 対象リポジトリの作業ツリーには触らない。ユーザーが Unity Editor で編集中でもブランチが
  // 足元で切り替わらず、`git add -A` が無関係な変更を巻き込むことも構造的に起こらない。
  const worktree = join(dataDir, "worktrees", `${worktreeKey(target)}-v${currentVersion}`);
  if (existsSync(worktree)) removeWorktree(target, worktree);
  git(target, "worktree", "prune");
  mkdirSync(dirname(worktree), { recursive: true });
  if (git(target, "worktree", "add", "--no-checkout", "--detach", worktree, `origin/${base}`) === null) {
    fail(`worktree の作成に失敗しました（${worktree}）。`);
  }
  // sparse-checkout でテンプレが触る領域だけ展開する。全展開は Unity リポで MAX_PATH に当たる。
  // cone モードのルート直下ファイル（CLAUDE.md / AGENTS.md 等）は常に含まれる。
  //
  // ProjectSettings は書き込み対象ではないが、setup-unity の apply.mjs が
  // `ProjectSettings/ProjectVersion.txt` の存在で Unity プロジェクトかを判定するため要る。
  // 展開しないと Unity リポの同期が毎回「Unity プロジェクトではありません」で落ち、
  // 試行上限に達して以後どの更新も届かなくなる。数ファイルなので MAX_PATH の懸念は無い。
  git(worktree, "sparse-checkout", "set", "--cone", ".claude", ".github", ".githooks", "ProjectSettings");
  if (git(worktree, "checkout") === null) fail("worktree の sparse checkout に失敗しました。");
  // 同期ブランチは常に origin/default から引き直す（前回の中断が残っていても上書きする）。
  if (git(worktree, "switch", "-C", branch) === null) {
    fail(`ブランチ ${branch} の作成に失敗しました（対象リポジトリで同名ブランチを checkout 中かもしれません）。`);
  }

  // ---- テンプレ再適用（保存フラグで apply.mjs を直叩き）----
  const warnings = [];
  let anyNeedsMerge = false;
  for (const d of drifted) {
    const applyPath = join(installPath, "skills", d.skill, "apply.mjs");
    try {
      const out = execFileSync(process.execPath, [applyPath, worktree, ...d.flags], {
        encoding: "utf8",
      });
      // 出力はそのまま流す。要マージ一覧はこの後 Claude が読んでマージに使う。
      console.log(`--- ${d.skill} ---`);
      console.log(out.trimEnd());
      if (out.includes("要マージ（")) anyNeedsMerge = true;
      // apply.mjs が人へ向けて書いた行を PR 本文へ転記する。語は skill ごとに違う
      // （setup-github は「警告:」、setup-unity は「注意:」）ので両方拾う。片方しか
      // 見ないと、旧配備物の削除やフラグの無視が PR 本文に一切現れない。
      const idx = ["警告:", "注意:"]
        .map((w) => out.indexOf(w))
        .filter((i) => i >= 0)
        .sort((a, b) => a - b)[0];
      if (idx !== undefined) warnings.push(`### ${d.skill}\n\n\`\`\`\n${out.slice(idx).trim()}\n\`\`\``);
    } catch (e) {
      fail(`${d.skill} の apply.mjs 実行に失敗しました: ${String(e.message || e).trim()}`);
    }
  }

  // ---- 同期計画をフェーズ間で引き継ぐ ----
  // 対象リポジトリ内には置かない（git add -A で PR に混入するため）。
  mkdirSync(dirname(planPath), { recursive: true });
  writeFileSync(
    planPath,
    JSON.stringify({ key: attemptKey, version: currentVersion, branch, repo: target, worktree, drifted, warnings }, null, 2) + "\n",
    "utf8"
  );

  console.log("");
  console.log(`作業 worktree: ${worktree}`);
  console.log("  対象リポジトリの作業ツリーとブランチには触れていません。編集はこの worktree の中で行ってください。");
  console.log(
    anyNeedsMerge
      ? "要マージの .md があります。worktree 内のファイルを統合してから publish フェーズへ進んでください。"
      : "要マージの .md はありません。そのまま publish フェーズへ進めます。"
  );
  console.log(`次: node sync-run.mjs ${target} --phase=publish`);
  process.exit(0);
}

// ============================ publish フェーズ ============================
// commit → push → PR 作成 → worktree 撤去。merge はしない（不可逆操作は人間のゲートに残す）。
// 操作対象は apply が作った worktree であって、対象リポジトリの作業ツリーではない。
if (!planWorktree || !existsSync(planWorktree)) {
  fail(
    `apply が作った worktree が見つかりません（${planWorktree || "計画に記録なし"}）。\n` +
      "--phase=apply からやり直してください。"
  );
}
const wt = planWorktree;
const currentBranch = git(wt, "rev-parse", "--abbrev-ref", "HEAD");
if (currentBranch !== branch) {
  fail(`worktree が ${branch} にいません（現在: ${currentBranch}）。--phase=apply からやり直してください。`);
}

// ---- commit ----
if (git(wt, "add", "-A") === null) fail("git add に失敗しました。");
// 空コミットは作らない防御。ただし apply.mjs は sync-setup-state.json に新版を必ず書くため、
// 版が上がった通常ケースでは（テンプレ本体に実差分が無くても）状態ファイルの差分が必ず出る。
// つまりここで止まるのは「apply.mjs が状態ファイルも含め何も書かなかった」異常時のみ。
// 版のみ更新の PR（記録版を進めるだけ）はノイズに見えるが、次回の hook 再通知を止めるために必要。
const staged = git(wt, "diff", "--cached", "--name-only");
if (!staged) {
  console.log("差分がありませんでした。PR は作成しません。");
  removeWorktree(target, wt);
  rmSync(planPath, { force: true });
  process.exit(0);
}
const summary = drifted.map((d) => `${d.skill} v${d.from}→v${currentVersion}`).join(" / ");
// .md 統合でテンプレと現物が矛盾し、その場で決め切らなかったとき Claude が sync-notes.md に
// 書き残す（md-merge-contract.md 参照）。判断の材料を PR 本文へ持ち上げてレビューの場に出す。
// 読んだら消す（次回の PR に古いメモを持ち越さない）。
let carriedNotes = "";
if (existsSync(notesPath)) {
  carriedNotes = readFileSync(notesPath, "utf8").trim();
  rmSync(notesPath, { force: true });
}
const body =
  `project-setup テンプレートの更新に自動追随する PR です（\`/sync-setup\`）。\n\n` +
  `## 同期内容\n\n${drifted.map((d) => `- ${d.skill}: v${d.from} → v${currentVersion}（flags: ${d.flags.join(" ") || "なし"}）`).join("\n")}\n\n` +
  (carriedNotes ? `## 要確認（テンプレと現物が矛盾）\n\n${carriedNotes}\n\n` : "") +
  (carriedWarnings.length ? `## apply.mjs の警告\n\n${carriedWarnings.join("\n\n")}\n` : "警告はありません。\n");
const commitMsg = `chore: テンプレ同期 v${currentVersion}\n\n${summary}`;
if (git(wt, "commit", "-m", commitMsg) === null) fail("git commit に失敗しました。");

// ---- push ----
if (git(wt, "push", "-u", "origin", branch) === null) fail(`git push（origin ${branch}）に失敗しました。`);

// ---- PR 作成（merge はしない）----
let createdUrl;
try {
  createdUrl = gh(wt, "pr", "create", "--title", `chore: テンプレ同期 v${currentVersion}`, "--body", body, "--head", branch).trim();
  console.log(`同期 PR を作成しました（merge はしません）: ${createdUrl}`);
} catch (e) {
  fail(`gh pr create に失敗しました: ${String(e.message || e).trim()}`);
}

// ---- 古い版の同期 PR を畳む ----
// 版が上がるたびに PR が生えるため、放置されると積み上がってどれを見ればよいか分からなくなる。
// 同期 PR はリポジトリごとに常に 1 本・最新版だけに保つ。
// close は reopen できる可逆操作で、ブランチも残る。
try {
  const raw = gh(wt, "pr", "list", "--state", "open", "--json", "number,title,headRefName", "--limit", "100");
  for (const p of JSON.parse(raw)) {
    if (!/^chore\/sync-setup-v/.test(String(p.headRefName || "")) || p.headRefName === branch) continue;
    gh(wt, "pr", "close", String(p.number), "--comment", `より新しい同期 PR（${createdUrl}）に置き換えたためクローズします。`);
    console.log(`古い同期 PR を閉じました: #${p.number} ${p.title}`);
  }
} catch (e) {
  console.error(`警告: 古い同期 PR の整理に失敗しました（続行）: ${String(e.message || e).trim()}`);
}

// ---- 後始末 ----
// PR は push 済みなので worktree はもう要らない。計画も消して、同じ計画での再 publish を防ぐ。
removeWorktree(target, wt);
rmSync(planPath, { force: true });
