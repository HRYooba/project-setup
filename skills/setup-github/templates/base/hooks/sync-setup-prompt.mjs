// UserPromptSubmit hook: テンプレート更新を検知していたら、**そのセッションの最初のプロンプト**へ
// `/sync-setup` の実行指示を添える。
//
// なぜ SessionStart ではなくここか:
//   SessionStart はモデルのターンを起こせない。additionalContext を積んでも人が何か打つまで
//   何も起きず、打たれなければ放置される。SessionStart の initialUserMessage も対話 TUI では
//   投入されない（消費側が stream/SDK transport の経路にしかない）。実際にモデルが動く最初の
//   瞬間はここなので、実行の指示はここに置く。
//
// なぜ additionalContext だけか:
//   UserPromptSubmit の hookSpecificOutput が受け付けるのは additionalContext / sessionTitle /
//   suppressOriginalPrompt（decision が "block" のときだけ）の 3 つ。**それ以外のキーは検証で
//   黙って捨てられる**（エラーも警告も出ない）。プロンプト本文を差し替える手段は無い。
//   additionalContext はプロンプト直後の meta メッセージとして届き、順序の指示（同期を先に）も
//   そのとおり守られる。
//
// 設計:
//   - **1 セッションにつき 1 回だけ添える**（session_id で記録）。添えたときだけ記録するので、
//     セッション途中でプラグインが自動更新されれば次のプロンプトで拾える。
//   - **プロンプト本文には触らない。** 先頭に文字を足す手段が無いのと同時に、足してはいけない
//     （`/foo` や `!cmd` の展開が壊れる）。指示は必ず additionalContext 側に置く。
//   - 用件より先に同期を置くよう明示する。後回しにすると長い作業の末尾まで到達せず放置される。
//     同期は使い捨て worktree で走り、重複 PR 防止と試行上限（同一版 2 回）が sync-run.mjs 側に
//     あるので、先に走らせても作業ツリーは壊れないし暴走もしない。
//   - **黙って足さない。** systemMessage で「同期を先に挟む」と 1 行出す。ユーザーが打っていない
//     指示がモデルへ渡るため。
//   - UserPromptSubmit の timeout は既定 30 秒（他 hook の 600 秒ではない）。ここはローカルの
//     JSON を数本読むだけに保つ。ネットワーク・gh・git は sync-run.mjs 側が叩く。
//   - SYNC_SETUP_DISABLE=1 で黙る（避難口。detectDrift が見る）。
//   - **Orca が作業を配った worker セッションには添えない。** worker への brief は GitHub 操作や
//     依頼外の作業を禁じており、同期の指示は実行されずに空振りする。worker の最初のプロンプトは
//     Orca が固定文（ORCA_DISPATCH_LEAD）で始める。人間が Orca 端末で打つプロンプトはこの文で
//     始まらず、環境変数は worker と人間の Orca 端末で区別が付かないので、見分けはこの文だけで行う。
//     添えたときと同じく記録してから黙るので、同じ worker セッションの 2 通目以降にも添えない。

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, detectDrift, readJson, readStdin } from "./lib/sync-setup-drift.mjs";
/* global process */

// 添えたセッションの記録。1 セッション 1 エントリで、古いものは捨てる
// （セッションごとにファイルを作ると増え続けるため、1 ファイルの map に畳む）。
const PRUNE_MS = 7 * 24 * 60 * 60 * 1000;

// Orca 本体の ORCA_DISPATCH_PROMPT_LEAD_LINE の先頭。文末の言い回しが変わっても外れないよう前半だけ見る。
const ORCA_DISPATCH_LEAD = "Please carry out this task from my Orca coordinator";

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
    // 記録できなくても指示自体は成立させる（最悪、同一セッションで 2 回出るだけ）。
  }
}

function alreadyPrompted(sessionId) {
  const obj = readJson(promptedPath());
  return !!(obj && typeof obj === "object" && sessionId in obj);
}

const stdin = await readStdin();
const projectDir = process.env.CLAUDE_PROJECT_DIR || stdin.cwd || process.cwd();
const sessionId = typeof stdin.session_id === "string" ? stdin.session_id : "";

// session_id が取れない環境では黙る（記録できない＝毎プロンプト添えることになるため）。
if (!sessionId || alreadyPrompted(sessionId)) process.exit(0);

const prompt = typeof stdin.prompt === "string" ? stdin.prompt : "";
if (prompt.trimStart().startsWith(ORCA_DISPATCH_LEAD)) {
  markPrompted(sessionId);
  process.exit(0);
}

const drift = detectDrift(projectDir);
if (!drift) process.exit(0);

const instruction = [
  `【テンプレート同期】project-setup のテンプレートが更新されています（${drift.summary}）。`,
  "ユーザーの依頼より先に `/project-setup:sync-setup` を実行して同期 PR を作ってください。",
  "同期は使い捨て worktree の中で走るので、いまの作業ツリーとブランチには影響しません。",
  "merge はしません。PR を作るところで止まります。",
  "その後、続けてユーザーの依頼に答えてください。",
].join("\n");

markPrompted(sessionId);

process.stdout.write(
  JSON.stringify({
    systemMessage: `【テンプレート更新】${drift.summary} — このターンで /sync-setup を先に実行します`,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: instruction,
    },
  })
);
