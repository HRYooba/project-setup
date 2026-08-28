// apply.mjs の冪等性テスト（再実行安全・既存設定温存）。
//
// 観点:
//   1. 初回適用でファイル・settings.json・CLAUDE.md（テンプレの全 bullet）が揃う
//   2. フラグ無し再実行で review-config が温存され、settings / CLAUDE.md が重複しない
//   3. rules/*.md と CLAUDE.md は「初回は配る / 同じなら触らない / 差分があれば書かずに
//      要マージとして報告する」（統合は SKILL 手順で Claude が行うので apply.mjs は書かない）

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { APPLY, APPLY_UNITY, tempDir } from "./helpers.mjs";
/* global process */

function run(applyPath, target, args = []) {
  const res = spawnSync(process.execPath, [applyPath, target, ...args], { encoding: "utf8" });
  assert.equal(res.status, 0, `apply failed: ${res.stderr}\n${res.stdout}`);
  return res.stdout;
}
const runApply = (target, args = []) => run(APPLY, target, args);
const runApplyUnity = (target, args = []) => run(APPLY_UNITY, target, args);

const count = (haystack, needle) => haystack.split(needle).length - 1;

// 配る節の見出しはテンプレートが正本。ここに文面を写すと、テンプレの文言を変えるたびに
// 無関係なテストが落ちる（実際に落ちた）。テンプレから箇条書きのラベルを抽出して使う。
const MARKS = readFileSync(join(APPLY, "..", "templates", "claude-md.md"), "utf8")
  .split(/\r?\n/)
  .map((l) => l.match(/^- (\*\*.+?\*\*:)/)?.[1])
  .filter(Boolean);
assert.ok(MARKS.length >= 3, `claude-md.md から箇条書きラベルを抽出できませんでした: ${MARKS}`);

test("初回適用 → 再実行で重複せず、review-config が温存される", () => {
  const target = tempDir("apply-test-");
  runApply(target, ["--review-targets=src"]);

  // 初回: 配置物
  for (const f of [
    ".claude/hooks/sync-setup-check.mjs",
    ".claude/hooks/lib/reviewable-files.mjs",
    ".claude/hooks/review-config.json",
    ".claude/sync-setup-state.json",
    ".githooks/pre-push",
  ]) {
    assert.ok(existsSync(join(target, f)), `${f} が配置されていない`);
  }
  // code-review 用 hook は配らない
  for (const f of [
    ".claude/hooks/pr-code-review-gate.mjs",
    ".claude/hooks/code-review-effort-nudge.mjs",
  ]) {
    assert.ok(!existsSync(join(target, f)), `${f} が配置されている（配布対象外のはず）`);
  }

  // 状態ファイル: setup-github キーに現行プラグイン版と有効フラグが入る
  const pluginVersion = JSON.parse(
    readFileSync(join(APPLY, "..", "..", "..", ".claude-plugin", "plugin.json"), "utf8")
  ).version;
  const sync1 = JSON.parse(readFileSync(join(target, ".claude", "sync-setup-state.json"), "utf8"));
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
  // gate / nudge は配らない。PreToolUse には何も登録しない。
  assert.ok(!settings1.hooks.PreToolUse, "PreToolUse に hook が登録されている（登録しないはず）");
  assert.equal(settings1.hooks.SessionStart.length, 2); // core.hooksPath + sync-setup-check

  // 再実行（フラグ無し）: 温存・重複なし
  const out2 = runApply(target);
  assert.match(out2, /src\/（配備済み設定を温存）/);

  const cfg2 = JSON.parse(readFileSync(join(target, ".claude", "hooks", "review-config.json"), "utf8"));
  assert.deepEqual(cfg2, cfg1, "再実行で review-config が変わった");

  const md2 = readFileSync(join(target, ".claude", "CLAUDE.md"), "utf8");
  for (const m of MARKS) assert.equal(count(md2, m), 1, `再実行で ${m} が重複した`);

  const settings2 = JSON.parse(readFileSync(join(target, ".claude", "settings.json"), "utf8"));
  assert.ok(!settings2.hooks.PreToolUse, "再実行で PreToolUse に hook が登録された（登録しないはず）");
  assert.equal(settings2.hooks.SessionStart.length, 2, "再実行で SessionStart が重複した");

  // 再実行で状態ファイルの setup-github キーが温存される（同版・同フラグ）
  const sync2 = JSON.parse(readFileSync(join(target, ".claude", "sync-setup-state.json"), "utf8"));
  assert.deepEqual(sync2["setup-github"], sync1["setup-github"], "再実行で setup-github の記録が変わった");
});

