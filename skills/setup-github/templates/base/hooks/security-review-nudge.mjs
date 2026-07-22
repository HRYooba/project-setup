// PostToolUse(Bash) hook: `gh pr create` の成功直後に走る。PR の変更が「セキュリティ感応」
// なら Claude に `/security-review` の実行を additionalContext で促す（非ブロック）。
//
// 設計の要点:
//   - 「毎 PR で security-review」をやめ、感応な変更を含む PR でだけ促す（オオカミ少年回避）。
//   - 非ブロック: PR は既に作成済み。指摘は追加コミットで merge 前に対応すればよい。
//   - 感応判定は lib/security-signals.mjs（balanced: 依存変更 / 感応パス・名 / 追加行
//     キーワードの OR）。走査範囲（base...HEAD）は gate と共有の detectBase で決める。
//   - ツール設定系（.claude/ .github/ .githooks/）は走査から除外する。これを除かないと
//     この hook 自身のコード（"exec"/"crypto" 等を含む）を変更する PR が自己発火する。
//   - 今回の PR 作業で既に /security-review 済みなら促さない（transcript 走査）。
//
// 無効化: SECURITY_NUDGE_DISABLE=1。
// テスト用差し替え: SECURITY_NUDGE_FILES（改行区切りの変更パス）/ SECURITY_NUDGE_ADDED
//   （改行区切りの追加行）。両方セット時は git を叩かず、この値で判定する。

import { readFileSync } from "node:fs";
import {
  PR_CREATE_ATTEMPT_RE,
  detectBase,
  expandRename,
  gitIn,
  readStdin,
} from "./lib/reviewable-files.mjs";
import { securityReasons } from "./lib/security-signals.mjs";
/* global process */

if (process.env.SECURITY_NUDGE_DISABLE === "1") process.exit(0);

function done() {
  process.exit(0); // 何も出力しない = 通常終了（nudge しない）
}

function nudge(text) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text },
    })
  );
  process.exit(0);
}

// 走査から外すツール設定系。git pathspec の除外構文で git 側に落とす。
const EXCLUDE_PATHSPECS = [
  ":(exclude).claude/**",
  ":(exclude).github/**",
  ":(exclude).githooks/**",
];
const ADDED_LINES_CAP = 20000; // 巨大 diff で正規表現に張り付かないための上限

// 変更ファイル一覧（除外パス適用済み）。
function changedFiles(cwd, base) {
  const out = gitIn(cwd, ["diff", "--name-only", `${base}...HEAD`, "--", ".", ...EXCLUDE_PATHSPECS]);
  return out ? out.split(/\r?\n/).map(expandRename).filter(Boolean) : [];
}

// 追加行（先頭 + を除く。+++ ヘッダは除外）。除外パス適用済み。
function addedLines(cwd, base) {
  const out = gitIn(cwd, [
    "diff", "--unified=0", "--no-color", `${base}...HEAD`, "--", ".", ...EXCLUDE_PATHSPECS,
  ]);
  if (!out) return [];
  const res = [];
  for (const l of out.split(/\r?\n/)) {
    if (l.startsWith("+") && !l.startsWith("+++")) {
      res.push(l.slice(1));
      if (res.length >= ADDED_LINES_CAP) break;
    }
  }
  return res;
}

// tool_result の本文をテキスト化（string / ブロック配列の両形式）。
function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c.text === "string" ? c.text : "")).join("\n");
  }
  return "";
}

const SEC_SKILL_RE = /(^|[:/])security-review$/i;
const SEC_SLASH_RE = /^\s*\/?security-review(\s|$)/i;
const SEC_TYPED_RE = /<command-name>\s*\/?security-review\s*<\/command-name>/i;
const WEB_FLAG_RE = /(?:^|\s)(?:--web|-w)\b/;

