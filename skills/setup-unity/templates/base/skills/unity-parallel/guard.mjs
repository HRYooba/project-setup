// unity-parallel の PreToolUse hook（門番）。
//
// 検証レーン（Unity Editor が開いているフォルダ）は 1 つで、貸し出すたびに借り手の commit へ
// checkout される。「今 Editor を借りている 1 人」以外が Unity CLI で Editor を操作すると、
// 成功応答のまま別のスナップショットを検証してしまう（＝偽の green）。
// それを機械的に止めるのがこのフックの役目。
//
// 重要: Claude Code の hook は既定で fail-open で、**exit 2 だけがツール呼び出しを止める**。
// exit 1 も、例外も、壊れた JSON も「通す」側に落ちる。よってこのスクリプトは
// 「判断できないなら exit 2」で書く。判断できない状態で通すと、止めたかった事故がそのまま起きる。
//
// 何を止められないか（正直な限界。references/protocol.md が読者向けの正本）:
//   - Unity CLI の呼び出しもシェル越しの書き込みも、コマンド文字列のヒューリスティックでしか
//     見られない（コマンド置換・変数展開・エイリアス・別名でコピーしたバイナリは追えない）
//   - hook 自体の無効化（settings 編集 / disableAllHooks / 別プロセス起動）は防げない
//   - `unity shell` の中で打たれたコマンドは hook を通らない（起動自体は Editor 操作として止める）
//   これは「協調的なエージェントの事故」を止める仕組みであって、意図的な回避への防壁ではない。
//
// 依存なし（Node 標準のみ）。

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  COORDINATOR_EDITOR_PHASES,
  EDITOR_ALLOWED_PHASES,
  isUnitySerialized,
  laneStateDir,
  pathInside,
  readState,
  statePath,
  touchesEditorViaCli,
} from "./protocol.mjs";
/* global process */

// 禁止拡張子をシェルコマンド文字列の中から探すための正規表現。
// 一覧の正本は protocol.mjs の UNITY_SERIALIZED_EXT。ここはその文字列表現なので、
// 追加時に片方だけ直すと検出漏れになる（テストで両者の一致を確認する）。
import { UNITY_SERIALIZED_EXT } from "./protocol.mjs";
const UNITY_EXT_RE = new RegExp(`(${UNITY_SERIALIZED_EXT.map((e) => e.replace(".", "\\.")).join("|")})(\\b|['"\\s]|$)`, "i");

function deny(reason) {
  process.stderr.write(`[unity-parallel] ${reason}\n`);
  process.exit(2); // PreToolUse を止められる唯一の終了コード
}

