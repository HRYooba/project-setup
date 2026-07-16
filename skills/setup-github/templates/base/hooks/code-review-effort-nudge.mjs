// PreToolUse hook: Claude 発の code-review 起動（Skill / SlashCommand ツール）に effort
// 引数が無ければ deny し、gate の --required 照会が算出した推奨 effort を差し戻す nudge。
//
// 背景: PR 作成 gate（pr-code-review-gate.mjs）は「実行の有無」だけを判定し、effort を
// 強制しない（強制すると再レビュー自己増幅ループが起きる。経緯は gate 冒頭コメント）。
// 推奨 effort の提示経路は gate の deny 文言と CLAUDE.md の案内文だけだが、PR 作成前に
// 自発的にレビューするフローでは deny を踏まず、案内文（推奨止まり）はモデルに省略され
// うる。実際に effort 未指定で /code-review が実行される事例が起きたため、この hook が
// 「実行前に effort を明示する」ことだけを 1 回の差し戻しで決定的に促す。
//
// effort の値そのものは強制しない（推奨と別の値でも、引数に明示さえすれば通る）。
// 強制しないので gate が過去に踏んだ自己増幅ループは構造的に起きない。
//
// 対象外:
//   - ユーザー手打ちの /code-review（ツール呼び出しを経由しないため hook 自体が発火しない）
//   - effort（low/medium/high/xhigh/max/ultra）を引数に含む起動
//
// fail-open: 推奨 effort を算出できないとき（--required が "none" や解釈不能を返す・
// 実行失敗）は黙って許可する。これは nudge であり門番ではない（門番は PR 作成時の gate）。
// 無効化: gate と同じ CR_GATE_DISABLE=1 で止まる（レビュー関門一式のスイッチを分散させない）。

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EFFORT_RANK, readStdin } from "./lib/reviewable-files.mjs";
/* global process, URL */

if (process.env.CR_GATE_DISABLE === "1") process.exit(0);

// effort 語が引数のどこかに単語として現れれば「明示あり」。パス断片等への誤ヒット
// （例: max-file.ts）は許可側に倒れるだけなので許容（fail-open の方針と一致）。
const EFFORT_ARG_RE = new RegExp(`\\b(?:${Object.keys(EFFORT_RANK).join("|")})\\b`, "i");

const raw = (await readStdin()).replace(/^\uFEFF/, ""); // 先頭 BOM を除去
let data = {};
try {
  data = JSON.parse(raw);
} catch {
  process.exit(0); // 入力を解釈できないときは邪魔しない
}

// code-review の起動かを判定し、引数文字列を取り出す（null = code-review ではない）。
// スキル名/コマンド名の判定は gate の transcript 走査と同じ正規表現（名前そのものが
// code-review のときだけ。引数に "code-review" を含む別コマンドを拾わない）。
const input = data?.tool_input || {};
let argsText = null;
if (data?.tool_name === "Skill" && /(^|[:/])code-?review$/i.test(String(input.skill || "").trim())) {
  argsText = String(input.args || "");
} else if (data?.tool_name === "SlashCommand") {
  const m = String(input.command || "").match(/^\s*\/?code-?review\b([\s\S]*)$/i);
  if (m) argsText = m[1];
}
if (argsText === null) process.exit(0);
if (EFFORT_ARG_RE.test(argsText)) process.exit(0); // effort 明示済み

// 推奨 effort は gate の --required 照会をそのまま呼んで得る（算出ロジックと文言の
// 単一ソースを gate 側に維持する。ここに複製しない）。
const gatePath = fileURLToPath(new URL("./pr-code-review-gate.mjs", import.meta.url));
let out = null;
try {
  out = execFileSync(process.execPath, [gatePath, "--required"], {
    encoding: "utf8",
    cwd: data?.cwd || process.cwd(),
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  process.exit(0); // 算出失敗は fail-open
}

// 出力は "<label>: <説明文>" 形式。label が effort でないとき（"none"＝レビュー対象の
// コード変更なし、将来の形式変更）は fail-open。
const label = out.split(":", 1)[0].trim().toLowerCase();
if (!(label in EFFORT_RANK)) process.exit(0);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `code-review の effort が未指定です。${out.replace(/^\w+:\s*/, "")}` +
        `（推奨と別の effort を使う場合も、引数に明示すれば通ります）`,
    },
  })
);
process.exit(0);
