// security-review-nudge.mjs（PostToolUse）と lib/security-signals.mjs の検証。
//
// 観点:
//   1. 感応判定（依存変更 / 感応パス / 追加行キーワード）の OR
//   2. 感応な変更を含む PR 作成成功後に /security-review を促す（非ブロック）
//   3. 非感応・失敗した PR 作成・gh pr create 以外・DISABLE では促さない
//   4. 今回の PR 作業で既に security-review 済みなら促さない（transcript 走査）

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { successfulPrCreate, toolResult, toolUse, tempDir } from "./helpers.mjs";
import {
  isDepManifest,
  securityReasons,
  sensitivePath,
} from "../skills/setup-github/templates/base/hooks/lib/security-signals.mjs";
/* global process */

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, "..", "skills", "setup-github", "templates", "base", "hooks", "security-review-nudge.mjs");

// 感応判定を env 差し替え（SECURITY_NUDGE_FILES/ADDED）で走らせ、nudge の有無と本文を返す。
function runNudge({
  command = "gh pr create --fill",
  stdout = "https://github.com/acme/repo/pull/9",
  files = "",
  added = "",
  transcript = null,
  env = {},
} = {}) {
  const dir = tempDir("secnudge-");
  let transcriptPath = "";
  if (transcript !== null) {
    transcriptPath = join(dir, "t.jsonl");
    writeFileSync(transcriptPath, transcript.join("\n") + "\n", "utf8");
  }
  const input = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command },
    tool_response: { stdout },
    transcript_path: transcriptPath,
    cwd: dir,
  });
  const res = spawnSync(process.execPath, [HOOK], {
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      SECURITY_NUDGE_DISABLE: "",
      SECURITY_NUDGE_FILES: files,
      SECURITY_NUDGE_ADDED: added,
      ...env,
    },
  });
  const out = (res.stdout || "").trim();
  if (res.status === 0 && out === "") return { nudged: false, context: "" };
  try {
    const p = JSON.parse(out);
    return { nudged: true, context: p?.hookSpecificOutput?.additionalContext ?? "" };
  } catch {
    return { nudged: false, context: "", raw: out };
  }
}

// ---- lib/security-signals.mjs（純粋関数） ----

test("依存マニフェストを検出する", () => {
  assert.ok(isDepManifest("package.json"));
  assert.ok(isDepManifest("src/app.csproj"));
  assert.ok(isDepManifest("Packages/manifest.json"));
  assert.ok(!isDepManifest("src/index.ts"));
});

test("感応パス/名を検出する", () => {
  assert.ok(sensitivePath("src/auth/login.ts"));
  assert.ok(sensitivePath("app/session_store.py"));
  assert.ok(!sensitivePath("src/ui/button.tsx"));
});

test("securityReasons: 依存 / パス / キーワードの OR で理由を返す", () => {
  assert.deepEqual(securityReasons({ files: ["README.md"], addedLines: ["hello world"] }), []);
  assert.ok(securityReasons({ files: ["package.json"], addedLines: [] }).length === 1);
  assert.ok(
    securityReasons({ files: ["src/x.ts"], addedLines: ["const p = crypto.randomBytes(16)"] })
      .some((r) => r.includes("暗号"))
  );
  assert.ok(
    securityReasons({ files: ["src/x.ts"], addedLines: ["child_process.execSync(cmd)"] })
      .some((r) => r.includes("外部コマンド"))
  );
});

// ---- hook（PostToolUse） ----

test("感応な変更を含む PR 作成成功後は /security-review を促す", () => {
  const r = runNudge({ files: "src/auth/login.ts", added: "const token = signJwt(user)" });
  assert.equal(r.nudged, true);
  assert.match(r.context, /\/security-review/);
});

test("非感応な変更（docs のみ）では促さない", () => {
  const r = runNudge({ files: "README.md\ndocs/guide.md", added: "# 見出し\n本文" });
  assert.equal(r.nudged, false);
});

test("PR 作成が失敗（stdout に PR URL なし）なら促さない", () => {
  const r = runNudge({ stdout: "pull request failed", files: "src/auth.ts", added: "crypto" });
  assert.equal(r.nudged, false);
});

test("gh pr create 以外のコマンドでは促さない", () => {
  const r = runNudge({ command: "git status", files: "src/auth.ts", added: "crypto" });
  assert.equal(r.nudged, false);
});

test("SECURITY_NUDGE_DISABLE=1 で全体無効化", () => {
  const r = runNudge({ files: "src/auth.ts", added: "crypto", env: { SECURITY_NUDGE_DISABLE: "1" } });
  assert.equal(r.nudged, false);
});

test("今回の PR 作業で security-review 済みなら促さない", () => {
  const transcript = [
    toolUse("Skill", { skill: "security-review", args: "" }, "sr"),
    toolResult("sr", "セキュリティレビュー完了。指摘 0 件。"),
    ...successfulPrCreate("pr"),
  ];
  const r = runNudge({ files: "src/auth/login.ts", added: "crypto.randomBytes(16)", transcript });
  assert.equal(r.nudged, false);
});

test("前 PR で review 済みでも、今回の PR 作業で未実施なら促す", () => {
  // 成功した PR 作成が 2 回。security-review は 1 本目より前（前 PR の作業）にだけある。
  const transcript = [
    toolUse("Skill", { skill: "security-review", args: "" }, "sr0"),
    toolResult("sr0", "done"),
    ...successfulPrCreate("pr1"),
    ...successfulPrCreate("pr2"),
  ];
  const r = runNudge({ files: "src/auth/login.ts", added: "crypto.randomBytes(16)", transcript });
  assert.equal(r.nudged, true);
});
