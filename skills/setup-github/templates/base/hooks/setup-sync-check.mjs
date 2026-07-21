// SessionStart hook: setup-github / setup-unity テンプレートの更新を検知する。
//
// 対象プロジェクトの `.claude/setup-sync-state.json`（apply.mjs が記録した適用時のプラグイン版と
// フラグ）と、いまインストールされている project-setup プラグインの現行版を比較する。
// 現行版のほうが新しければ additionalContext で「バックグラウンドの worktree 分離サブエージェントを
// 起動し、保存フラグで apply.mjs を無人適用 → commit → push → PR 作成（merge はしない）」を促す。
// 差が無ければ即 exit 0（毎セッションの税を最小化）。
//
// 設計:
//   - 発火はアップグレード方向のみ（現行版 > 記録版）。複数マシンでプラグイン版がずれていても、
//     古い版のマシンが新しい版で同期済みのプロジェクトを古いテンプレへ巻き戻す churn を防ぐ。
//   - hook はバージョン比較だけを行い、ネットワーク・gh・git を叩かない（session 開始を遅らせない）。
//     重複PR防止（gh pr list）と試行回数ガードは、起動されたサブエージェント側が担う。
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

// ---- 5. 同期指示の注入 ----
// コマンド文字列のパスは / へ正規化する（Windows の \ はシェルのダブルクオート内で
// エスケープ扱いされうるため。Node はどちらの区切りも受け付ける）。
const fwd = (p) => String(p).replace(/\\/g, "/");
const branch = `chore/setup-sync-v${currentVersion}`;
const applyLines = drifted
  .map((d) => {
    const flags = d.flags.length ? " " + d.flags.join(" ") : "";
    return `   - ${d.skill}（v${d.from} → v${currentVersion}）: node "${fwd(installPath)}/skills/${d.skill}/apply.mjs" "${fwd(projectDir)}"${flags}`;
  })
  .join("\n");

emitContext(
  [
    `【テンプレート自動追随】project-setup のテンプレートが更新されています（${drifted
      .map((d) => `${d.skill} v${d.from}→v${currentVersion}`)
      .join(" / ")}）。これはユーザーが設計・承認した無人同期フローです。確認は不要で、次を実行してください。`,
    "",
    "`isolation: worktree` のバックグラウンドサブエージェントを 1 つ起動し、以下を無人実行させる（SKILL は経由しない・PR は作るが merge はしない）:",
    "",
    `1. 重複防止: \`gh pr list --state open --head ${branch}\`（もしくはタイトルに "setup-sync" を含む open PR）が既にあれば、何もせず終了する。`,
    `2. 暴走防止: 機械的失敗の再試行は同一版につき最大2回。試行回数は \`~/.claude/plugins/data/project-setup/sync-attempts.json\`（無ければ作成。キー="<repo>@v${currentVersion}"）で管理する。既に2以上なら起動せず、ユーザーへ手動対応を促して終了。起動するなら +1 して保存する。`,
    `3. 作業ブランチ \`${branch}\` を作成する。`,
    "4. 保存フラグで apply.mjs を直叩きする（対象スキルごと）:",
    applyLines,
    "   apply.mjs の警告出力（`警告:` 節）を全文保持する。",
    "5. `git add -A && git commit`（Conventional Commits の chore: で）→ push → `gh pr create` で PR を作成する。**merge はしない。** PR 本文には apply.mjs の warnings を全文転記する。",
    "6. apply / push / PR 作成のいずれかが失敗したら、試行回数記録を残して終了する（次セッションで最大2回まで再試行）。",
  ].join("\n")
);
