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
// その場では分からない（Editor で開いて初めて参照が切れる）。よって Editor（= Unity CLI）
// 経由でしか変更させない。拡張子を足すときはここだけを直す。
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
  "DRAINING", // 新規の Editor 操作は締切。実行中のものが終わるのを待つ
  "RETURNING", // 成果を worktree へ戻している最中
  "RELEASED", // 返却済み
  "RECOVERY_REQUIRED", // 異常終了。人が検査するまで誰にも貸さない
];

// Editor 操作を許すのは ACTIVE だけ。PREPARING（checkout 途中）で許すと
// 「古いスナップショットを検証して green」が成立してしまうため、ここは緩めない。
export const EDITOR_ALLOWED_PHASES = new Set(["ACTIVE"]);

// coordinator（メインセッション）が Editor を触ってよいフェーズ。
// 切替前の静止確認と、返却時の後始末に必要な最小限だけ。
export const COORDINATOR_EDITOR_PHASES = new Set(["PREPARING", "DRAINING", "RETURNING", "RECOVERY_REQUIRED"]);

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
// Editor に届く呼び出しの判定
// ---------------------------------------------------------------------------

// Unity 操作は Unity CLI（`unity <サブコマンド>`）に固定されているので、判定対象は
// シェルコマンド文字列。ツール名だけでは Unity を触るかどうか分からない。
//
// 網羅は原理的に不可能。ここは「うっかり」を落とす網であって、意図的な回避への防壁では
// ない。何を落とせないかは references/protocol.md に書く（そちらが読者向けの正本）。

// Unity CLI のバイナリ名。Windows のランチャ拡張子まで見る（`unity.cmd test` で抜けない）。
const UNITY_BINARIES = new Set(["unity", "unity.exe", "unity.cmd", "unity.bat", "unity.ps1"]);

// サブコマンドの別名 → 正規名。`unity --help` の `|` 記法から取る。
// 別名を READONLY / EDITOR の表へ二重に並べると、片方だけ直して静かにズレる。
const SUBCOMMAND_ALIASES = new Map([
  ["cmd", "command"],
  ["pipe", "pipeline"],
  ["p", "projects"],
  ["a", "auth"],
  ["e", "editors"],
  ["i", "install"],
  ["u", "uninstall"],
  ["t", "templates"],
  ["im", "install-modules"],
  ["ip", "install-path"],
  ["collab", "collaboration"],
]);

// Editor の状態に触る（＝レーンのスナップショットを読む / 変える）サブコマンド。
// これらは借りている間だけ許す。
const EDITOR_SUBCOMMANDS = new Set([
  "command",
  "run",
  "test",
  "build",
  "open",
  "job", // detach したコマンドの状態取得・待機。投げた本人以外が触る意味がない
  "shell", // REPL の中は hook を通らない
]);

// Editor の状態も環境も変えない読み取り。借りていなくても通す
// （借り手以外が状態を見られないと、コーディネーターが順番待ちを判断できない）。
//
// 表が 2 つあるのは、族ごと安全なものと、族の中で読み取りだけを抜き出すものを
// 混ぜると事故るため。`READONLY_FAMILY` に入れてよいのは
// **その族に破壊的サブコマンドが 1 つも無い**ときだけ。
const READONLY_FAMILY = new Set([
  "status",
  "list",
  "doctor",
  "env",
  "logs",
  "changelog",
  "releases",
  "help",
]);

// 完全一致でだけ読み取り扱いにするもの。族には破壊的サブコマンドが同居している
// （`editors prune` / `license return` / `projects clean` / `command eval`）ので、
// ここへ入れたキーちょうどの形以外は Editor 操作として扱う。
const READONLY_EXACT = new Set([
  "command", // 引数なし ＝ カタログの一覧。rules が全員に発見を求めるので通す
  "pipeline list",
  "pipeline list-versions",
  "projects verify",
  "projects list",
  "projects info",
  "projects size",
  "editors list",
  "editors running",
  "editors info",
  "editors path",
  "editors verify",
  "auth status",
  "auth list",
  "license list",
  "license status",
]);

// セグメント先頭で読み飛ばす制御構文のノイズ。PowerShell の `if ($?) { ... }` や
// call operator（`& "C:\...\unity.exe"`）、bash のブロックを剥がす。
const BLOCK_NOISE = new Set(["&", "{", "}", "(", ")", "!", "then", "do", "else", "elseif", "in"]);
const CONTROL_HEADS = new Set(["if", "while", "foreach", "for", "elseif", "switch"]);

// コマンドの前に置かれるラッパー。これ自身とその後続フラグを読み飛ばして本体を見る。
const WRAPPER_HEADS = new Set([
  "sudo",
  "env",
  "nohup",
  "time",
  "timeout",
  "nice",
  "stdbuf",
  "command",
  "exec",
  "builtin",
  "xargs",
  "npx",
  "start",
  "start-process",
  "start-job",
]);

// 「次の引数はコマンド文字列」を意味するフラグ。`sh -c 'unity test'` を追うために使う。
const NESTED_COMMAND_FLAGS = new Set(["-c", "-lc", "-ic", "-command", "/c", "/k", "-encodedcommand"]);
const NESTED_COMMAND_HEADS = new Set(["invoke-expression", "iex"]);

// フラグしか付いていない `unity` 呼び出しの目印。サブコマンド名が読めない ＝ 未知。
const UNKNOWN_INVOCATION = "?";

