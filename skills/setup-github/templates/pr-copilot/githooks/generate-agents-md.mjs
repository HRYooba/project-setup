// AGENTS.md 生成スクリプト（setup-github --pr-copilot が配布）。
// .claude/rules/*.md のうち「agents-md: include」マーカーを持つファイルを連結し、
// リポジトリルートの AGENTS.md を生成する。Copilot code review はルートの
// AGENTS.md を自動で読む（2026-06 の公式対応）ため、これが「Copilot に
// プロジェクト規約を教える」唯一の経路になる。
//
// なぜ生成方式か: Copilot は AGENTS.md から他ファイルを参照できないため全文の
// 埋め込みが必要で、ソースの rules はプロジェクトで育つため手動同期は必ず乖離する。
// コミットごとの機械生成（.githooks/pre-commit）なら乖離が構造的に起きない。
//
// 呼び出し元:
//   - .githooks/pre-commit（コミットごとに再生成 → 差分があれば stage）
//   - setup-github の apply.mjs（導入時の初回生成。引数にリポジトリルートを渡す）
//
// stdout は 1 行で、状態トークンで始まる（pre-commit が判定に使う）:
//   generated: 書き込んだ / unchanged: 差分なし / skipped: 手書き AGENTS.md を保護
//
// 手編集検知: 生成ファイルは先頭に SENTINEL コメントを持つ。これが無い AGENTS.md は
// 手書きとみなし、上書きしない（fail-safe）。

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
/* global process, console */

const root = process.argv[2] ?? process.cwd();
const MARKER = "agents-md: include"; // rules ファイル側の目印（先頭付近の HTML コメントに書く）
const SENTINEL = "generated-by: generate-agents-md.mjs";
const LINE_LIMIT = 1000; // 公式推奨「1 ファイル約 1,000 行まで」。超過は警告のみ（切り詰めない）

const outPath = join(root, "AGENTS.md");
// 既存 AGENTS.md は 1 度だけ読む（SENTINEL 検査と後段の unchanged 比較で使い回す）。
const existing = existsSync(outPath) ? readFileSync(outPath, "utf8") : null;

if (existing !== null && !existing.includes(SENTINEL)) {
  console.log(
    "skipped: AGENTS.md は手書きファイルのため上書きしませんでした（自動生成へ移行する場合は既存ファイルを退避してから再実行）"
  );
  process.exit(0);
}

// マーカー行 = 行全体がマーカーの HTML コメントである行。検出はファイル先頭 5 行以内に
// 限定する（本文中でマーカーに言及しただけのファイルを誤って取り込まないため）。
// 除去も「先頭 5 行以内のマーカー行」だけに限定する：散文でマーカーに言及した行
// （例: この機構自体の説明）を全文 filter で消してしまわないため、検出と除去の
// 条件・範囲を必ず一致させること。
const HEAD_LINES = 5;
const MARKER_LINE_RE = new RegExp(`^\\s*<!--\\s*${MARKER}\\s*-->\\s*$`);
const rulesDir = join(root, ".claude", "rules");
const sources = [];
if (existsSync(rulesDir)) {
  const files = readdirSync(rulesDir)
    .filter((f) => f.endsWith(".md"))
    .sort();
  for (const f of files) {
    const lines = readFileSync(join(rulesDir, f), "utf8").split(/\r?\n/);
    if (!lines.slice(0, HEAD_LINES).some((l) => MARKER_LINE_RE.test(l))) continue;
    const body = lines
      .filter((l, i) => !(i < HEAD_LINES && MARKER_LINE_RE.test(l)))
      .join("\n")
      .trim();
    sources.push({ path: `.claude/rules/${f}`, body });
  }
}

const parts = [
  `<!-- ${SENTINEL} -->`,
  `<!--
  自動生成ファイル。直接編集しないこと（.githooks/pre-commit が再生成して上書きする）。
  内容を変えるには .claude/rules/ 側を編集する。
  取り込み対象: 先頭 5 行以内に「${MARKER}」マーカー（HTML コメント）を持つ .claude/rules/*.md
-->`,
  `# プロジェクト規約（AI エージェント向け）`,
  `- 言語: 日本語（対話・出力）、英語（思考・推論）
- コードレビューの対象はスクリプトのみ。`,
  ...sources.map((s) => `<!-- source: ${s.path} -->\n\n${s.body}`),
];
const content = parts.join("\n\n") + "\n";

const lineCount = content.split("\n").length - 1; // content は \n 終端のため split は実行数 +1 になる
if (lineCount > LINE_LIMIT) {
  console.error(
    `warning: AGENTS.md が ${lineCount} 行あります（公式推奨は約 ${LINE_LIMIT} 行まで。超過すると指示が無視されうるため .claude/rules 側の整理を推奨）`
  );
}

const normalize = (s) => s.replace(/\r\n/g, "\n");
if (existing !== null && normalize(existing) === content) {
  console.log(`unchanged: AGENTS.md は最新です（ソース ${sources.length} 件）`);
} else {
  writeFileSync(outPath, content, "utf8");
  console.log(
    `generated: AGENTS.md を生成しました（ソース ${sources.length} 件${
      sources.length ? `: ${sources.map((s) => s.path).join(", ")}` : ""
    }）`
  );
}
