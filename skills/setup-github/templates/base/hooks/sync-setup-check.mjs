// SessionStart hook: setup-github / setup-unity テンプレートの更新を検知して**人に知らせる**。
//
// 判定は lib/sync-setup-drift.mjs（両 hook の正本）。ここは出力だけを持つ。
//
// 設計:
//   - **ここでは同期しない。Claude にも指示しない。** SessionStart の時点でモデルは呼ばれず、
//     セッションは入力待ちで止まる。ここで additionalContext を積んでも「次に人が何か打つまで」
//     効かないので、実行の指示は UserPromptSubmit（sync-setup-prompt.mjs）が持つ。
//     ここは systemMessage だけを出し、人が最初に見る 1 行になる。
//   - 実行指示を両方の hook に置かない。二重に走る。
//   - SessionStart はブロックできない（公式仕様: Can block? = No）。exit 2 でも stderr が
//     出るだけでセッションは進む。止める設計は取れないし、取らない。

import { detectDrift, readStdin } from "./lib/sync-setup-drift.mjs";
/* global process */

const stdin = await readStdin();
const projectDir = process.env.CLAUDE_PROJECT_DIR || stdin.cwd || process.cwd();

const drift = detectDrift(projectDir);
if (!drift) process.exit(0);

process.stdout.write(
  JSON.stringify({
    systemMessage:
      `【テンプレート更新】project-setup が更新されています（${drift.summary}）。` +
      "次のプロンプトで /sync-setup を先に実行します（/sync-setup を手で打っても同じ）。",
  })
);
