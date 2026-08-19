// unity-parallel の共有プロトコル定義。
//
// lane.mjs（coordinator CLI）と guard.mjs（PreToolUse hook）が同じ定義を読むための単一ソース。
// 状態遷移・禁止拡張子・パス解決・state 入出力はここにだけ書く（片方だけ直して静かにズレるのを防ぐ）。
//
// 依存なし（Node 標準のみ）。

import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
/* global process */

export const STATE_VERSION = 1;

// ---------------------------------------------------------------------------
// 禁止拡張子
// ---------------------------------------------------------------------------

// Unity がシリアライズするファイル。手編集は GUID / fileID を壊し、しかも壊れたことが
// その場では分からない（Editor で開いて初めて参照が切れる）。よって Editor（= MCP）経由
// でしか変更させない。拡張子を足すときはここだけを直す。
export const UNITY_SERIALIZED_EXT = [
  ".meta",
  ".unity",
  ".prefab",
  ".asset",
  ".mat",
  ".anim",
  ".controller",
  ".overrideController",
  ".physicMaterial",
  ".physicsMaterial2D",
  ".renderTexture",
  ".cubemap",
  ".flare",
  ".mixer",
  ".playable",
  ".signal",
  ".mask",
  ".preset",
  ".terrainlayer",
  ".spriteatlas",
  ".spriteatlasv2",
  ".guiskin",
  ".fontsettings",
  ".shadervariants",
  ".lighting",
  ".giparams",
  ".brush",
];

export function isUnitySerialized(filePath) {
  const lower = String(filePath || "").toLowerCase();
  return UNITY_SERIALIZED_EXT.some((ext) => lower.endsWith(ext.toLowerCase()));
}

// ---------------------------------------------------------------------------
// フェーズ
// ---------------------------------------------------------------------------

export const PHASES = [
  "QUEUED", // キュー待ち。Editor は他人のもの
  "PREPARING", // トークンは渡ったが Editor はまだ切り替え中
  "ACTIVE", // Editor がこの保持者の commit を指している
  "DRAINING", // 新規 MCP 呼び出しは締切。実行中のものが終わるのを待つ
  "RETURNING", // 成果を worktree へ戻している最中
  "RELEASED", // 返却済み
  "RECOVERY_REQUIRED", // 異常終了。人が検査するまで誰にも貸さない
];

// Unity MCP を許すのは ACTIVE だけ。PREPARING（checkout 途中）で許すと
// 「古いスナップショットを検証して green」が成立してしまうため、ここは緩めない。
export const MCP_ALLOWED_PHASES = new Set(["ACTIVE"]);

// coordinator（メインセッション）が Editor を触ってよいフェーズ。
// 切替前の静止確認と、返却時の後始末に必要な最小限だけ。
export const COORDINATOR_MCP_PHASES = new Set(["PREPARING", "DRAINING", "RETURNING", "RECOVERY_REQUIRED"]);

// リース期限。Unity の初回インポートが長いので余裕を持たせる。
// 期限切れでも自動剥奪はしない（RECOVERY_REQUIRED へ落として人の判断を待つ）。
export const LEASE_MS = 45 * 60 * 1000;

// ---------------------------------------------------------------------------
// パス解決
// ---------------------------------------------------------------------------

export function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// 状態は worktree ごとではなくリポジトリ共有の場所に置く。
// checkout で切り替わらず、どの worktree から見ても同じ実体を指す必要があるため
// （--git-common-dir は worktree からでも本体の .git を返す）。
export function laneStateDir(cwd = process.cwd()) {
  const common = git(["rev-parse", "--git-common-dir"], cwd);
  return join(resolve(cwd, common), "unity-parallel");
}

export function ensureStateDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function statePath(dir) {
  return join(dir, "state.json");
}

export function journalPath(dir) {
  return join(dir, "journal.jsonl");
}

// パスの内外判定。Windows の大文字小文字と区切り文字の揺れを吸収する。
export function pathInside(child, parent) {
  const norm = (p) => resolve(String(p)).replace(/[\\/]+$/, "").toLowerCase();
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p + sep.toLowerCase()) || c.startsWith(p + "/");
}

