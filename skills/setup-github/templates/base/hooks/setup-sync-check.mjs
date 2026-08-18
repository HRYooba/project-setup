// SessionStart hook: setup-github / setup-unity テンプレートの更新を検知して、同期を「起動」する。
//
// 対象プロジェクトの `.claude/setup-sync-state.json`（apply.mjs が記録した適用時のプラグイン版と
// フラグ）と、いまインストールされている project-setup プラグインの現行版を比較する。
// 現行版のほうが新しければ sync-launch.mjs を detached で起動して即 return する。
// 差が無ければ即 exit 0（毎セッションの税を最小化）。
//
// 設計（なぜ「通知」をやめたか）:
//   - 旧版はここで additionalContext に「`/setup-sync` を実行して」と書くだけだった。hook は
//     実行主体を持たないため、いま起動した Claude が従うかどうかに賭ける形になる。実際に
//     v1.9.1 のまま 3 版放置された。従順性に賭けるのをやめ、プロセスを起こす形へ変えた。
//   - 起こすのは sync-launch.mjs（プラグイン側）。使い捨て worktree を切り、その中で裏 Claude に
//     `/project-setup:setup-sync` を走らせ、同期 PR まで出す。対象リポジトリの作業ツリーと
//     ブランチには触れないので、ユーザーの作業と衝突しない。
//   - 結果は results/<key>.json に残り、UserPromptSubmit hook（setup-sync-report.mjs）が
//     次のプロンプトで 1 行報告して消す。ここでは何も注入しない（セッション開始を汚さない）。
//   - 発火はアップグレード方向のみ（現行版 > 記録版）。複数マシンでプラグイン版がずれていても、
//     古い版のマシンが新しい版で同期済みのプロジェクトを古いテンプレへ巻き戻す churn を防ぐ。
//   - hook 自身はバージョン比較と spawn だけ。ネットワーク・gh・git は launcher 側で叩く
//     （session 開始を遅らせない）。
//   - 状態ファイルが無いプロジェクト（未セットアップ or バックフィル前）は対象外 → 即 exit 0。
//   - SETUP_SYNC_NO_AUTO=1 で自動起動をやめ、旧来の「通知だけ」へ落とせる（避難口）。
//
// このスキル 1 ファイルで完結する（外部モジュールを import しない）。jq 非依存（Node のみ）。

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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

const summary = drifted.map((d) => `${d.skill} v${d.from}→v${currentVersion}`).join(" / ");

// ---- 5. 避難口: 自動起動を止めて旧来の通知だけに落とす ----
if (process.env.SETUP_SYNC_NO_AUTO === "1") {
  emitContext(
    [
      `【テンプレート自動追随】project-setup のテンプレートが更新されています（${summary}）。`,
      "",
      "自動同期は SETUP_SYNC_NO_AUTO=1 で止まっています。同期するには `/setup-sync` を実行してください。",
    ].join("\n")
  );
}

// ---- 6. 同期の起動（detached。セッションは待たない）----
// 結果はこの場では出せない（数分かかる）。sync-launch.mjs が results/<key>.json に残し、
// UserPromptSubmit hook（setup-sync-report.mjs）が次のプロンプトで報告する。
const launcher = join(installPath, "skills", "setup-sync", "sync-launch.mjs");
if (!existsSync(launcher)) {
  // 旧版プラグインには launcher が無い。黙って落とさず、打てる手を伝える。
  emitContext(
    [
      `【テンプレート自動追随】テンプレートが更新されています（${summary}）が、自動同期スクリプトが`,
      `見つかりませんでした（${launcher}）。\`/setup-sync\` を手動で実行してください。`,
    ].join("\n")
  );
}

try {
  const child = spawn(process.execPath, [launcher, resolve(projectDir)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
} catch {
  // 起動に失敗しても session は止めない。次回の SessionStart で再試行される。
}
done();
