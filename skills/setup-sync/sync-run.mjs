// テンプレート同期の実行本体（方式B「通知と実行の分離」の実行側）。
//
// SessionStart hook（setup-sync-check.mjs）は「更新あり → /setup-sync を実行して」と
// 通知するだけに徹する。実際の同期（テンプレ再適用 → commit → push → PR 作成）は、
// ユーザーが `/setup-sync` を叩いたときに、この決定的スクリプトが行う。hook の注入文へ
// LLM が従うか否か（非決定的）に実行を委ねない。
//
// このスクリプトが「コードで担保」すること（旧設計では注入文=指示文でしか無かったガード）:
//   1. 重複防止: 同一同期ブランチ / タイトルに "setup-sync" を含む open PR が既にあれば起動しない
//   2. 試行上限: 同一版につき最大 SETUP_SYNC_MAX_ATTEMPTS 回（既定 2）。データファイルで管理
//   3. merge しない: PR を作るところで止める（不可逆操作は人間のゲートに残す）
//
// drift 判定（記録版 vs 現行版）と現行版の読み取りは setup-sync-check.mjs と同じロジックを
// 持つ。hook は配備先へ単体コピーされる制約上 import できず共有 lib 化できないため、ここは
// 意図的な重複。挙動を変えるときは両方を揃える（cmpVer / installed_plugins.json の読み方）。
//
// 使い方:
//   node sync-run.mjs [target-dir] [--dry-run]
//     target-dir 省略時は CLAUDE_PROJECT_DIR → cwd の順。
//     --dry-run: git/gh を一切叩かず、同期計画（対象スキル・フラグ・ブランチ・試行回数）を
//                出力して終了する（試行回数も増やさない）。テストと事前確認用。
//   環境変数（主にテスト用の差し替え）:
//     SETUP_SYNC_PLUGINS_JSON  installed_plugins.json のパス
//     SETUP_SYNC_ATTEMPTS_JSON 試行回数ファイルのパス
//     SETUP_SYNC_MAX_ATTEMPTS  試行上限（既定 2）
//
// 依存なし（Node 標準のみ）。

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

// "1.2.0" 同士を数値比較。a > b で正（setup-sync-check.mjs と同一仕様）。
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

// ---- 引数 ----
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const target = args.find((a) => !a.startsWith("--")) || process.env.CLAUDE_PROJECT_DIR || process.cwd();

// ---- 現行プラグイン版と installPath の解決（hook と同じ読み方） ----
const pluginsJsonPath =
  process.env.SETUP_SYNC_PLUGINS_JSON || join(homedir(), ".claude", "plugins", "installed_plugins.json");
