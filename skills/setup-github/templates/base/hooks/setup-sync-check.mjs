// SessionStart hook: setup-github / setup-unity テンプレートの更新を検知して知らせる。
//
// 対象プロジェクトの `.claude/setup-sync-state.json`（apply.mjs が記録した適用時のプラグイン版と
// フラグ）と、いまインストールされている project-setup プラグインの現行版を比較する。
// 現行版のほうが新しければ、ユーザーと Claude の両方へ知らせて終わる。
// 差が無ければ即 exit 0（毎セッションの税を最小化）。
//
// 設計:
//   - **ここでは同期しない**。同期は `/setup-sync` をメインセッションの Claude が実行して行う。
//     テンプレの .md 統合は LLM の判断を含む工程で、矛盾したらその場でユーザーに聞ける方がよい。
//   - 人間に見せたい行は **systemMessage** で出す。additionalContext は Claude のコンテキストに
//     入るだけで画面には出ないため、それだけだと気づかれないまま放置される。
//   - SessionStart はブロックできない（公式仕様: Can block? = No）。exit 2 でも stderr が
//     出るだけでセッションは進む。止める設計は取れないし、取らない。
//   - 発火はアップグレード方向のみ（現行版 > 記録版）。複数マシンでプラグイン版がずれていても、
//     古い版のマシンが新しい版で同期済みのプロジェクトを古いテンプレへ巻き戻す churn を防ぐ。
//   - hook 自身はバージョン比較だけ。ネットワーク・gh・git は sync-run.mjs 側が叩く。
//   - 状態ファイルが無いプロジェクト（未セットアップ or バックフィル前）は対象外 → 即 exit 0。
//   - SETUP_SYNC_DISABLE=1 で黙らせられる（避難口）。
//
// このスキル 1 ファイルで完結する（外部モジュールを import しない）。jq 非依存（Node のみ）。

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
/* global process, Buffer */

function done() {
  process.exit(0);
}

// systemMessage はユーザーの画面に出る。additionalContext は Claude だけが読む。
// 両方出す: 人間が「同期が要る」と知り、Claude が何をすべきか知る。
function emit(userLine, claudeText) {
  process.stdout.write(
    JSON.stringify({
      systemMessage: userLine,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: claudeText,
      },
    })
  );
  process.exit(0);
}

// 誤動作時の一時無効化。
if (process.env.SETUP_SYNC_DISABLE === "1") done();

// 先頭 BOM（U+FEFF）を除去する。正規表現にリテラル BOM を書くと eslint の
// no-irregular-whitespace に触れるため、コードポイント比較で剥がす。
function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// "1.2.0" 同士を数値比較。a > b で正。パースできない値（"unknown" 等）は 0.0.0 扱い。
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

function readJson(path) {
  try {
    return JSON.parse(stripBom(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

// ---- 1. プロジェクトディレクトリの解決 ----
let stdin = {};
try {
  stdin = JSON.parse(stripBom(await readStdin())) || {};
} catch {
  stdin = {};
}
const projectDir = process.env.CLAUDE_PROJECT_DIR || stdin.cwd || process.cwd();

// ---- 2. 状態ファイル ----
const statePath = join(projectDir, ".claude", "setup-sync-state.json");
if (!existsSync(statePath)) done(); // 未セットアップ or バックフィル前 → 対象外
const state = readJson(statePath);
if (!state || typeof state !== "object") done(); // 壊れた状態ファイルは黙って無視（毎回煽らない）

// ---- 3. インストール済み project-setup プラグインの現行版 ----
const pluginsJsonPath =
  process.env.SETUP_SYNC_PLUGINS_JSON ||
  join(homedir(), ".claude", "plugins", "installed_plugins.json");
const installed = readJson(pluginsJsonPath);
if (!installed || !installed.plugins) done();

// キーは "project-setup@<marketplace>"。marketplace 名は環境依存なのでプレフィックス一致で拾う。
const key = Object.keys(installed.plugins).find((k) => /^project-setup@/.test(k));
if (!key) done();
const entries = installed.plugins[key];
if (!Array.isArray(entries) || entries.length === 0) done();
// 複数エントリ（scope 違い等）は最終更新が新しいものを採用。
const entry = entries
  .slice()
  .sort((a, b) => String(b.lastUpdated || "").localeCompare(String(a.lastUpdated || "")))[0];
const installPath = entry.installPath;
let currentVersion = entry.version;
// version が "unknown"/欠落なら installPath の plugin.json から読む。
if (!currentVersion || currentVersion === "unknown") {
  const pj = installPath && readJson(join(installPath, ".claude-plugin", "plugin.json"));
  currentVersion = pj?.version;
}
if (!currentVersion) done();

// ---- 4. 記録版との差分（アップグレード方向のみ） ----
const SKILL_KEYS = ["setup-github", "setup-unity"];
const drifted = [];
for (const k of SKILL_KEYS) {
  const rec = state[k];
  if (!rec || typeof rec !== "object" || !rec.version) continue;
  if (cmpVer(currentVersion, rec.version) > 0) {
    drifted.push({ skill: k, from: rec.version, flags: Array.isArray(rec.flags) ? rec.flags : [] });
  }
}
if (drifted.length === 0) done();

const summary = drifted.map((d) => `${d.skill} v${d.from}→v${currentVersion}`).join(" / ");

// ---- 5. 通知（ユーザーへ 1 行 + Claude へ手順）----
emit(
  `【テンプレート更新】project-setup が更新されています（${summary}）。/setup-sync で同期できます。`,
  [
    `【テンプレート自動追随】project-setup のテンプレートが更新されています（${summary}）。`,
    "",
    "このセッションの最初のターンで `/project-setup:setup-sync` を実行し、同期 PR を作成してください。",
    "ユーザーが別の作業を指示している場合は、それを先に済ませてから実行してください（同期は待てます）。",
    "",
    "同期は使い捨て worktree の中で走るので、いまの作業ツリーとブランチには影響しません。",
    "merge はしません。PR を作るところで止まります。",
  ].join("\n")
);
