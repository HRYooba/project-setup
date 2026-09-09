// `unity projects verify` の結果から、Unity が構造的に .meta を作らない場所の指摘だけを
// 落として GitHub の annotation として出す（setup-unity が配布）。
//
// **なぜラッパーが要るか。** Unity は Apple のバンドル形式のフォルダ（.xcframework /
// .bundle / .framework など）を「フォルダごと 1 つのプラグイン」として取り込む。.meta が
// 付くのはバンドルのフォルダ自身だけで、中身には付かない ＝ それが正しい状態。
// `unity projects verify` はこれを知らず、中の全ファイルを META_MISSING と報告する
// （実測: AVProVideo 1 つで 45 件）。CLI 側にパス除外オプションは無く（`--check` は種別を
// 絞るだけ）、warning ではなく error なので `--strict` を外しても消えない。
//
// **落とすのは .meta の 2 種類だけ。** CONFLICT_MARKERS や GUID_DUPLICATE は
// バンドルの中にあっても本物の事故なので通す。バンドルのフォルダ自身の .meta 欠落も通す
// （そこは Unity が本当に要求する）。
//
// CLI の exit code には頼らず findings を数え直す。解釈できない出力（CLI 自体の失敗・
// 形式変更）は素通しさせず、生の出力を出して落とす。**誤検知を消すために検査を殺さない。**
//
// リストに無い形式に当たったら .github/unity-verify.config.json で足せる（下記 CONFIG_PATH）。
// 足りないぶんはテンプレ側へも直す価値があるので、使ったら project-setup へ知らせてほしい。

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
/* global process, console */

// Unity の PluginImporter がフォルダごと 1 アセットとして取り込む拡張子。
// 中身に .meta は生成されない。
const BUNDLE_DIR_EXTENSIONS = [
  ".androidlib",
  ".app",
  ".bundle",
  ".framework",
  ".plugin",
  ".xcframework",
];

// **配備先がここへ足せる逃げ道。** この workflow とスクリプトはテンプレ配布物なので、
// プロジェクト側で書き換えても次のテンプレ同期で戻る。上のリストに無い形式に当たった
// 配備先が自力で直せないと、PR ゲートが恒久的に赤で塞がる（テンプレ更新を待つしかない）。
// この設定ファイルはテンプレに含まれないので同期に踏まれない。
//   .github/unity-verify.config.json
//   { "extraBundleExtensions": [".xcframework"] }
// **足すだけで、組み込みリストは無効化できない**（検査を殺す口を作らない）。
const CONFIG_PATH = ".github/unity-verify.config.json";

const META_CODES = new Set(["META_MISSING", "META_ORPHAN"]);

// 設定ファイルの読み込み。壊れていたら黙って無視せず投げる
// （無視すると、書いたつもりの拡張子が効いていない状態が緑で通り続ける）。
export function readExtraExtensions(text) {
  const parsed = JSON.parse(text);
  const list = parsed?.extraBundleExtensions;
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error("extraBundleExtensions は文字列の配列です。");
  return list.map((e) => {
    if (typeof e !== "string" || !/^\.[A-Za-z0-9]+$/.test(e)) {
      throw new Error(`拡張子は先頭がドットの文字列です: ${JSON.stringify(e)}`);
    }
    return e.toLowerCase();
  });
}

// 実際に使う抑止リスト。**組み込みリストへの追加しかできない**のがここの不変条件
// （設定で置き換えられると、配備先が検査を静かに無効化できてしまう）。
export function resolveExtensions(configText) {
  if (configText == null) return [...BUNDLE_DIR_EXTENSIONS];
  return [...new Set([...BUNDLE_DIR_EXTENSIONS, ...readExtraExtensions(configText)])];
}

// path の「祖先」にバンドルフォルダがあるか。末端そのものは見ない
// （バンドルのフォルダ自身の .meta 欠落は本物の指摘）。
export function insideBundleDir(path, extensions = BUNDLE_DIR_EXTENSIONS) {
  const segments = String(path).split("/").slice(0, -1);
  return segments.some((s) => extensions.some((ext) => s.toLowerCase().endsWith(ext)));
}

export function partitionFindings(findings, extensions = BUNDLE_DIR_EXTENSIONS) {
  const kept = [];
  const suppressed = [];
  for (const f of findings) {
    if (META_CODES.has(f.code) && insideBundleDir(f.path, extensions)) suppressed.push(f);
    else kept.push(f);
  }
  return { kept, suppressed };
}

function annotate(finding, strict) {
  const level = finding.severity === "error" || strict ? "error" : "warning";
  const where = [`file=${finding.path}`, finding.line ? `line=${finding.line}` : null]
    .filter(Boolean)
    .join(",");
  // annotation の本文に改行は入れられない（そこで切れる）。
  const message = `${finding.code}: ${String(finding.message || "").replace(/\s*\n\s*/g, " ")}`;
  console.log(`::${level} ${where}::${message}`);
  return level === "error";
}

function main(argv) {
  const strict = argv.includes("--strict");
  let extensions;
  try {
    extensions = resolveExtensions(existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : null);
  } catch (e) {
    console.error(`${CONFIG_PATH} を読めませんでした: ${e.message}`);
    return 1;
  }
  const extra = extensions.filter((e) => !BUNDLE_DIR_EXTENSIONS.includes(e));
  // 何が効いているかをログに出す。抑止範囲は黙って広げない。
  if (extra.length) console.log(`${CONFIG_PATH} からバンドル拡張子を追加: ${extra.join(" / ")}`);
  const res = spawnSync(
    "unity",
    ["projects", "verify", ...argv, "--format", "json", "--non-interactive", "--no-banner"],
    { encoding: "utf8", shell: process.platform === "win32" }
  );
  if (res.error) {
    console.error(`unity CLI を起動できませんでした: ${res.error.message}`);
    return 1;
  }

  let data;
  try {
    data = JSON.parse(res.stdout).data;
  } catch {
    data = null;
  }
  if (!data || !Array.isArray(data.findings)) {
    // 形式が変わった／CLI 自体が失敗した。判定不能を「異常なし」にはしない。
    console.error("unity projects verify の出力を解釈できませんでした。生の出力を出します。");
    console.error(res.stdout.trim());
    if (res.stderr.trim()) console.error(res.stderr.trim());
    return res.status === 0 ? 1 : res.status;
  }

  const { kept, suppressed } = partitionFindings(data.findings, extensions);
  let failed = false;
  for (const f of kept) failed = annotate(f, strict) || failed;

  if (suppressed.length) {
    const dirs = [...new Set(suppressed.map((f) => f.path.replace(/\/[^/]*$/, "")))].length;
    console.log(
      `バンドルフォルダ内の .meta 指摘 ${suppressed.length} 件を抑止しました（${dirs} 箇所。` +
        `${extensions.join(" / ")} の中身に .meta は付かない）。`
    );
  }
  console.log(failed ? `整合性エラー ${kept.length} 件。` : "整合性の問題はありません。");
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  process.exit(main(process.argv.slice(2)));
}
