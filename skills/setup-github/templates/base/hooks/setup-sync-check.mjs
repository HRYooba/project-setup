// SessionStart hook: setup-github / setup-unity テンプレートの更新を検知して「通知」する。
//
// 対象プロジェクトの `.claude/setup-sync-state.json`（apply.mjs が記録した適用時のプラグイン版と
// フラグ）と、いまインストールされている project-setup プラグインの現行版を比較する。
// 現行版のほうが新しければ additionalContext で「`/setup-sync` を実行して同期 PR を作ってほしい」と
// 通知するだけに徹する。差が無ければ即 exit 0（毎セッションの税を最小化）。
//
// 設計（方式B: 通知と実行の分離）:
//   - この hook は「更新の有無」を検知して通知するのみ。実際の同期（apply 再適用 → commit →
//     push → PR）は `/setup-sync` skill → sync-run.mjs が決定的に行う。注入文へ LLM が従うか否か
//     （非決定的）に実行を委ねない。重複PR防止・試行上限・merge 禁止は sync-run.mjs がコード担保する。
//   - 発火はアップグレード方向のみ（現行版 > 記録版）。複数マシンでプラグイン版がずれていても、
//     古い版のマシンが新しい版で同期済みのプロジェクトを古いテンプレへ巻き戻す churn を防ぐ。
//   - hook はバージョン比較だけを行い、ネットワーク・gh・git を叩かない（session 開始を遅らせない）。
//   - 状態ファイルが無いプロジェクト（未セットアップ or バックフィル前）は対象外 → 即 exit 0。
//
// このスキル 1 ファイルで完結する（外部モジュールを import しない）。jq 非依存（Node のみ）。

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
/* global process, Buffer */

function done() {
  process.exit(0);
}

function emitContext(text) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: text,
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
if (!currentVersion || !installPath) done();

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

// ---- 5. 同期の通知（実行は /setup-sync に委ねる）----
// この hook は「更新あり」を伝えるだけ。実行（apply → commit → push → PR）は sync-run.mjs が
// 決定的に行い、重複PR防止・試行上限・merge 禁止もそちらでコード担保する。
emitContext(
  [
    `【テンプレート自動追随】project-setup のテンプレートが更新されています（${drifted
      .map((d) => `${d.skill} v${d.from}→v${currentVersion}`)
      .join(" / ")}）。`,
    "",
    "同期するには `/setup-sync` を実行してください。保存フラグでテンプレを再適用し、commit → push →",
    "同期 PR の作成まで行います（**merge はしません**）。重複 PR 防止・試行上限（同一版 最大2回）・",
    "merge 禁止は実行スクリプト側でコード担保されます。",
    "",
    "自動では実行しません。同期が不要ならこの通知は無視して構いません（次に版が上がるまで再通知されます）。",
  ].join("\n")
);
