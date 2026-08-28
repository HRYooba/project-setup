// UserPromptSubmit hook: テンプレート更新を検知していたら、**そのセッションの最初のプロンプト**に
// `/sync-setup` の実行を差し込む。
//
// なぜ SessionStart ではなくここか:
//   SessionStart の時点でモデルは呼ばれない（セッションは入力待ちで止まる）。additionalContext を
//   積んでも、人が何か打つまで何も起きず、打たれなければ永久に放置される。実際に Claude が動く
//   最初の瞬間はここなので、実行の指示はここに置く。
//
// なぜ updatedInput か:
//   additionalContext は「読ませる」だけで、長い前置きに埋もれると効かない。updatedInput は
//   モデルへ渡る入力そのものを差し替えるため、ユーザー自身の依頼として届く。
//
// 設計:
//   - **1 セッションにつき 1 回だけ差し込む**（session_id で記録）。差し込んだときだけ記録するので、
//     セッション途中でプラグインが自動更新されれば次のプロンプトで拾える。
//   - **スラッシュコマンド等で始まるプロンプトは書き換えない。** 先頭に文字を足すと `/foo` や
//     `!cmd` の展開が壊れる。その場合は additionalContext で指示だけ渡す。
//   - **黙って書き換えない。** systemMessage で「先に sync を挟んだ」と 1 行出す。打っていない文が
//     会話ログに残るため。
//   - sync を用件より先に置く。後ろに置くと長い作業の末尾まで到達せず、結局放置される。
//     同期は使い捨て worktree で走り、重複 PR 防止と試行上限（同一版 2 回）が sync-run.mjs 側に
//     あるので、先に走らせても作業ツリーは壊れないし暴走もしない。
//   - UserPromptSubmit の timeout は既定 30 秒（他 hook の 600 秒ではない）。ここはローカルの
//     JSON を数本読むだけに保つ。ネットワーク・gh・git は sync-run.mjs 側が叩く。
//   - SYNC_SETUP_DISABLE=1 で黙る（避難口。detectDrift が見る）。

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, detectDrift, readJson, readStdin } from "./lib/sync-setup-drift.mjs";
/* global process */

// 差し込み済みセッションの記録。1 セッション 1 エントリで、古いものは捨てる
// （セッションごとにファイルを作ると増え続けるため、1 ファイルの map に畳む）。
const PRUNE_MS = 7 * 24 * 60 * 60 * 1000;

function promptedPath() {
  return process.env.SYNC_SETUP_PROMPTED_JSON || join(dataDir(), "sync-setup-prompted.json");
}

function markPrompted(sessionId) {
  const p = promptedPath();
  const now = Date.now();
  const obj = readJson(p) || {};
  const next = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "number" && now - v < PRUNE_MS) next[k] = v;
  }
  next[sessionId] = now;
  try {
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify(next, null, 2) + "\n", "utf8");
  } catch {
    // 記録できなくても差し込み自体は成立させる（最悪、同一セッションで 2 回出るだけ）。
  }
}

function alreadyPrompted(sessionId) {
  const obj = readJson(promptedPath());
  return !!(obj && typeof obj === "object" && sessionId in obj);
}

const stdin = await readStdin();
const projectDir = process.env.CLAUDE_PROJECT_DIR || stdin.cwd || process.cwd();
const sessionId = typeof stdin.session_id === "string" ? stdin.session_id : "";
const prompt = typeof stdin.prompt === "string" ? stdin.prompt : "";

// session_id が取れない環境では黙る（記録できない＝毎プロンプト差し込むことになるため）。
if (!sessionId || alreadyPrompted(sessionId)) process.exit(0);

const drift = detectDrift(projectDir);
if (!drift) process.exit(0);

const instruction = [
  `【テンプレート同期】project-setup のテンプレートが更新されています（${drift.summary}）。`,
  "まず `/project-setup:sync-setup` を実行して同期 PR を作ってください。",
  "同期は使い捨て worktree の中で走るので、いまの作業ツリーとブランチには影響しません。",
  "merge はしません。PR を作るところで止まります。",
].join("\n");

markPrompted(sessionId);

// スラッシュコマンド・bash（!）・メモ（#）で始まるプロンプトは先頭に文字を足すと展開が壊れる。
// 書き換えず、指示だけ additionalContext で渡す。
const isDirective = /^\s*[/!#]/.test(prompt);

const out = {
  systemMessage: `【テンプレート更新】${drift.summary} — このターンで /sync-setup を先に実行します`,
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    ...(isDirective
      ? { additionalContext: `${instruction}\n\nその後、ユーザーの依頼に答えてください。` }
      : {
          updatedInput: `${instruction}\n\n同期が終わったら、続けて次の依頼に答えてください:\n\n${prompt}`,
        }),
  },
};

process.stdout.write(JSON.stringify(out));
