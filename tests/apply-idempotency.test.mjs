// apply.mjs の冪等性テスト（再実行安全・既存設定温存）。
//
// 観点:
//   1. 初回適用でファイル・settings.json・CLAUDE.md（3 bullet）が揃う
//   2. フラグ無し再実行で review-config が温存され、settings / CLAUDE.md が重複しない
//   3. 旧版配備（security bullet 無しの CLAUDE.md）への再実行で security bullet だけが
//      既存の「## 開発ワークフロー」節へ追加される（配布シナリオの再現）

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { APPLY, tempDir } from "./helpers.mjs";
/* global process */

function runApply(target, args = []) {
  const res = spawnSync(process.execPath, [APPLY, target, ...args], { encoding: "utf8" });
  assert.equal(res.status, 0, `apply.mjs failed: ${res.stderr}\n${res.stdout}`);
  return res.stdout;
}

const count = (haystack, needle) => haystack.split(needle).length - 1;

const MARKS = ["**ブランチ**:", "**簡素化**:", "**セキュリティレビュー**:"];

test("初回適用 → 再実行で重複せず、review-config が温存される", () => {
  const target = tempDir("apply-test-");
  runApply(target, ["--review-targets=src"]);

  // 初回: 配置物
  for (const f of [
    ".claude/hooks/pr-code-review-gate.mjs",
    ".claude/hooks/code-review-effort-nudge.mjs",
    ".claude/hooks/setup-sync-check.mjs",
    ".claude/hooks/lib/reviewable-files.mjs",
    ".claude/hooks/review-config.json",
    ".claude/setup-sync-state.json",
    ".githooks/pre-push",
  ]) {
    assert.ok(existsSync(join(target, f)), `${f} が配置されていない`);
  }

  // 状態ファイル: setup-github キーに現行プラグイン版と有効フラグが入る
  const pluginVersion = JSON.parse(
    readFileSync(join(APPLY, "..", "..", "..", ".claude-plugin", "plugin.json"), "utf8")
  ).version;
  const sync1 = JSON.parse(readFileSync(join(target, ".claude", "setup-sync-state.json"), "utf8"));
  assert.equal(sync1["setup-github"].version, pluginVersion);
  assert.deepEqual(sync1["setup-github"].flags, [
    "--review-targets=src",
    "--review-excludes=.claude,.github,.githooks",
  ]);
  const cfg1 = JSON.parse(readFileSync(join(target, ".claude", "hooks", "review-config.json"), "utf8"));
  assert.deepEqual(cfg1.reviewTargets, ["src/"]);
  assert.deepEqual(cfg1.reviewExcludes, [".claude/", ".github/", ".githooks/"]);

  const md1 = readFileSync(join(target, ".claude", "CLAUDE.md"), "utf8");
  for (const m of MARKS) assert.equal(count(md1, m), 1, `${m} が 1 回でない`);

  const settings1 = JSON.parse(readFileSync(join(target, ".claude", "settings.json"), "utf8"));
  // gate / nudge は登録解除（休眠）方針: ファイルは配るが settings.json には載せない。
  assert.ok(!settings1.hooks.PreToolUse, "gate/nudge が PreToolUse に登録されている（休眠のはず）");
  assert.equal(settings1.hooks.SessionStart.length, 2); // core.hooksPath + setup-sync-check

  // 再実行（フラグ無し）: 温存・重複なし
  const out2 = runApply(target);
  assert.match(out2, /src\/（配備済み設定を温存）/);

  const cfg2 = JSON.parse(readFileSync(join(target, ".claude", "hooks", "review-config.json"), "utf8"));
  assert.deepEqual(cfg2, cfg1, "再実行で review-config が変わった");

  const md2 = readFileSync(join(target, ".claude", "CLAUDE.md"), "utf8");
  for (const m of MARKS) assert.equal(count(md2, m), 1, `再実行で ${m} が重複した`);

  const settings2 = JSON.parse(readFileSync(join(target, ".claude", "settings.json"), "utf8"));
  assert.ok(!settings2.hooks.PreToolUse, "再実行で gate/nudge が登録された（休眠のはず）");
  assert.equal(settings2.hooks.SessionStart.length, 2, "再実行で SessionStart が重複した");

  // 再実行で状態ファイルの setup-github キーが温存される（同版・同フラグ）
  const sync2 = JSON.parse(readFileSync(join(target, ".claude", "setup-sync-state.json"), "utf8"));
  assert.deepEqual(sync2["setup-github"], sync1["setup-github"], "再実行で setup-github の記録が変わった");
});

