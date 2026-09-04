// analyzer ソースの内容ハッシュ。build.mjs（記録側）と tests（検証側）の両方が使う。
//
// ここを単一の出所にしておかないと、「ビルドし忘れの検知」が検知側の写し間違いで
// 黙って無効化される。ハッシュの対象と正規化は必ずこのファイルだけが決める。

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** analyzer の C# ソースと規則 ID 台帳が置かれたディレクトリ。 */
export const ANALYZER_SRC_DIR = join(here, "src", "UnityCodingStandards.Analyzers");

/** 配布 DLL の生成元を表すハッシュ。csproj も含める（参照 Roslyn の版で挙動が変わるため）。 */
export function hashAnalyzerSources() {
  const files = walk(ANALYZER_SRC_DIR)
    .filter((p) => /\.(cs|csproj|md)$/.test(p))
    .filter((p) => !p.split(sep).includes("bin") && !p.split(sep).includes("obj"))
    .sort((a, b) => rel(a).localeCompare(rel(b)));

  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(rel(file));
    hash.update("\0");
    // 改行だけの差でハッシュが変わらないよう正規化する（.gitattributes は eol=lf だが、
    // 作業ツリーの状態に依存させない）。
    hash.update(readFileSync(file).toString("utf8").replace(/\r\n/g, "\n"));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function rel(file) {
  return relative(ANALYZER_SRC_DIR, file).split(sep).join("/");
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
