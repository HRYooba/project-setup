// after-pr-create.mjs が使う「レビュー対象ファイル」の定義。
//
// レビュー対象 = REVIEW_TARGETS 配下（指定時のみ） AND REVIEW_EXCLUDES 外（除外が最優先）
//                AND（コード拡張子 OR 拡張子なし）。
//   - コード拡張子（REVIEWABLE_EXTS）: レビュー対象とみなす拡張子の集合。
//   - 拡張子なし（Makefile / Dockerfile / git hook 等の手書きスクリプト）: 対象扱い
//     （fail-closed。素通りさせない。LICENSE 等が稀に引っかかる副作用は許容）。
//   - シリアライズされた非コード（.unity/.prefab/.asset 等）は集合に無い＝対象外。
//
// レビュー対象/除外フォルダは同ディレクトリの review-config.json から読む（setup-github の
// apply.mjs が生成・更新する）。config が無い/壊れているときは安全なデフォルトへ倒す。
//
// この定義は Copilot 自動アサイン（after-pr-create.mjs）の対象判定に使う唯一のソース。
// 判定を分散させると「Copilot は付くのに別基準では対象外」といった食い違いが生じるため、
// レビュー対象の定義は必ずこの 1 箇所だけを編集すること。

import { execFileSync } from "node:child_process";
import { readFileSync as fsReadFileSync } from "node:fs";
/* global process, Buffer, URL */

// レビュー対象/除外フォルダの既定値。config が読めないときのフォールバック。
//   targets 空 = 全フォルダ対象。excludes 既定 = ツール設定系（setup-github の導入 PR を素通し）。
const DEFAULT_TARGETS = [];
const DEFAULT_EXCLUDES = [".claude/", ".github/", ".githooks/"];

// review-config.json（.claude/hooks/review-config.json）を読む。
// 形式: { "reviewTargets": [...], "reviewExcludes": [...] }。
// 読めない/壊れているときはデフォルトへ（判定を壊すより素通り側の安全性を優先）。
function loadConfig() {
  try {
    const url = new URL("../review-config.json", import.meta.url);
    const raw = fsReadFileSync(url, "utf8");
    const cfg = JSON.parse(raw);
    return {
      targets: Array.isArray(cfg.reviewTargets) ? cfg.reviewTargets : DEFAULT_TARGETS,
      excludes: Array.isArray(cfg.reviewExcludes) ? cfg.reviewExcludes : DEFAULT_EXCLUDES,
    };
  } catch {
    return { targets: DEFAULT_TARGETS, excludes: DEFAULT_EXCLUDES };
  }
}

// エントリを正規化する（\ 区切り・./ 前置・末尾スラッシュ欠落といった手編集のゆらぎを吸収）。
// エントリが不正な形だと全ファイルが対象外＝判定が無音で無効化されるため、処理を壊す
// エラー throw ではなく正規化で救う。
const normalizeEntries = (entries) =>
  entries
    .map((t) =>
      String(t).replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "")
    )
    .filter((t) => t !== "")
    .map((t) => `${t}/`);

const CONFIG = loadConfig();
const NORMALIZED_TARGETS = normalizeEntries(CONFIG.targets);
const NORMALIZED_EXCLUDES = normalizeEntries(CONFIG.excludes);