test("旧版配備への再実行: 旧レビュー行が /simplify へ移行し security bullet が追加される", () => {
  const target = tempDir("apply-test-");
  mkdirSync(join(target, ".claude"), { recursive: true });
  // 旧版 setup-github 適用済みの CLAUDE.md を再現（security bullet 無し・後続節あり）
  const oldMd = [
    "# プロジェクト規約",
    "",
    "## 開発ワークフロー",
    "",
    "- **ブランチ**: 実装前に必ずデフォルトブランチから作業ブランチを切る。デフォルトブランチへの直接コミット・直接 push は禁止。変更は必ず作業ブランチ経由の PR で入れる",
    "- **レビュー**: PR 作成前（変更コミット後）に `node .claude/hooks/pr-code-review-gate.mjs --required` で推奨 effort を確認し、`/code-review <effort>` と effort を明示して 1 回実行する（effort 未指定の起動は hook が差し戻す。実行漏れは PR 作成時にブロック）",
    "",
    "## ビルド",
    "",
    "- ここはプロジェクト固有の節（触られないこと）",
    "",
  ].join("\n");
  writeFileSync(join(target, ".claude", "CLAUDE.md"), oldMd, "utf8");

  runApply(target);

  const md = readFileSync(join(target, ".claude", "CLAUDE.md"), "utf8");
  for (const m of MARKS) assert.equal(count(md, m), 1, `${m} が 1 回でない`);
  // 旧 code-review 行は /simplify へ移行し、旧「**レビュー**:」マーカーは残らない。
  assert.match(md, /- \*\*簡素化\*\*: PR 作成前.*`\/simplify`/);
  assert.ok(!md.includes("**レビュー**:"), "旧レビュー行が移行されずに残っている");
  assert.ok(!md.includes("/code-review"), "撤去したはずの /code-review 案内が残っている");
  // security bullet はワークフロー節内（「## ビルド」より前）に入る
  assert.ok(
    md.indexOf("**セキュリティレビュー**:") < md.indexOf("## ビルド"),
    "security bullet がワークフロー節の外に追加された"
  );
  assert.match(md, /- ここはプロジェクト固有の節（触られないこと）/);
});

test("旧版が登録した gate/nudge(PreToolUse) は再実行で登録解除され、他人の hook は残る", () => {
  const target = tempDir("apply-test-");
  mkdirSync(join(target, ".claude"), { recursive: true });
  // 旧版 setup-github 適用済みの settings.json を再現（gate + nudge + ユーザー独自 hook）。
  const legacy = {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/pr-code-review-gate.mjs"',
              if: "Bash(gh pr create *)",
              timeout: 30,
            },
          ],
        },
        {
          matcher: "Skill|SlashCommand",
          hooks: [
            {
              type: "command",
              command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/code-review-effort-nudge.mjs"',
              timeout: 30,
            },
          ],
        },
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: "node /somewhere/user-own-hook.mjs" }],
        },
      ],
    },
  };
  writeFileSync(join(target, ".claude", "settings.json"), JSON.stringify(legacy, null, 2) + "\n", "utf8");

  const out = runApply(target);
  assert.match(out, /pr-code-review-gate\.mjs\): deregistered/);
  assert.match(out, /code-review-effort-nudge\.mjs\): deregistered/);

  const settings = JSON.parse(readFileSync(join(target, ".claude", "settings.json"), "utf8"));
  const commands = (settings.hooks.PreToolUse ?? []).flatMap((g) => (g.hooks ?? []).map((h) => h.command));
  assert.ok(!commands.some((c) => c.includes("pr-code-review-gate.mjs")), "gate が残っている");
  assert.ok(!commands.some((c) => c.includes("code-review-effort-nudge.mjs")), "nudge が残っている");
  // ユーザー独自の hook は温存される。
  assert.ok(commands.some((c) => c.includes("user-own-hook.mjs")), "他人の hook を巻き添えで消した");
});