// クォートを 1 トークンとして扱う字句分割。パスに空白がある Unity CLI
// （`"C:\Program Files\Unity CLI\unity.exe"`）を 1 語で拾うために要る。
function tokenize(segment) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(segment)) !== null) {
    const quoted = m[1] !== undefined || m[2] !== undefined;
    out.push({ text: m[1] ?? m[2] ?? m[3], quoted });
  }
  return out;
}

function basenameOf(text) {
  return String(text).replace(/^['"]|['"]$/g, "").split(/[\\/]/).pop().toLowerCase();
}

// コマンド文字列から `unity` 呼び出しのサブコマンド（正規化した最大 2 語）を拾う。
// 戻り値の各要素は "test" / "projects verify" / ""（サブコマンド無し）のいずれか。
export function unitySubcommands(command, depth = 0) {
  const out = [];
  if (depth > 2) return out; // ネストしたコマンド文字列の追跡打ち切り
  // `&` 単独（bash のバックグラウンド / PowerShell の call operator）も区切りに含める。
  // `&&` を先に並べているので 2 連は 1 つの区切りとして食われる。
  for (const seg of String(command || "").split(/&&|\|\||[;|&\n]/)) {
    const tokens = tokenize(seg.trim());
    let i = 0;
    // 先頭のノイズ（環境変数代入・制御構文・ラッパー）を剥がす
    for (;;) {
      const t = tokens[i];
      if (!t || t.quoted) break;
      const raw = t.text;
      const low = raw.toLowerCase();
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) { i++; continue; } // VAR=x
      // `($?)` `($i` `1..1)` のような括弧断片も制御構文の一部として剥がす
      if (BLOCK_NOISE.has(low) || /^[({]/.test(raw) || /[)}]$/.test(raw)) { i++; continue; }
      if (CONTROL_HEADS.has(low)) { i++; continue; }
      if (WRAPPER_HEADS.has(basenameOf(raw))) {
        i++;
        // ラッパーのフラグと、timeout の秒数のような数値引数を読み飛ばす
        while (tokens[i] && !tokens[i].quoted && (tokens[i].text.startsWith("-") || /^\d+[smhd]?$/.test(tokens[i].text))) i++;
        continue;
      }
      break;
    }
    // `sh -c '<コマンド文字列>'` / `cmd /c unity test` 系。ネストの中を再帰で見る。
    // クォート済みならそのトークンが丸ごとコマンド文字列。素の並びなら以降が全部そう。
    for (let j = 0; j < tokens.length - 1; j++) {
      const flag = tokens[j].quoted ? "" : tokens[j].text.toLowerCase();
      if (NESTED_COMMAND_FLAGS.has(flag) || NESTED_COMMAND_HEADS.has(basenameOf(tokens[j].text))) {
        const nested = tokens[j + 1].quoted
          ? tokens[j + 1].text
          : tokens.slice(j + 1).map((t) => t.text).join(" ");
        out.push(...unitySubcommands(nested, depth + 1));
      }
    }
    const head = tokens[i];
    if (!head) continue;
    if (!UNITY_BINARIES.has(basenameOf(head.text))) continue;
    // サブコマンドは**最初のフラグより前**にしか来ない。フラグ以降まで拾うと
    // `unity command --format json` の `json` をサブコマンド名と読んでしまう
    // （＝カタログ一覧が Editor 操作に化け、rules が全員に求める発見手順が塞がる）。
    const rest = tokens.slice(i + 1);
    const words = [];
    for (const t of rest) {
      if (!t.quoted && t.text.startsWith("-")) break;
      words.push(t.text.replace(/^['"]|['"]$/g, "").toLowerCase());
      if (words.length === 2) break;
    }
    if (words.length) {
      words[0] = SUBCOMMAND_ALIASES.get(words[0]) ?? words[0];
      out.push(words.join(" "));
    } else if (rest.length) {
      // フラグしか無い（`Start-Process unity -ArgumentList ...` 等）。何をするか読めないので
      // 未知扱いにして fail-closed 側へ落とす。`--version` / `--help` は先に除外済み。
      out.push(UNKNOWN_INVOCATION);
    } else {
      out.push(""); // 素の `unity`。usage を出すだけ
    }
  }
  return out;
}

// `--help` / `-h` / `--version` / `-V` はどのサブコマンドでも出力するだけ。
// 「フラグの正本は `unity <command> --help`」「前提確認は
// `unity --version`」と全員に指示しているので、常に通す。
function isInfoOnly(command) {
  return /(^|\s)(--help|-h|--version|-V)(\s|$)/.test(String(command || ""));
}

// レーンのスナップショットに触りうる `unity` 呼び出しか。
// 未知のサブコマンドは Editor 側に寄せる（fail-closed）。CLI にサブコマンドが増えたとき、
// 通してしまうより止めて気づかせるほうが安い。
export function touchesEditorViaCli(command) {
  if (isInfoOnly(command)) return false;
  return unitySubcommands(command).some((words) => {
    // サブコマンド無し（`unity` / `unity --version`）は usage・版数の出力だけ。
    if (words === "") return false;
    if (READONLY_EXACT.has(words)) return false;
    const [first] = words.split(" ");
    if (READONLY_FAMILY.has(first)) return false;
    if (EDITOR_SUBCOMMANDS.has(first)) return true;
    return true;
  });
}