test("既存 CLAUDE.md がテンプレ節を欠いていれば、書き換えず要マージとして報告する", () => {
  const target = tempDir("apply-test-");
  mkdirSync(join(target, ".claude"), { recursive: true });
  // 現行テンプレには無いレビュー行を持つ CLAUDE.md（統合待ちの配備先を再現）。
  const oldMd = [
    "# プロジェクト規約",
    "",
    "## 開発ワークフロー",
    "",
    "- **ブランチ**: 実装前に必ずデフォルトブランチから作業ブランチを切る。デフォルトブランチへの直接コミット・直接 push は禁止。変更は必ず作業ブランチ経由の PR で入れる",
    "- **レビュー**: PR 作成前に `/code-review` を実行する",
    "",
    "## ビルド",
    "",
    "- ここはプロジェクト固有の節（触られないこと）",
    "",
  ].join("\n");
  writeFileSync(join(target, ".claude", "CLAUDE.md"), oldMd, "utf8");

  const out = runApply(target);

  // apply.mjs は書かない。テンプレに無い行も含めて現物がそのまま残る（統合は Claude が行う）。
  assert.equal(readFileSync(join(target, ".claude", "CLAUDE.md"), "utf8"), oldMd, "CLAUDE.md が書き換えられた");
  assert.match(out, /\.claude\/CLAUDE\.md: 要マージ/);
  // 要マージ節に現物とテンプレ両方のパスが出る（Claude がこれを読んで統合する）。
  assert.match(out, /要マージ（apply\.mjs は書いていない/);
  assert.match(out, /テンプレ: .*claude-md\.md/);
});

test("既存 CLAUDE.md にテンプレ節が揃っていれば、プロジェクト固有の節があっても変更なし", () => {
  const target = tempDir("apply-test-");
  runApply(target); // 初回でテンプレ節が入る
  const before = readFileSync(join(target, ".claude", "CLAUDE.md"), "utf8");
  const withOwn = `${before}\n## ビルド\n\n- ここはプロジェクト固有の節\n`;
  writeFileSync(join(target, ".claude", "CLAUDE.md"), withOwn, "utf8");

  const out = runApply(target);

  assert.match(out, /\.claude\/CLAUDE\.md: 変更なし/);
  assert.equal(readFileSync(join(target, ".claude", "CLAUDE.md"), "utf8"), withOwn, "固有の節が変化した");
});

test("カスタマイズされた rules/*.md は上書きされず要マージとして報告される", () => {
  const target = tempDir("apply-test-");
  runApply(target);
  const rulePath = join(target, ".claude", "rules", "git-conventions.md");
  const customized = `${readFileSync(rulePath, "utf8")}\n## このリポジトリ固有\n\n- main 単一運用\n`;
  writeFileSync(rulePath, customized, "utf8");

  const out = runApply(target);

  assert.match(out, /\.claude\/rules\/git-conventions\.md: 要マージ/);
  assert.equal(readFileSync(rulePath, "utf8"), customized, "カスタマイズが上書きされた");
});

