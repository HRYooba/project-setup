// 無人同期の経路にある子プロセス起動すべてに windowsHide が付いていることを保証する。
//
// なぜテストにするか: 付け忘れても Windows 以外では何も起きず、Windows でも「ウィンドウが出る」
// という画面上の症状にしかならない。ユニットテストで振る舞いを検証できないため、
// **呼び出し側にオプションが書かれていること**をソース上で見張る。
//
// 背景: sync-launch.mjs は SessionStart hook から detached で起動されるためコンソールを持たない。
// Windows ではコンソールを持たない親から起動されたコンソールアプリ（git / gh / claude.exe /
// node）が新しいコンソールウィンドウを確保して画面に出る。裏で走るはずの Claude が
// ターミナルウィンドウを開いて数分居座る、git 呼び出しのたびに黒い窓が点滅する、という形で出る。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// 無人経路で動くスクリプト。ここに載っているファイルの子プロセス起動は必ず隠す。
const FILES = [
  "skills/setup-sync/sync-launch.mjs",
  "skills/setup-sync/sync-run.mjs",
  "skills/setup-github/apply.mjs",
  "skills/setup-github/templates/base/hooks/setup-sync-check.mjs",
];

// 子プロセスを起こす API 呼び出しの位置を拾う。
const SPAWNERS = /\b(execFileSync|execFile|spawnSync|spawn|execSync|exec)\s*\(/g;

for (const rel of FILES) {
  test(`${rel}: 子プロセス起動はすべて windowsHide で隠す`, () => {
    const src = readFileSync(join(root, rel), "utf8");
    const lines = src.split(/\r?\n/);
    const offenders = [];

    for (const m of src.matchAll(SPAWNERS)) {
      // import 文の中の識別子は呼び出しではない。
      const lineNo = src.slice(0, m.index).split(/\r?\n/).length;
      if (/^\s*import\b/.test(lines[lineNo - 1])) continue;

      // 呼び出しの引数リスト全体（対応する閉じ括弧まで）を取り出して調べる。
      let depth = 0;
      let end = m.index + m[0].length - 1;
      for (; end < src.length; end++) {
        if (src[end] === "(") depth++;
        else if (src[end] === ")") {
          depth--;
          if (depth === 0) break;
        }
      }
      const call = src.slice(m.index, end + 1);
      // 直接書かれているか、共通オプション（HIDDEN）を展開しているか。
      if (!/windowsHide|\.\.\.HIDDEN/.test(call)) {
        offenders.push(`${rel}:${lineNo} ${m[1]}(...)`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `windowsHide の無い子プロセス起動があります（detached 実行時に窓が出ます）:\n  ${offenders.join("\n  ")}`
    );
  });
}

test("HIDDEN の定義そのものが windowsHide: true であること", () => {
  for (const rel of FILES) {
    const src = readFileSync(join(root, rel), "utf8");
    if (!/\.\.\.HIDDEN/.test(src)) continue;
    assert.match(
      src,
      /const HIDDEN = \{ windowsHide: true \};/,
      `${rel}: HIDDEN を使っているのに定義が windowsHide: true ではありません`
    );
  }
});
