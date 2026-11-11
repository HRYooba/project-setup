// setup-* の apply.mjs が共通で使う、LLM 判断へ委ねる Markdown の扱い。
//
// 機械的な上書きはプロジェクト側で育った記述を消し、機械的なスキップはテンプレ更新を
// 永久に届かなくする。差分があるファイルは apply.mjs が書かずに「要マージ」として積み、
// SKILL 手順で Claude が現物とテンプレを読んで統合する（基準は skills/merge-contract.md）。

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/* global console */

// テンプレは「節」を配るので全文一致では判定できない。節の非空行がすべて配備先にあれば
// 反映済みとみなす。判定基準をテンプレ本体から導出するので、別途マーカー文字列を維持する
// 必要がない（文面を変えれば行が一致しなくなり、その時だけ要マージになる）。
export function sectionApplied(dstText, sectionText) {
  return sectionText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .every((l) => dstText.includes(l));
}

// 要マージの一覧と、統合の入力にする「テンプレの最終内容」の置き場をまとめて持つ。
// 入力を常に最終内容のファイルに揃えるため、置換などで加工した内容は stage() で一時ファイルへ書く。
export function createMergeQueue(stagingPrefix) {
  const items = [];
  let stagingDir = null;
  return {
    items,
    push(label, dst, src) {
      items.push({ label, dst, src });
    },
    stage(name, content) {
      stagingDir ??= mkdtempSync(join(tmpdir(), stagingPrefix));
      const p = join(stagingDir, name);
      writeFileSync(p, content, "utf8");
      return p;
    },
    // SKILL 手順はこの節を読んで統合する。見出しの文言は手順側の検出条件なので変えない。
    print() {
      if (!items.length) return;
      console.log("要マージ（apply.mjs は書いていない。Claude が現物とテンプレを読んで統合する）:");
      for (const m of items) {
        console.log(`  * ${m.label}`);
        console.log(`      現物    : ${m.dst}`);
        console.log(`      テンプレ: ${m.src}`);
      }
    },
  };
}

// CLAUDE.md へ節を配る。配備先に無ければ書き、節が反映済みなら触らず、
// それ以外は書かずに要マージへ積む。`mergeSrc` は統合の入力にするテンプレのパス
// （要マージのときだけ一時ファイルへ書き出したいなら、パスを返す関数を渡す）。
// 返り値は状態の文言（"新規作成" / "変更なし" / "要マージ"）。
export function deployClaudeMdSection(queue, { dst, section, label, mergeSrc }) {
  if (!existsSync(dst)) {
    writeFileSync(dst, section, "utf8");
    return "新規作成";
  }
  if (sectionApplied(readFileSync(dst, "utf8"), section)) return "変更なし";
  queue.push(label, dst, typeof mergeSrc === "function" ? mergeSrc() : mergeSrc);
  return "要マージ";
}