// gh pr create「試行」の検出用（after-pr-create の PR 検出が使う唯一の定義）。
// コマンド段の先頭でだけ一致させ、grep/echo/printf 等が引数として "gh pr create" を
// 含むだけの行を誤検出しない。捕捉する形:
//   行頭 / 区切り(; | & 改行 () の直後、任意の環境変数プレフィックス（VAR=x / VAR="a b"）、
//   任意の `command `、任意のパス（/usr/bin/ 等）に続く gh pr create。
//   サブシェル `(gh …)`・コマンド置換 `$(gh …)`・バックグラウンド `& gh …` も ( と & で捕捉。
export const PR_CREATE_ATTEMPT_RE =
  /(?:^|[;|&\n(])\s*(?:\w+=(?:"[^"]*"|'[^']*'|\S*)\s+)*(?:command\s+)?(?:\S*\/)?gh\s+pr\s+create\b/;

// git が出力するパスの C 風クォートを復号する（クォートされていなければそのまま返す）。
// core.quotepath 既定では非 ASCII を含むパスが "src/\346\227\245....ts" のように
// 前後ダブルクォート＋ 8 進エスケープで出力される。これを剥がさないと拡張子判定と
// REVIEW_TARGETS 前方一致の両方が外れ、レビュー対象なのに素通り（fail-open）する。
function dequoteGitPath(path) {
  const s = String(path);
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s;
  const inner = s.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] !== "\\") {
      bytes.push(inner.charCodeAt(i));
      continue;
    }
    const oct = inner.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)?.[0];
    if (oct) {
      bytes.push(parseInt(oct, 8)); // UTF-8 バイト列の 8 進表現
      i += oct.length;
    } else {
      const esc = { t: 9, n: 10, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 };
      bytes.push(esc[inner[i + 1]] ?? inner.charCodeAt(i + 1));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

// パスの正規化（git クォート復号 + 区切りの統一）。判定前に必ず 1 度だけ通すこと。
function normalizePath(path) {
  return dequoteGitPath(path).replace(/\\/g, "/").replace(/^\.\//, "");
}

// 正規化済みパスが REVIEW_TARGETS 配下か（未指定なら常に true）。
// 引数は normalizePath 済みであること（二重復号を避けるため内部でも再正規化しない）。
function inReviewTargets(normalized) {
  if (NORMALIZED_TARGETS.length === 0) return true;
  return NORMALIZED_TARGETS.some((t) => normalized.startsWith(t));
}

// レビュー対象拡張子（小文字・ドット無し）。Shader Graph(.shadergraph 等)/VFX(.vfx)/
// シーン(.unity/.prefab)/asmdef 等の "シリアライズされてレビュー不可" な Unity 固有
// ファイルは意図的に含めない。ロジックを含むコードとマークアップ/スタイル/シェルを対象にする。
const REVIEWABLE_EXTS = new Set([
  // C#
  "cs",
  // Web / TS / JS（ロジック）
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "svelte",
  // Python（ロジック）
  "py",
  // 汎用言語（他スタックのリポジトリでも判定を揃える）
  "go", "rs", "java", "kt", "kts", "cpp", "cc", "cxx", "c", "h", "hpp", "hh",
  "rb", "php", "swift", "scala", "sql", "lua", "dart", "ex", "exs", "clj", "m", "mm",
  // シェーダ（手書きコード。Graph 系は除外）
  "shader", "cginc", "hlsl", "hlslinc", "compute", "glslinc", "raytrace",
  // GLSL（TouchDesigner 外部 DAT 含む）
  "glsl", "vert", "frag", "geom", "comp", "tesc", "tese", "vs", "fs",
  // マークアップ / スタイル
  "html", "css", "uxml", "uss", "tss",
  // シェルスクリプト
  "ps1", "psm1", "sh", "bash", "bat", "cmd",
]);

// 末尾の拡張子（小文字・ドット無し）。無ければ null。
function extOf(path) {
  const m = path.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : null;
}

// ファイル 1 つがレビュー対象か。REVIEW_EXCLUDES 配下は常に対象外、REVIEW_TARGETS 指定時は
// 配下のファイルだけが対象。既知のコード拡張子は対象、未知拡張子は対象外、拡張子なしは対象
// （fail-closed）。git のクォート付きパスもここで 1 度だけ正規化する（呼び出し側は raw のまま
// 渡してよい）。
export function isReviewableFile(path) {
  const p = normalizePath(path);
  if (NORMALIZED_EXCLUDES.some((t) => p.startsWith(t))) return false;
  if (!inReviewTargets(p)) return false;
  const e = extOf(p);
  if (e !== null) return REVIEWABLE_EXTS.has(e);
  return true;
}

// hook 共通: stdin を全読みして文字列で返す。失敗時は空文字。
export function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(""));
  });
}

// hook 共通: 外部コマンドをシェル非経由で実行し trim した stdout を返す。失敗時は null。
export function execTrim(bin, args) {
  try {
    return execFileSync(bin, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}