// 今回の PR 作業（＝直前に成功した PR 作成より後、今回の PR 作成まで）で /security-review が
// 完了しているか。完了していれば nudge しない。gate の reviewsSincePrCreate と同思想だが、
// PostToolUse では「末尾の成功試行＝今回作成した PR」なので、その 1 つ手前の成功試行を
// 窓の下限（前 PR）にする。
function alreadyReviewed(transcriptPath) {
  let lines;
  try {
    lines = readFileSync(transcriptPath, "utf8").split(/\r?\n/);
  } catch {
    return false; // 読めなければ「未レビュー」側（＝促す）に倒す
  }
  const attempts = []; // gh pr create 試行
  const reviews = []; // security-review イベント
  const results = new Map();
  lines.forEach((line, idx) => {
    if (!line) return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    const content = obj?.message?.content;
    if (obj?.message?.role === "user" && typeof content === "string") {
      if (SEC_TYPED_RE.test(content)) reviews.push({ idx, id: null });
      return;
    }
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block) continue;
      if (block.type === "tool_result" && block.tool_use_id) {
        results.set(block.tool_use_id, {
          error: block.is_error === true,
          text: resultText(block.content),
        });
        continue;
      }
      if (block.type !== "tool_use") continue;
      const input = block.input || {};
      if (
        block.name === "Bash" &&
        typeof input.command === "string" &&
        PR_CREATE_ATTEMPT_RE.test(input.command)
      ) {
        attempts.push({ idx, id: block.id, command: input.command });
      }
      if (
        (block.name === "Skill" && SEC_SKILL_RE.test(String(input.skill || "").trim())) ||
        (block.name === "SlashCommand" && SEC_SLASH_RE.test(String(input.command || "")))
      ) {
        reviews.push({ idx, id: block.id || null });
      }
    }
  });
  const succeeded = (a) => {
    const r = results.get(a.id);
    if (!r || r.error) return false;
    return /\/pull\/\d+/.test(r.text) || WEB_FLAG_RE.test(a.command || "");
  };
  attempts.sort((a, b) => a.idx - b.idx);
  const successIdx = attempts.filter(succeeded).map((a) => a.idx);
  // 末尾＝今回作成した PR（transcript に載っていなければ Infinity）。その手前＝前 PR。
  const currentCreate = successIdx.length ? successIdx[successIdx.length - 1] : Infinity;
  const prevCreate = successIdx.length > 1 ? successIdx[successIdx.length - 2] : -1;
  for (const r of reviews) {
    if (r.idx <= prevCreate || r.idx >= currentCreate) continue; // 今回の作業窓の外
    if (r.id !== null) {
      const res = results.get(r.id);
      if (!res || res.error) continue; // 中断・起動失敗は数えない
    }
    return true;
  }
  return false;
}

const raw = (await readStdin()).replace(/^\uFEFF/, "");
let data = {};
try {
  data = JSON.parse(raw);
} catch {
  done(); // 入力を解釈できないときは邪魔しない
}

const command = data?.tool_input?.command ?? "";
if (!PR_CREATE_ATTEMPT_RE.test(command)) done(); // gh pr create 以外は無関係

// PR 作成が成功した場合だけ促す（失敗した試行では PR がまだ無い）。
// 成功判定: 標準出力に PR URL（/pull/<番号>）があるか、--web 指定。
const stdout = data?.tool_response?.stdout ?? "";
const created = /\/pull\/\d+/.test(stdout) || WEB_FLAG_RE.test(command);
if (!created) done();

// 今回の PR 作業で既にセキュリティレビュー済みなら促さない。
const transcriptPath = data?.transcript_path || "";
if (transcriptPath && alreadyReviewed(transcriptPath)) done();

// 変更を集めて感応判定。テスト差し替え（env）を優先。
let files;
let added;
if (
  process.env.SECURITY_NUDGE_FILES !== undefined &&
  process.env.SECURITY_NUDGE_ADDED !== undefined
) {
  files = process.env.SECURITY_NUDGE_FILES.split(/\r?\n/).filter(Boolean);
  added = process.env.SECURITY_NUDGE_ADDED.split(/\r?\n/);
} else {
  const cwd = data?.cwd || process.cwd();
  const base = detectBase(cwd, command);
  if (!base) done(); // base 不明では diff を取れない＝証拠なし。noise を避けて促さない
  files = changedFiles(cwd, base);
  added = addedLines(cwd, base);
}

const reasons = securityReasons({ files, addedLines: added });
if (reasons.length === 0) done(); // 感応な変更なし＝促さない

nudge(
  `この PR にはセキュリティ的に注意すべき変更が含まれます（${reasons.join(" / ")}）。` +
    `\`/security-review\` を 1 回実行し、指摘があれば追加コミットで対応してから merge してください` +
    `（不要と判断できる場合はスキップ可。無効化は SECURITY_NUDGE_DISABLE=1）。`
);