// ---------------------------------------------------------------------------
// state 入出力
// ---------------------------------------------------------------------------

export function emptyState(lanePath) {
  return {
    version: STATE_VERSION,
    lanePath: resolve(lanePath),
    generation: 0,
    holder: null,
    queue: [],
    // worktree ごとの「最後に Editor へ載せて承認された commit」。
    // 2 回目以降の差分検査はここを基準にする（初回 base に戻すと承認済みの差分を再検査してしまう）。
    approvedSnapshots: {},
    recovery: null,
  };
}

export function readState(dir) {
  const p = statePath(dir);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, "utf8");
  const parsed = JSON.parse(raw); // 壊れていれば投げる。呼び出し側が fail-closed で扱う
  if (parsed.version !== STATE_VERSION) {
    throw new Error(`state.json の version が想定外です: ${parsed.version}（想定 ${STATE_VERSION}）`);
  }
  return parsed;
}

export function writeState(dir, state) {
  const p = statePath(dir);
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  // 書いてから rename する。同一ボリューム上の rename は原子的なので、
  // 読み手（guard は毎ツール呼び出しで読む）が半分書けたファイルを見ることがない。
  renameSync(tmp, p);
}

// クラッシュ復旧用の追記ログ。state.json は「今」を、journal は「何が起きたか」を持つ。
export function appendJournal(dir, entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n";
  try {
    mkdirSync(dirname(journalPath(dir)), { recursive: true });
    writeFileSync(journalPath(dir), line, { encoding: "utf8", flag: "a" });
  } catch {
    // journal はあくまで診断用。書けなくても本処理は止めない
  }
}

// ---------------------------------------------------------------------------
// state ミューテックス
// ---------------------------------------------------------------------------

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// state.json の read-modify-write を保護する短命ロック。
// 「存在確認してから書く」だと 2 プロセスが同時に通るため、原子的な排他生成（wx）を使う。
export function withStateLock(dir, fn, { retries = 200, waitMs = 50 } = {}) {
  const lock = join(dir, "state.lock");
  let fd = null;
  for (let i = 0; i < retries; i++) {
    try {
      fd = openSync(lock, "wx");
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      sleepSync(waitMs);
    }
  }
  if (fd === null) {
    throw new Error(`state ロックを取得できません: ${lock}\n残留している場合は中の状態を確認してから削除する（lane.mjs doctor）。`);
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    rmSync(lock, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Unity MCP のツール名判定
// ---------------------------------------------------------------------------

// どの MCP サーバーが Unity かは実装ごとに違う。setup-unity が配る
// rules/unity-mcp.md にはバインディング表の core 節（実際の呼び出し例）が合成されている
// ので、そこに現れる mcp__<server>__ を正本として抽出する。
// サーバー名の一覧を guard 側に書き写すと、バインディングを足したときに黙って古くなる。
export function unityMcpPrefixes(projectDir) {
  const rulePath = join(projectDir, ".claude", "rules", "unity-mcp.md");
  if (!existsSync(rulePath)) return null;
  const text = readFileSync(rulePath, "utf8");
  const found = new Set();
  for (const m of text.matchAll(/mcp__([A-Za-z0-9_.-]+)__/g)) found.add(`mcp__${m[1]}__`);
  return found.size ? [...found] : null;
}

// 抽出できなかったときの保険。無関係な MCP サーバー（Slack 等）まで巻き込まないよう、
// 名前に unity を含むものだけを Unity 扱いにする。
export function looksLikeUnityTool(toolName) {
  return /^mcp__[^_]*unity[^_]*__/i.test(String(toolName || ""));
}

export function isUnityMcpTool(toolName, prefixes) {
  const name = String(toolName || "");
  if (!name.startsWith("mcp__")) return false;
  if (prefixes && prefixes.length) return prefixes.some((p) => name.startsWith(p));
  return looksLikeUnityTool(name);
}