function allow() {
  process.exit(0);
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// 借り手が生きていることの記録。state.json をツール呼び出しのたびに書くと
// coordinator と競合するため、別ファイルの mtime で持つ（ロック不要）。
function touchHeartbeat(dir, who) {
  try {
    writeFileSync(join(dir, "heartbeat"), `${who}\n`, "utf8");
  } catch {
    // 記録できなくても判定自体は state.json 側で成立する
  }
}

// lane.mjs を呼んだ主体を記録する。lane.mjs は自分の呼び出し元が
// メインセッションなのかサブエージェントなのかを知る手段を持たないため、
// hook 側でしか観測できない agent_id をここで橋渡しする。
function recordIdentity(dir, agentId, agentType) {
  try {
    writeFileSync(
      join(dir, "pending-identity.json"),
      JSON.stringify({ agentId, agentType, at: new Date().toISOString() }) + "\n",
      "utf8"
    );
  } catch {
    // 記録できなければ lane.mjs 側が「代理要求」として扱う（機能は落ちるが安全側）
  }
}

function laneHead(lanePath) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: lanePath, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function toolFilePath(input) {
  const ti = input.tool_input || {};
  return ti.file_path || ti.notebook_path || "";
}

function toolCommand(input) {
  const ti = input.tool_input || {};
  return String(ti.command || "");
}

function mentionsLane(command, lanePath) {
  const needle = String(lanePath).replace(/\\/g, "/").toLowerCase();
  const hay = command.replace(/\\/g, "/").toLowerCase();
  return hay.includes(needle);
}

// 書き込みらしい動詞と禁止拡張子の同居を見る。cat / grep のような読み取りは落とさない。
// 網羅は原理的に不可能なので、これは「うっかり」を落とすための網。
function looksLikeSerializedWrite(command) {
  const writeVerb = /(>>?|\bcp\b|\bmv\b|\bsed\s+-i|\btee\b|\bdd\b|Set-Content|Out-File|Add-Content|Copy-Item|Move-Item)/i;
  return writeVerb.test(command) && UNITY_EXT_RE.test(command);
}

function touchesLane(input, lanePath) {
  const p = toolFilePath(input);
  if (p && pathInside(p, lanePath)) return true;
  const c = toolCommand(input);
  return c ? mentionsLane(c, lanePath) : false;
}

function main() {
  const raw = readStdin();
  let input = null;
  try {
    input = JSON.parse(raw);
  } catch {
    input = null;
  }

  const cwd = (input && input.cwd) || process.cwd();

  let dir;
  try {
    dir = laneStateDir(cwd);
  } catch {
    allow(); // git リポジトリでない等。unity-parallel の管理対象外
    return;
  }

  // レーンが一度も初期化されていない ＝ 並列作業をしていない。通常のセッションを邪魔しない。
  if (!existsSync(statePath(dir))) allow();

  // ここから先はレーンが生きている。判断できない入力は通さない。
  if (!input) deny("hook 入力を解釈できませんでした。レーンが有効な間は、判断できない呼び出しを通しません。");

  let state;
  try {
    state = readState(dir);
  } catch (e) {
    deny(`レーンの状態ファイルを読めません（${e.message}）。復旧するまで止めます: node .claude/skills/unity-parallel/lane.mjs doctor`);
    return;
  }
  if (!state) allow();

  const toolName = String(input.tool_name || "");
  const agentId = input.agent_id || null; // 無ければメインセッション
  const agentType = input.agent_type || null;
  const holder = state.holder;
  const isShell = /^(Bash|PowerShell)$/.test(toolName);
  const command = isShell ? toolCommand(input) : "";

  // --- 0. coordinator への正規の呼び出し ----------------------------------
  // lane.mjs 自体がレーンの中にあるので、後段のレーン言及チェックに引っかかる。
  // 復旧手段（recover / doctor）まで塞がないよう、どの状態よりも先に通す。
  // ここで呼び出し元の識別子を記録するのが、identity を機械的に決める唯一の手段。
  // エージェントは自分の agent_id を知らないので、自己申告させると identity が意味を失う。
  if (isShell && /lane\.mjs(["']?)\s/.test(command)) {
    if (/\blane\.mjs["']?\s+(request|grant|status|doctor|recover|seal|drain|return|activate|delegate|undelegate|abandon)\b/.test(command)) {
      recordIdentity(dir, agentId, agentType);
    }
    allow();
  }
  if (isShell && /lane\.mjs["']?$/.test(command.trim())) allow();

  // --- 1. Editor 操作 -------------------------------------------------------
  // Unity 操作は `unity <サブコマンド>` に固定されているので、判定対象はシェルコマンド。
  // ツール名だけで判別できないため、ここで通す/止めるを間違えると気づけない。だから
  // 未知のサブコマンドは Editor 操作扱いにしてある（protocol.mjs 側の方針）。
  const touchesEditor = isShell && touchesEditorViaCli(command);

  // 異常終了後は、人が検査するまで Editor もレーンも触らせない。
  // **allow で締めない。** 当たらなかった呼び出しは下のファイル書き込み検査へ落とす
  // （落とさないと RECOVERY_REQUIRED 中だけ worktree の .prefab 手編集が素通りする）。
  if (state.recovery && (touchesEditor || touchesLane(input, state.lanePath))) {
    deny(
      `レーンが RECOVERY_REQUIRED です（理由: ${state.recovery.reason || "不明"}）。` +
        `node .claude/skills/unity-parallel/lane.mjs recover で検査してから再開してください。`
    );
  }

  if (touchesEditor) {
    if (!holder) {
      if (agentId) {
        deny(
          `Editor は誰にも貸し出されていません。サブエージェントは lane.mjs request で順番待ちに入ってください。\n` +
            `  command: ${command.slice(0, 200)}`
        );
      }
      allow(); // メインセッション（coordinator）が貸し出し前に触るのは正常
    }

    const isHolder = agentId !== null && holder.agentId === agentId;
    const isDelegate = agentType !== null && holder.delegate && holder.delegate.agentType === agentType;

    if (isHolder || isDelegate) {
      if (!EDITOR_ALLOWED_PHASES.has(holder.phase)) {
        deny(
          `Editor の準備が終わっていません（phase: ${holder.phase}）。ACTIVE になるまで Unity CLI で Editor を操作できません。` +
            `準備中に操作すると、切り替え前のスナップショットを検証して green を出してしまいます。`
        );
      }
      // Editor が本当にこの保持者の commit を指しているかを毎回確かめる。
      // state だけを信じると、外から checkout された場合に偽の green が通る。
      const head = laneHead(state.lanePath);
      if (!head) deny(`レーン（${state.lanePath}）の HEAD を確認できませんでした。安全のため止めます。`);
      if (head !== holder.loadedCommit) {
        deny(
          `レーンの HEAD がリース時と違います（現在 ${head.slice(0, 8)} / 期待 ${String(holder.loadedCommit).slice(0, 8)}）。` +
            `別のプロセスが checkout した可能性があります。lane.mjs recover で検査してください。`
        );
      }
      touchHeartbeat(dir, agentId || `delegate:${agentType}`);
      allow();
    }

    if (agentId === null) {
      // メインセッション。切替前の静止確認と返却時の後始末だけ許す。
      if (COORDINATOR_EDITOR_PHASES.has(holder.phase)) allow();
      deny(
        `Editor は ${holder.worktree} が使用中です（phase: ${holder.phase}）。` +
          `メインセッションからの Unity 操作は準備・返却フェーズに限られます。`
      );
    }

    deny(
      `Editor は ${holder.worktree} が借りています。あなた（${agentType || "unknown"}）はトークンを持っていません。` +
        `lane.mjs request で順番待ちに入ってください。\n` +
        `  command: ${command.slice(0, 200)}`
    );
  }

  // --- 2. ファイル書き込み ------------------------------------------------
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(toolName)) {
    const filePath = toolFilePath(input);
    if (filePath && isUnitySerialized(filePath)) {
      deny(
        `${filePath} は Unity がシリアライズするファイルです。手編集は GUID / fileID を壊し、` +
          `しかも壊れたことがその場では分かりません。Editor（Unity CLI）経由で変更してください。`
      );
    }
    if (filePath && agentId !== null && pathInside(filePath, state.lanePath)) {
      const isHolder = holder && holder.agentId === agentId;
      if (!isHolder) {
        deny(
          `${filePath} は検証レーン（${state.lanePath}）の中です。` +
            `レーンは貸し出し用のスナップショットなので、作業は自分の worktree で行ってください。`
        );
      }
    }
    allow();
  }

  // --- 3. シェル ----------------------------------------------------------
  // lane.mjs 呼び出しはセクション 0 で通し済み。
  if (isShell) {
    if (looksLikeSerializedWrite(command)) {
      deny(
        `Unity がシリアライズするファイルをシェルから書き換えようとしています。GUID / fileID が壊れます。\n` +
          `  command: ${command.slice(0, 200)}`
      );
    }
    if (agentId !== null && mentionsLane(command, state.lanePath)) {
      const isHolder = holder && holder.agentId === agentId;
      if (!isHolder) {
        deny(
          `検証レーン（${state.lanePath}）を操作しようとしています。レーンへの操作は lane.mjs 経由でのみ行ってください。\n` +
            `  command: ${command.slice(0, 200)}`
        );
      }
    }
    allow();
  }

  allow();
}

try {
  main();
} catch (e) {
  // 想定外の例外でも通さない。ここで通すと、止めたかった事故がそのまま起きる。
  deny(`門番が異常終了しました（${e && e.message}）。安全のため拒否します。lane.mjs doctor で状態を確認してください。`);
}