test("--no-pre-push 初回: pre-push を配らず core.hooksPath も登録しない", () => {
  const target = tempDir("apply-test-");
  const out = runApply(target, ["--no-pre-push"]);
  assert.match(out, /ブランチ保護 pre-push: 無効/);

  assert.ok(!existsSync(join(target, ".githooks", "pre-push")), "pre-push が配置されている");

  // SessionStart は setup-sync-check のみ（core.hooksPath は撒く git hook が無いので登録しない）。
  const settings = JSON.parse(readFileSync(join(target, ".claude", "settings.json"), "utf8"));
  const ss = settings.hooks.SessionStart ?? [];
  const cmds = ss.flatMap((g) => (g.hooks ?? []).map((h) => h.command));
  assert.ok(!cmds.some((c) => c.includes("core.hooksPath")), "core.hooksPath が登録されている");
  assert.ok(cmds.some((c) => c.includes("setup-sync-check.mjs")), "setup-sync-check が登録されていない");

  // sync-state に --no-pre-push が記録され、無人再適用へ引き継がれる。
  const sync = JSON.parse(readFileSync(join(target, ".claude", "setup-sync-state.json"), "utf8"));
  assert.ok(sync["setup-github"].flags.includes("--no-pre-push"), "flags に --no-pre-push が無い");
});

test("既定で入れた pre-push は --no-pre-push 再実行で削除され core.hooksPath も解除される", () => {
  const target = tempDir("apply-test-");
  runApply(target); // 既定 ON
  assert.ok(existsSync(join(target, ".githooks", "pre-push")), "初回で pre-push が入らない");
  const s1 = JSON.parse(readFileSync(join(target, ".claude", "settings.json"), "utf8"));
  assert.equal(s1.hooks.SessionStart.length, 2); // core.hooksPath + setup-sync-check

  const out = runApply(target, ["--no-pre-push"]);
  assert.match(out, /core\.hooksPath\): deregistered/);

  assert.ok(!existsSync(join(target, ".githooks", "pre-push")), "opt-out 再実行で pre-push が消えていない");
  const s2 = JSON.parse(readFileSync(join(target, ".claude", "settings.json"), "utf8"));
  const cmds = (s2.hooks.SessionStart ?? []).flatMap((g) => (g.hooks ?? []).map((h) => h.command));
  assert.ok(!cmds.some((c) => c.includes("core.hooksPath")), "core.hooksPath が解除されていない");
  assert.ok(cmds.some((c) => c.includes("setup-sync-check.mjs")), "setup-sync-check まで巻き添えで消えた");
});

test("--no-pre-push でも pr-copilot があれば core.hooksPath は登録される（pre-commit のため）", () => {
  const target = tempDir("apply-test-");
  runApply(target, ["--no-pre-push", "--pr-copilot"]);

  assert.ok(!existsSync(join(target, ".githooks", "pre-push")), "pre-push が入っている");
  assert.ok(existsSync(join(target, ".githooks", "pre-commit")), "pr-copilot の pre-commit が入っていない");

  const settings = JSON.parse(readFileSync(join(target, ".claude", "settings.json"), "utf8"));
  const cmds = settings.hooks.SessionStart.flatMap((g) => (g.hooks ?? []).map((h) => h.command));
  assert.ok(cmds.some((c) => c.includes("core.hooksPath")), "githook があるのに core.hooksPath 未登録");
});

test("pr-copilot 配備済みはフラグ無し再実行でも自動継承される", () => {
  const target = tempDir("apply-test-");
  runApply(target, ["--pr-copilot"]);
  assert.ok(existsSync(join(target, ".claude", "hooks", "after-pr-create.mjs")));

  const out = runApply(target); // フラグ無し
  assert.match(out, /pr-copilot は配備済みを自動継承/);
  const settings = JSON.parse(readFileSync(join(target, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.hooks.PostToolUse.length, 1);
});
