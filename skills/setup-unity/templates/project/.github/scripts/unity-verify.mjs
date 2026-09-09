// `unity projects verify` の結果を受け取り直して GitHub の annotation として出す
// （setup-unity が配布）。検査そのものは CLI がやる。ここが変えるのは受け取り方だけで、
// `--format github` を CLI に吐かせる代わりに `--format json` を読んで自分で組み立てる。
//
// **なぜ間に入るか。** Unity は Apple のバンドル形式のフォルダ（.xcframework / .bundle /
// .framework など）を「フォルダごと 1 つのプラグイン」として取り込む。.meta が付くのは
// バンドルのフォルダ自身だけで、中身には付かない ＝ それが正しい状態。
// `unity projects verify` はこれを知らず、中の全ファイルを META_MISSING と報告する
// （実測: AVProVideo 1 つで 45 件）。CLI 側にパス除外オプションは無く（`--check` は種別を
// 絞るだけ）、warning ではなく error なので `--strict` を外しても消えない。誤報は CLI 側の
// バグで、直るまでの回避をここで持つ。
//
// **抑止リストは配布しない。** 何がバンドル形式かは配備先の Assets が持つ事実で、
// plugin 側が確かめられない。憶測で配ると、その中の本物の `.meta` 欠落を全配備先で黙って
// 隠す（この検査が守っているのは「clone した人の手元で初めて壊れる」欠陥なので、隠れると
// 誰も気づけない）。代わりに、**落ちたその場で足し方を出す** — 誤検知に当たった配備先が
// ログだけを見て自力で直せる形にしてある。
//
// CLI の exit code には頼らず findings を数え直す。解釈できない出力（CLI 自体の失敗・
// 形式変更）は素通しさせず、生の出力を出して落とす。**誤検知を消すために検査を殺さない。**

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
/* global process, console */

// 配備先が抑止したいバンドル拡張子を書くファイル。テンプレに含まれないので
// テンプレ同期に踏まれない（workflow やこのスクリプトを書き換えても同期で戻る）。
//   { "extraBundleExtensions": [".xcframework", ".bundle"] }
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

export function resolveExtensions(configText) {
  return configText == null ? [] : [...new Set(readExtraExtensions(configText))];
}

// path の「祖先」がバンドルフォルダか。末端そのものは見ない
// （バンドルのフォルダ自身の .meta 欠落は本物の指摘）。
export function insideBundleDir(path, extensions) {
  const segments = String(path).split("/").slice(0, -1);
  return segments.some((s) => extensions.some((ext) => s.toLowerCase().endsWith(ext)));
}

export function partitionFindings(findings, extensions) {
  const kept = [];
  const suppressed = [];
  for (const f of findings) {
    if (META_CODES.has(f.code) && insideBundleDir(f.path, extensions)) suppressed.push(f);
    else kept.push(f);
  }
  return { kept, suppressed };
}

// 残った .meta 指摘のうち、祖先フォルダ名に拡張子が付いているものを候補として拾う。
// **抑止はしない。** 誤検知かどうかは配備先しか判断できないので、判断材料だけ出す。
export function bundleCandidates(findings) {
  const found = new Set();
  for (const f of findings) {
    if (!META_CODES.has(f.code)) continue;
    for (const seg of String(f.path).split("/").slice(0, -1)) {
      const dot = seg.lastIndexOf(".");
      if (dot > 0 && /^\.[A-Za-z0-9]+$/.test(seg.slice(dot))) found.add(seg.slice(dot).toLowerCase());
    }
  }
  return [...found].sort();
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

// 誤検知に当たった配備先が、ログだけを見て自力で直せるようにする。
// doc を読ませる前提にしない（読まれないまま「.meta を作って commit」へ行くと実害が出る）。
function printBundleHint(candidates) {
  console.log("");
  console.log(`注意: 中身が .meta を持たない「バンドル形式」フォルダかもしれません: ${candidates.join(" / ")}`);
  console.log("  Unity は Apple のバンドル形式（.xcframework / .bundle / .framework など）を");
  console.log("  フォルダごと 1 プラグインとして取り込むため、.meta が付くのはフォルダ自身だけで");
  console.log("  中身には付きません。それが正常な状態で、CLI の報告が誤りです。");
  console.log("  確認のしかた: そのフォルダ自身の .meta が在り、中に .meta が 1 つも無ければバンドル。");
  console.log("  （拡張子が付いただけの普通のフォルダを足さないこと。中の欠落を隠してしまう）");
  console.log(`  確認できたら ${CONFIG_PATH} に足してください:`);
  console.log(`    { "extraBundleExtensions": [${candidates.map((c) => `"${c}"`).join(", ")}] }`);
  console.log("  **中に .meta を作って commit してはいけません**（誤りを固定します）。");
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

  if (extensions.length) console.log(`${CONFIG_PATH} の抑止対象: ${extensions.join(" / ")}`);
  const { kept, suppressed } = partitionFindings(data.findings, extensions);
  let failed = false;
  for (const f of kept) failed = annotate(f, strict) || failed;

  if (suppressed.length) {
    const dirs = [...new Set(suppressed.map((f) => f.path.replace(/\/[^/]*$/, "")))].length;
    console.log(`バンドルフォルダ内の .meta 指摘 ${suppressed.length} 件を抑止しました（${dirs} 箇所）。`);
  }
  console.log(failed ? `整合性エラー ${kept.length} 件。` : "整合性の問題はありません。");

  const candidates = bundleCandidates(kept).filter((c) => !extensions.includes(c));
  if (failed && candidates.length) printBundleHint(candidates);
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  process.exit(main(process.argv.slice(2)));
}
