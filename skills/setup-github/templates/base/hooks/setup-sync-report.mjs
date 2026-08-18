// UserPromptSubmit hook: 裏で走ったテンプレート同期の結果を 1 回だけ報告する。
//
// setup-sync-check.mjs（SessionStart）が sync-launch.mjs を detached で起動し、数分後に
// 同期 PR を作って結果ファイルを残す。動いているセッションへ外から文字を差し込む口が無いため、
// 報告はイベントが起きるまで出せない。UserPromptSubmit が最も早いイベントなので、
// 「次にユーザーが何か打った時」にここで拾って 1 行返す（セッションが終わっていれば次回起動時）。
//
// 毎プロンプト走るので、存在確認 1 回で抜けることを最優先にしている。
// 報告したファイルは消す（同じ報告を二度出さない）。
//
// このスキル 1 ファイルで完結する（外部モジュールを import しない）。

import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
/* global process */

if (process.env.SETUP_SYNC_DISABLE === "1") process.exit(0);

// 結果ファイルのキー。sync-launch.mjs が同一仕様の実装を持つ。hook は配備先へ単体コピーされる
// 制約上 import できないため、ここは意図的な重複。変えるときは両方を揃える。
function resultKey(dir) {
  const norm = resolve(dir).replace(/[\\/]+$/, "");
  const canon = process.platform === "win32" ? norm.toLowerCase() : norm;
  let h = 0;
  for (let i = 0; i < canon.length; i++) h = (Math.imul(h, 31) + canon.charCodeAt(i)) | 0;
  const name = (canon.split(/[\\/]/).pop() || "repo").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
  return `${name}-${(h >>> 0).toString(16)}`;
}

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const dataDir =
  process.env.SETUP_SYNC_DATA_DIR || join(homedir(), ".claude", "plugins", "data", "project-setup");
const resultPath = join(dataDir, "results", `${resultKey(projectDir)}.json`);

// ここが毎プロンプトの実費。存在しなければ即終了する。
if (!existsSync(resultPath)) process.exit(0);

let result;
try {
  const raw = readFileSync(resultPath, "utf8");
  result = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
} catch {
  rmSync(resultPath, { force: true }); // 壊れた結果は捨てる（毎回煽らない）
  process.exit(0);
}
rmSync(resultPath, { force: true });

const lines = [];
if (result?.status === "pr") {
  lines.push(
    `【テンプレート自動追随】裏で同期 PR を作成しました: ${result.prUrl}（${result.message}）。`,
    "merge はしていません。内容を確認してマージしてください。"
  );
} else if (result?.status === "failed") {
  lines.push(
    `【テンプレート自動追随】裏での同期に失敗しました: ${result.message}`,
    "手動で `/setup-sync` を実行するか、原因を確認してください。"
  );
} else if (result?.status === "skipped") {
  // 「同期不要」「既存 PR あり」「試行上限」。放置検知のため黙らせない。
  lines.push(`【テンプレート自動追随】裏での同期は PR を作りませんでした: ${result.message}`);
} else {
  process.exit(0);
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: lines.join("\n") },
  })
);
process.exit(0);
