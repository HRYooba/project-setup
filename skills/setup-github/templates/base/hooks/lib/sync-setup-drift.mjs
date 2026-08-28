// setup-github / setup-unity テンプレートの版ドリフト検知。
//
// 配備先の `.claude/sync-setup-state.json`（apply.mjs が記録した適用時のプラグイン版とフラグ）と、
// いまインストールされている project-setup プラグインの現行版を比較する。
//
// 同じ判定を 2 つの hook が使う:
//   - sync-setup-check.mjs（SessionStart）: 人の画面へ 1 行出す
//   - sync-setup-prompt.mjs（UserPromptSubmit）: 最初のプロンプトを包んで実行させる
// 判定を 2 つに写すと片方だけ直って黙ってズレるため、ここが両者の正本。
//
// 設計:
//   - 発火はアップグレード方向のみ（現行版 > 記録版）。複数マシンでプラグイン版がずれていても、
//     古い版のマシンが新しい版で同期済みのプロジェクトを古いテンプレへ巻き戻す churn を防ぐ。
//   - ここはファイルを読むだけ。ネットワーク・gh・git は sync-run.mjs 側が叩く。
//   - 状態ファイルが無いプロジェクト（未セットアップ or バックフィル前）は対象外 → null。
//   - SYNC_SETUP_DISABLE=1 で黙らせられる（避難口）。

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
/* global process, Buffer */

// 先頭 BOM（U+FEFF）を除去する。正規表現にリテラル BOM を書くと eslint の
// no-irregular-whitespace に触れるため、コードポイント比較で剥がす。
export function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

export function readJson(path) {
  try {
    return JSON.parse(stripBom(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

export async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  try {
    return JSON.parse(stripBom(Buffer.concat(chunks).toString("utf8"))) || {};
  } catch {
    return {};
  }
}

// sync-run.mjs と同じ置き場（同じ env で差し替えられる）。
export function dataDir() {
  return process.env.SYNC_SETUP_DATA_DIR || join(homedir(), ".claude", "plugins", "data", "project-setup");
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

// 状態ファイルは過去に 2 回改名しており、旧名だけが残った配備先が実在する。正名しか見ないと
// そのリポジトリは黙って「対象外」になる（エラーが出ないので誰も気づけない）ため、旧名も読む。
// **キー単位で新しい世代が勝つ**（旧名は新しい世代がまだ知らないキーだけを補う）。
// 規則の正本はプラグイン側の skills/sync-setup/state.mjs。この lib は配備先へ単体コピー
// される制約上 import できないので、意図的な重複。変えるときは両方を揃える。
function readState(claudeDir) {
  const paths = ["sync-setup-state.json", "setup-sync-state.json", ".setup-sync.json"]
    .map((name) => join(claudeDir, name))
    .filter((p) => existsSync(p));
  const state = {};
  for (const p of paths) {
    const obj = readJson(p);
    if (!obj || typeof obj !== "object") continue; // 壊れた状態ファイルは黙って無視（毎回煽らない）
    for (const [k, v] of Object.entries(obj)) if (!(k in state)) state[k] = v;
  }
  return state;
}

// インストール済み project-setup プラグインの現行版。読めなければ null。
function readCurrentVersion() {
  const pluginsJsonPath =
    process.env.SYNC_SETUP_PLUGINS_JSON ||
    join(homedir(), ".claude", "plugins", "installed_plugins.json");
  const installed = readJson(pluginsJsonPath);
  if (!installed || !installed.plugins) return null;

  // キーは "project-setup@<marketplace>"。marketplace 名は環境依存なのでプレフィックス一致で拾う。
  const key = Object.keys(installed.plugins).find((k) => /^project-setup@/.test(k));
  if (!key) return null;
  const entries = installed.plugins[key];
  if (!Array.isArray(entries) || entries.length === 0) return null;
  // 複数エントリ（scope 違い等）は最終更新が新しいものを採用。
  const entry = entries
    .slice()
    .sort((a, b) => String(b.lastUpdated || "").localeCompare(String(a.lastUpdated || "")))[0];
  let version = entry.version;
  // version が "unknown"/欠落なら installPath の plugin.json から読む。
  if (!version || version === "unknown") {
    const pj = entry.installPath && readJson(join(entry.installPath, ".claude-plugin", "plugin.json"));
    version = pj?.version;
  }
  return version || null;
}

const SKILL_KEYS = ["setup-github", "setup-unity"];

// ドリフトがあれば { currentVersion, drifted, summary } を返す。無ければ null。
export function detectDrift(projectDir) {
  if (process.env.SYNC_SETUP_DISABLE === "1") return null;

  const state = readState(join(projectDir, ".claude"));
  if (Object.keys(state).length === 0) return null; // 未セットアップ or バックフィル前 → 対象外

  const currentVersion = readCurrentVersion();
  if (!currentVersion) return null;

  const drifted = [];
  for (const k of SKILL_KEYS) {
    const rec = state[k];
    if (!rec || typeof rec !== "object" || !rec.version) continue;
    if (cmpVer(currentVersion, rec.version) > 0) {
      drifted.push({ skill: k, from: rec.version, flags: Array.isArray(rec.flags) ? rec.flags : [] });
    }
  }
  if (drifted.length === 0) return null;

  return {
    currentVersion,
    drifted,
    summary: drifted.map((d) => `${d.skill} v${d.from}→v${currentVersion}`).join(" / "),
  };
}
