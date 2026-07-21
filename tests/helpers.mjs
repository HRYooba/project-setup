// テスト共通ヘルパー。
//
// hook は「stdin に JSON を受け取り stdout に判定を返す子プロセス」なので、テストも
// 同じ経路（spawnSync + stdin）で実行する。関数を import して呼ぶ方式にしないのは、
// hook が process.exit / stdin / 環境変数に依存しており、本番と同じ入口を通さないと
// テストが実装詳細（内部関数のシグネチャ）に癒着するため。
//
// transcript フィクスチャは Claude Code の実 transcript（JSONL）と同じ構造で組み立てる:
//   - assistant の tool_use: {"message":{"role":"assistant","content":[{"type":"tool_use",...}]}}
//   - user の tool_result:   {"message":{"role":"user","content":[{"type":"tool_result",...}]}}
//   - 手打ちスラッシュコマンド: {"message":{"role":"user","content":"<command-name>/...</command-name> ..."}}

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
/* global process */

const here = dirname(fileURLToPath(import.meta.url));
export const HOOKS_DIR = join(here, "..", "skills", "setup-github", "templates", "base", "hooks");
export const GATE = join(HOOKS_DIR, "pr-code-review-gate.mjs");
export const NUDGE = join(HOOKS_DIR, "code-review-effort-nudge.mjs");
export const SYNC_HOOK = join(HOOKS_DIR, "setup-sync-check.mjs");
export const APPLY = join(here, "..", "skills", "setup-github", "apply.mjs");
export const APPLY_UNITY = join(here, "..", "skills", "setup-unity", "apply.mjs");

export function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ---- transcript フィクスチャ ----

export function toolUse(name, input, id) {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  });
}

export function toolResult(id, text, isError = false) {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: id, is_error: isError, content: [{ type: "text", text }] },
      ],
    },
  });
}

// ユーザー手打ちのスラッシュコマンド（tool_use を経由しない形）。
export function typedCommand(commandName, args = "") {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: `<command-name>${commandName}</command-name>\n<command-args>${args}</command-args>`,
    },
  });
}

// 「成功した gh pr create」の 2 行（試行 + PR URL 入りの結果）。anchor 検証用。
export function successfulPrCreate(id, command = "gh pr create --fill") {
  return [
    toolUse("Bash", { command }, id),
    toolResult(id, `https://github.com/example/repo/pull/12\n`),
  ];
}

// ---- hook 実行 ----

// transcript（行配列）を一時ファイルへ書き、gate を本番同様 stdin JSON で起動する。
// 戻り値: { status, decision, reason, stdout, stderr }
//   decision: "allow"（出力なし・exit 0）| "deny" | "unknown"
// env 既定: CR_GATE_FILES / CR_GATE_LINES で git diff を差し替え（テストは git repo 不要）、
// CR_GATE_DISABLE は空で明示上書き（親環境の混入を防ぐ）。
export function runGate(transcriptLines, { command = "gh pr create --fill", env = {} } = {}) {
  const dir = tempDir("gate-test-");
  const transcriptPath = join(dir, "transcript.jsonl");
  writeFileSync(transcriptPath, transcriptLines.join("\n") + "\n", "utf8");
  const input = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command },
    transcript_path: transcriptPath,
    cwd: dir,
  });
  return runHook(GATE, input, {
    CR_GATE_FILES: "src/foo.ts",
    CR_GATE_LINES: "50",
    ...env,
  });
}

export function runHook(hookPath, stdinText, env = {}) {
  const res = spawnSync(process.execPath, [hookPath], {
    input: stdinText,
    encoding: "utf8",
    env: { ...process.env, CR_GATE_DISABLE: "", ...env },
  });
  let decision = "unknown";
  let reason = "";
  const out = (res.stdout || "").trim();
  if (res.status === 0 && out === "") {
    decision = "allow";
  } else if (out) {
    try {
      const parsed = JSON.parse(out);
      decision = parsed?.hookSpecificOutput?.permissionDecision ?? "unknown";
      reason = parsed?.hookSpecificOutput?.permissionDecisionReason ?? "";
    } catch {
      decision = "unknown";
    }
  }
  return { status: res.status, decision, reason, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}