test("gate/nudge(PreToolUse) の登録は再実行で解除され、他人の hook は残る", () => {
  const target = tempDir("apply-test-");
  mkdirSync(join(target, ".claude"), { recursive: true });
  // gate + nudge + ユーザー独自 hook が登録済みの settings.json を再現する。
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

test("配備済みの code-review 用 hook 実体は再実行で削除される（lib は残る）", () => {
  const target = tempDir("apply-test-");
  runApply(target); // 新版初回（gate/nudge は配られない）
  // 配備先に残っている hook 実体を再現する。
  const gate = join(target, ".claude", "hooks", "pr-code-review-gate.mjs");
  const nudge = join(target, ".claude", "hooks", "code-review-effort-nudge.mjs");
  writeFileSync(gate, "// legacy gate\n", "utf8");
  writeFileSync(nudge, "// legacy nudge\n", "utf8");

  const out = runApply(target);
  assert.match(out, /pr-code-review-gate\.mjs（配布対象外）/);
  assert.match(out, /code-review-effort-nudge\.mjs（配布対象外）/);
  assert.ok(!existsSync(gate), "gate 実体が削除されていない");
  assert.ok(!existsSync(nudge), "nudge 実体が削除されていない");
  // reviewable-files.mjs は Copilot 判定に使うので残す。
  assert.ok(
    existsSync(join(target, ".claude", "hooks", "lib", "reviewable-files.mjs")),
    "lib を巻き添えで消した"
  );
});

test("setup-unity: カスタマイズされた rules/*.md は cpSync に上書きされず要マージになる", () => {
  const target = tempDir("apply-test-");
  mkdirSync(join(target, "ProjectSettings"), { recursive: true });
  writeFileSync(join(target, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 2022.3.0f1\n", "utf8");
  runApplyUnity(target);

  const rulePath = join(target, ".claude", "rules", "testing.md");
  const customized = `${readFileSync(rulePath, "utf8")}\n## このプロジェクト固有\n\n- 追記した規約\n`;
  writeFileSync(rulePath, customized, "utf8");
  // 触っていない規約は「変更なし」のままであることも同時に確かめる。
  const untouched = readFileSync(join(target, ".claude", "rules", "hierarchy.md"), "utf8");

  const out = runApplyUnity(target);

  assert.match(out, /rules\/testing\.md: 要マージ/);
  assert.match(out, /rules\/hierarchy\.md: 変更なし/);
  assert.equal(readFileSync(rulePath, "utf8"), customized, "cpSync がカスタマイズを上書きした");
  assert.equal(readFileSync(join(target, ".claude", "rules", "hierarchy.md"), "utf8"), untouched);
  // 要マージのファイルは「配置ファイル」に出さない（実際に書いていないため）。
  const placed = out.slice(out.indexOf("配置ファイル:"), out.indexOf("Markdown（"));
  assert.ok(!placed.includes("rules/testing.md"), "書いていないファイルが配置ファイルに出ている");
});

test("setup-unity: このスキルが配らないファイルは再適用で取り除かれる", () => {
  // 残ると rules/unity-cli.md と並んで常時コンテキストに載り、Unity 操作の手順が
  // 二重になる。カスタマイズ扱いで温存してはいけない。
  const target = tempDir("apply-test-");
  mkdirSync(join(target, "ProjectSettings"), { recursive: true });
  writeFileSync(join(target, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.3.9f1\n", "utf8");
  runApplyUnity(target);

  const legacy = [
    ["rules", "unity-mcp.md"],
    ["rules", "unity-mcp-tools.md"],
    ["skills", "test-unity", "references", "unity-mcp-tools.md"],
    ["skills", "lint-unity", "references", "unity-mcp-tools.md"],
  ];
  for (const parts of legacy) {
    const p = join(target, ".claude", ...parts);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "<!-- binding: mcp-for-unity -->\n# 旧バインディング表\n", "utf8");
  }

  const out = runApplyUnity(target);

  for (const parts of legacy) {
    assert.ok(!existsSync(join(target, ".claude", ...parts)), `${parts.join("/")} が残っている`);
  }
  assert.match(out, /取り除いたファイル/);
  // 旧 rules が「要マージ」へ回ると消えないまま残るので、そこに出ていないことも確かめる
  assert.ok(!out.includes("rules/unity-mcp.md: 要マージ"), "取り除く対象が要マージへ回っている");
  assert.ok(existsSync(join(target, ".claude", "rules", "unity-cli.md")), "rules/unity-cli.md が無い");
});

test("--no-pre-push 初回: pre-push を配らず core.hooksPath も登録しない", () => {
  const target = tempDir("apply-test-");
  const out = runApply(target, ["--no-pre-push"]);
  assert.match(out, /ブランチ保護 pre-push: 無効/);

  assert.ok(!existsSync(join(target, ".githooks", "pre-push")), "pre-push が配置されている");

  // SessionStart は sync-setup-check のみ（core.hooksPath は撒く git hook が無いので登録しない）。
  const settings = JSON.parse(readFileSync(join(target, ".claude", "settings.json"), "utf8"));
  const ss = settings.hooks.SessionStart ?? [];
  const cmds = ss.flatMap((g) => (g.hooks ?? []).map((h) => h.command));
  assert.ok(!cmds.some((c) => c.includes("core.hooksPath")), "core.hooksPath が登録されている");
  assert.ok(cmds.some((c) => c.includes("sync-setup-check.mjs")), "sync-setup-check が登録されていない");

  // sync-state に --no-pre-push が記録され、無人再適用へ引き継がれる。
  const sync = JSON.parse(readFileSync(join(target, ".claude", "sync-setup-state.json"), "utf8"));
  assert.ok(sync["setup-github"].flags.includes("--no-pre-push"), "flags に --no-pre-push が無い");
});

test("既定で入れた pre-push は --no-pre-push 再実行で削除され core.hooksPath も解除される", () => {
  const target = tempDir("apply-test-");
  runApply(target); // 既定 ON
  assert.ok(existsSync(join(target, ".githooks", "pre-push")), "初回で pre-push が入らない");
  const s1 = JSON.parse(readFileSync(join(target, ".claude", "settings.json"), "utf8"));
  assert.equal(s1.hooks.SessionStart.length, 2); // core.hooksPath + sync-setup-check

  const out = runApply(target, ["--no-pre-push"]);
  assert.match(out, /core\.hooksPath\): deregistered/);

  assert.ok(!existsSync(join(target, ".githooks", "pre-push")), "opt-out 再実行で pre-push が消えていない");
  const s2 = JSON.parse(readFileSync(join(target, ".claude", "settings.json"), "utf8"));
  const cmds = (s2.hooks.SessionStart ?? []).flatMap((g) => (g.hooks ?? []).map((h) => h.command));
  assert.ok(!cmds.some((c) => c.includes("core.hooksPath")), "core.hooksPath が解除されていない");
  assert.ok(cmds.some((c) => c.includes("sync-setup-check.mjs")), "sync-setup-check まで巻き添えで消えた");
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

// 同期結果の報告 hook（UserPromptSubmit）は配らない。同期はユーザーのセッションで走り、
// 結果は会話にそのまま出るため。実体と settings.json 登録の両方を掃除する。
test("配備済みの setup-sync-report は実体も settings.json 登録も撤去される", () => {
  const target = tempDir("apply-test-");
  mkdirSync(join(target, ".claude", "hooks"), { recursive: true });
  writeFileSync(join(target, ".claude", "hooks", "setup-sync-report.mjs"), "// 配備先に残った実体\n", "utf8");
  writeFileSync(
    join(target, ".claude", "settings.json"),
    JSON.stringify(
      {
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/setup-sync-report.mjs"',
                  timeout: 10,
                },
              ],
            },
          ],
        },
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  const out = runApply(target);

  assert.ok(
    !existsSync(join(target, ".claude", "hooks", "setup-sync-report.mjs")),
    "setup-sync-report.mjs の実体が残っている"
  );
  assert.match(out, /setup-sync-report\.mjs\): deregistered/);
  const settings = JSON.parse(readFileSync(join(target, ".claude", "settings.json"), "utf8"));
  assert.ok(!settings.hooks.UserPromptSubmit, "UserPromptSubmit の登録が残っている");
});
