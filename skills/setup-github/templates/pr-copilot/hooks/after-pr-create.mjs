// PostToolUse(Bash) hook: `gh pr create` の直後に走る PR 後処理。
//
// コード変更を含む PR のみを対象に:
//   1. Copilot に自動でレビュー依頼（requested_reviewers 登録）
//   2. Claude に「watch-pr <番号> を起動せよ」を additionalContext で促す
//
// なぜコード変更を含む PR に限るか: docs/設定のみの PR に Copilot を付けて watch-pr を
// 起動しても、実質レビューが入らず 30 分タイムアウトを待つだけで無駄なため。
// 「コードとみなすファイル」の定義は pr-code-review-gate.mjs と共有する
// （lib/reviewable-files.mjs が単一ソース。二重管理すると gate と Copilot の判定が食い違う）。
//
// jq 非依存（Node のみ）。ツール非依存（Unity 等の前提を持たない）。

import {
  PR_CREATE_ATTEMPT_RE,
  execTrim,
  isReviewableFile,
  readStdin,
} from "./lib/reviewable-files.mjs";
/* global process */

function done() {
  process.exit(0);
}

function emitContext(text) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: text,
      },
    })
  );
  process.exit(0);
}

function gh(args) {
  return execTrim("gh", args);
}

const raw = (await readStdin()).replace(/^\uFEFF/, "");
let data = {};
try {
  data = JSON.parse(raw);
} catch {
  done();
}

// gate と同一の PR 検出定義（lib 共有）。bare な \bgh pr create\b は echo/grep の
// 言及も拾うため使わない。
const command = data?.tool_input?.command ?? "";
if (!PR_CREATE_ATTEMPT_RE.test(command)) done();

const stdout = data?.tool_response?.stdout ?? "";
if (!stdout) done();

// PR URL を抽出: https://<host>/<owner>/<repo>/pull/<number>。
// ホストは github.com 固定にしない（GitHub Enterprise Server の別ホストにも対応）。
const urlMatch = stdout.match(/https:\/\/[^/\s]+\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/);
if (!urlMatch) done();
const repo = urlMatch[1];
const prNumber = urlMatch[2];

// 変更ファイルを 1 回だけ取得し、コード変更を含むか判定。
// -R <repo> を明示して、別ディレクトリ（cd ../other && gh pr create）や --repo 指定で
// 作成した PR でも、URL から抽出した正しいリポジトリの PR を参照する（cwd 依存を排除）。
const diff = gh(["pr", "diff", prNumber, "--repo", repo, "--name-only"]);
if (!diff) done();
const files = diff.split(/\r?\n/).filter(Boolean);
const hasCode = files.some((f) => isReviewableFile(f));
if (!hasCode) done();

// 1. Copilot レビュー依頼
const requested = gh([
  "api",
  "--method",
  "POST",
  `repos/${repo}/pulls/${prNumber}/requested_reviewers`,
  "-f",
  "reviewers[]=copilot-pull-request-reviewer[bot]",
]);

// 依頼に失敗した PR には Copilot レビューが来ないため、watch-pr を起動させない
// （起動しても誰も来ない PR を 30 分ポーリングして TIMEOUT するだけ）。
// 失敗の典型: リポジトリ/組織で Copilot code review が無効、権限不足。
if (requested === null) {
  emitContext(
    `PR #${prNumber}: Copilot レビュー依頼に失敗しました（Copilot code review が無効・権限不足等の可能性）。レビューが来ないため watch-pr は起動しないでください。`
  );
}

// 2. watch-pr 起動を促す
emitContext(
  `PR #${prNumber}: Copilot レビューを自動依頼しました。続けて watch-pr スキルを必ず起動してください: Skill(skill: "watch-pr", args: "${prNumber}")`
);