const installed = readJson(pluginsJsonPath);
if (!installed || !installed.plugins) {
  fail(
    `インストール済みプラグイン情報を読めませんでした: ${pluginsJsonPath}\n` +
      "project-setup が導入されているか、SETUP_SYNC_PLUGINS_JSON の指定を確認してください。"
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
// installPath が無ければ、この sync-run.mjs の位置から plugin root を推定（skills/setup-sync/ の 2 つ上）。
if (!installPath) installPath = join(here, "..", "..");
if (!currentVersion) fail("現行プラグイン版を特定できませんでした（installed_plugins.json も plugin.json も読めず）。");

// ---- drift 判定 ----
const statePath = join(target, ".claude", "setup-sync-state.json");
if (!existsSync(statePath)) {
  console.log(`同期対象外: ${statePath} がありません（未セットアップ、またはバックフィル前）。`);
  process.exit(0);
}
const state = readJson(statePath);
if (!state || typeof state !== "object") fail(`状態ファイルが不正な JSON です: ${statePath}`);

const drifted = [];
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

const branch = `chore/setup-sync-v${currentVersion}`;

// ---- 試行回数（同一版につき上限まで）----
const maxAttempts = parseInt(process.env.SETUP_SYNC_MAX_ATTEMPTS || "2", 10);
const attemptsPath =
  process.env.SETUP_SYNC_ATTEMPTS_JSON ||
  join(homedir(), ".claude", "plugins", "data", "project-setup", "sync-attempts.json");
const repoId = git(target, "remote", "get-url", "origin") || target;
const attemptKey = `${repoId}@v${currentVersion}`;
const attempts = readJson(attemptsPath) || {};
const attemptCount = Number.isFinite(attempts[attemptKey]) ? attempts[attemptKey] : 0;

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

// ---- 試行上限ガード（コード担保）----
if (attemptCount >= maxAttempts) {
  console.log(
    `試行上限に到達しています（${attemptCount}/${maxAttempts}, key=${attemptKey}）。\n` +
      "自動同期は行いません。手動で apply.mjs を実行するか、原因を解消してから再試行してください。"
  );
  process.exit(0);
}

// ---- 重複 PR 防止ガード（コード担保）----
// gh が使えない/認証されていない場合は dedup できないが、試行上限ガードが暴走を防ぐため続行する。
// gh は git と違い -C を持たない。対象リポジトリの解決は cwd で行う。
function gh(...a) {
  return execFileSync("gh", a, { cwd: target, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
try {
  const raw = gh("pr", "list", "--state", "open", "--json", "number,title,headRefName", "--limit", "100");
  const prs = JSON.parse(raw);
  const dup = prs.find((p) => p.headRefName === branch || /setup-sync/.test(String(p.title || "")));
  if (dup) {
    console.log(`既に同期 PR が存在します（#${dup.number} ${dup.title}）。二重作成を避けて終了します。`);
    process.exit(0);
  }
} catch (e) {
  console.error(`警告: 既存 PR の確認に失敗しました（gh 未認証か非 GitHub リポジトリの可能性）。続行します: ${String(e.message || e).trim()}`);
}

// ここから副作用。crash しても試行としてカウントされるよう、先に試行回数を +1 して保存する。
mkdirSync(dirname(attemptsPath), { recursive: true });
attempts[attemptKey] = attemptCount + 1;
writeFileSync(attemptsPath, JSON.stringify(attempts, null, 2) + "\n", "utf8");

describePlan();

if (git(target, "rev-parse", "--is-inside-work-tree") !== "true") {
  fail("対象が git リポジトリではありません。");
}

// ---- 作業ブランチ ----
// 既存ブランチがあれば切り替え、無ければ作成。
const switched =
  git(target, "switch", branch) !== null || git(target, "switch", "-c", branch) !== null;
if (!switched) fail(`ブランチ ${branch} の作成/切り替えに失敗しました。`);

// ---- テンプレ再適用（保存フラグで apply.mjs を直叩き）----
const warnings = [];
for (const d of drifted) {
  const applyPath = join(installPath, "skills", d.skill, "apply.mjs");
  try {
    const out = execFileSync(process.execPath, [applyPath, target, ...d.flags], { encoding: "utf8" });
    // apply.mjs の「警告:」節を PR 本文へ転記するため保持する。
    const idx = out.indexOf("警告:");
    if (idx >= 0) warnings.push(`### ${d.skill}\n\n\`\`\`\n${out.slice(idx).trim()}\n\`\`\``);
  } catch (e) {
    fail(`${d.skill} の apply.mjs 実行に失敗しました: ${String(e.message || e).trim()}`);
  }
}

// ---- commit ----
if (git(target, "add", "-A") === null) fail("git add に失敗しました。");
// 空コミットは作らない防御。ただし apply.mjs は setup-sync-state.json に新版を必ず書くため、
// 版が上がった通常ケースでは（テンプレ本体に実差分が無くても）状態ファイルの差分が必ず出る。
// つまりここで止まるのは「apply.mjs が状態ファイルも含め何も書かなかった」異常時のみ。
// 版のみ更新の PR（記録版を進めるだけ）はノイズに見えるが、次回の hook 再通知を止めるために必要。
const staged = git(target, "diff", "--cached", "--name-only");
if (!staged) {
  console.log("差分がありませんでした。PR は作成しません。");
  process.exit(0);
}
const summary = drifted.map((d) => `${d.skill} v${d.from}→v${currentVersion}`).join(" / ");
const body =
  `project-setup テンプレートの更新に自動追随する PR です（\`/setup-sync\`）。\n\n` +
  `## 同期内容\n\n${drifted.map((d) => `- ${d.skill}: v${d.from} → v${currentVersion}（flags: ${d.flags.join(" ") || "なし"}）`).join("\n")}\n\n` +
  (warnings.length ? `## apply.mjs の警告\n\n${warnings.join("\n\n")}\n` : "警告はありません。\n");
const commitMsg = `chore: テンプレ同期 v${currentVersion}\n\n${summary}`;
if (git(target, "commit", "-m", commitMsg) === null) fail("git commit に失敗しました。");

// ---- push ----
if (git(target, "push", "-u", "origin", branch) === null) fail(`git push（origin ${branch}）に失敗しました。`);

// ---- PR 作成（merge はしない）----
try {
  const url = gh("pr", "create", "--title", `chore: テンプレ同期 v${currentVersion}`, "--body", body, "--head", branch).trim();
  console.log(`同期 PR を作成しました（merge はしません）: ${url}`);
} catch (e) {
  fail(`gh pr create に失敗しました: ${String(e.message || e).trim()}`);
}
