// pr-code-review-gate.mjs と after-pr-create.mjs が共有する「レビュー対象ファイル」の定義。
//
// なぜ共有するか: gate（PR 作成ブロック）と Copilot 自動依頼が別々の判定基準を
// 持つと、「gate は要求するのに Copilot は付かない」「Copilot は付くのに gate は素通り」
// という政策の食い違いが生じる。定義は必ずこの 1 箇所だけを編集すること。
//
// レビュー対象 = REVIEW_TARGETS 配下（指定時のみ） AND REVIEW_EXCLUDES 外（除外が最優先）
//                AND（コード拡張子 OR 拡張子なし）。
//   - コード拡張子（EXT_BASE）: 種別ごとの base effort。
//   - 拡張子なし（Makefile / Dockerfile / git hook 等の手書きスクリプト）: medium 扱い
//     （fail-closed。素通りさせない。LICENSE 等が稀に medium で引っかかる副作用は許容）。
//   - シリアライズされた非コード（.unity/.prefab/.asset 等）は EXT_BASE に無い＝対象外。
//
// レビュー対象/除外フォルダは同ディレクトリの review-config.json から読む（setup-github の
// apply.mjs が生成・更新する）。config が無い/壊れているときは安全なデフォルトへ倒す。

import { execFileSync } from "node:child_process";
import { readFileSync as fsReadFileSync } from "node:fs";
/* global process, Buffer, URL */

// レビュー対象/除外フォルダの既定値。config が読めないときのフォールバック。
//   targets 空 = 全フォルダ対象。excludes 既定 = ツール設定系（setup-github の導入 PR を素通し）。
const DEFAULT_TARGETS = [];
const DEFAULT_EXCLUDES = [".claude/", ".github/", ".githooks/"];

// review-config.json（.claude/hooks/review-config.json）を読む。
// 形式: { "reviewTargets": [...], "reviewExcludes": [...] }。
// 読めない/壊れているときはデフォルトへ（gate を壊すより素通り側の安全性を優先）。
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
// エントリが不正な形だと全ファイルが対象外＝gate が無音で無効化されるため、hook を壊す
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

// gh pr create「試行」の検出用（gate の anchor 計算・エントリ判定、after-pr-create の
// PR 検出が共有する唯一の定義）。コマンド段の先頭でだけ一致させ、grep/echo/printf 等が
// 引数として "gh pr create" を含むだけの行を誤検出しない。捕捉する形:
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

// effort ランク。数値が大きいほど厚いレビュー。ultra はクラウド手動実行の最上位
//（自動推奨の上限は max。ultra はラダーの定義として載せているだけで、自動判定では使わない）。
export const EFFORT_RANK = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4, ultra: 5 };

// ランク値 → ラベル名。EFFORT_RANK から導出する（手書きの並行配列を持たない）。
export const RANK_LABEL = Object.entries(EFFORT_RANK)
  .sort((a, b) => a[1] - b[1])
  .map(([k]) => k);

// レビュー対象拡張子（小文字・ドット無し）→ 種別ごとの base effort ランク。
// Shader Graph(.shadergraph 等)/VFX(.vfx)/シーン(.unity/.prefab)/asmdef 等の
// "シリアライズされてレビュー不可" な Unity 固有ファイルは意図的に含めない。
//   high  : ロジックを含むコード
//   medium: マークアップ・スタイル・シェルスクリプト（ロジック密度が低い）
const EXT_BASE = new Map([
  // C# — high
  ["cs", EFFORT_RANK.high],
  // Web / TS / JS（ロジック）— high
  ["ts", EFFORT_RANK.high], ["tsx", EFFORT_RANK.high],
  ["js", EFFORT_RANK.high], ["jsx", EFFORT_RANK.high],
  ["mjs", EFFORT_RANK.high], ["cjs", EFFORT_RANK.high],
  ["vue", EFFORT_RANK.high], ["svelte", EFFORT_RANK.high],
  // Python（ロジック）— high
  ["py", EFFORT_RANK.high],
  // 汎用言語（他スタックのリポジトリでも gate と Copilot の判定を揃える）— high
  ["go", EFFORT_RANK.high], ["rs", EFFORT_RANK.high],
  ["java", EFFORT_RANK.high], ["kt", EFFORT_RANK.high], ["kts", EFFORT_RANK.high],
  ["cpp", EFFORT_RANK.high], ["cc", EFFORT_RANK.high], ["cxx", EFFORT_RANK.high],
  ["c", EFFORT_RANK.high], ["h", EFFORT_RANK.high],
  ["hpp", EFFORT_RANK.high], ["hh", EFFORT_RANK.high],
  ["rb", EFFORT_RANK.high], ["php", EFFORT_RANK.high],
  ["swift", EFFORT_RANK.high], ["scala", EFFORT_RANK.high],
  ["sql", EFFORT_RANK.high], ["lua", EFFORT_RANK.high], ["dart", EFFORT_RANK.high],
  ["ex", EFFORT_RANK.high], ["exs", EFFORT_RANK.high], ["clj", EFFORT_RANK.high],
  ["m", EFFORT_RANK.high], ["mm", EFFORT_RANK.high],
  // シェーダ（手書きコード。Graph 系は除外）— high
  ["shader", EFFORT_RANK.high], ["cginc", EFFORT_RANK.high],
  ["hlsl", EFFORT_RANK.high], ["hlslinc", EFFORT_RANK.high],
  ["compute", EFFORT_RANK.high], ["glslinc", EFFORT_RANK.high],
  ["raytrace", EFFORT_RANK.high],
  // GLSL（TouchDesigner 外部 DAT 含む）— high
  ["glsl", EFFORT_RANK.high], ["vert", EFFORT_RANK.high],
  ["frag", EFFORT_RANK.high], ["geom", EFFORT_RANK.high],
  ["comp", EFFORT_RANK.high], ["tesc", EFFORT_RANK.high],
  ["tese", EFFORT_RANK.high], ["vs", EFFORT_RANK.high],
  ["fs", EFFORT_RANK.high],
  // マークアップ / スタイル — medium
  ["html", EFFORT_RANK.medium], ["css", EFFORT_RANK.medium],
  ["uxml", EFFORT_RANK.medium], ["uss", EFFORT_RANK.medium],
  ["tss", EFFORT_RANK.medium],
  // シェルスクリプト — medium
  ["ps1", EFFORT_RANK.medium], ["psm1", EFFORT_RANK.medium],
  ["sh", EFFORT_RANK.medium], ["bash", EFFORT_RANK.medium],
  ["bat", EFFORT_RANK.medium], ["cmd", EFFORT_RANK.medium],
]);

// 末尾の拡張子（小文字・ドット無し）。無ければ null。
function extOf(path) {
  const m = path.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : null;
}

// ファイル 1 つの base effort ランク。レビュー対象外なら undefined。
// REVIEW_EXCLUDES 配下は常に対象外、REVIEW_TARGETS 指定時は配下のファイルだけが対象
// （全消費者に一括で効く唯一の関門）。git のクォート付きパスもここで 1 度だけ正規化する
// （呼び出し側は raw のまま渡してよい）。拡張子なしは medium（fail-closed）。
export function rankOf(path) {
  const p = normalizePath(path);
  if (NORMALIZED_EXCLUDES.some((t) => p.startsWith(t))) return undefined;
  if (!inReviewTargets(p)) return undefined;
  const e = extOf(p);
  if (e !== null) return EXT_BASE.get(e);
  return EFFORT_RANK.medium;
}

export function isReviewableFile(path) {
  return rankOf(path) !== undefined;
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
