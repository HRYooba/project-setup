// テンプレート更新の検知（sync-setup-state.json + sync-setup-check.mjs）のテスト。
//
// 観点:
//   1. setup-github apply が状態ファイルを書く（版・pr-copilot フラグ込み）
//   2. setup-github / setup-unity が同じ状態ファイルに各自のキーをマージ（相手を消さない）
//   3. hook: 状態ファイル無し / 版一致 / ダウングレード方向 / 壊れた JSON → 何も出さない
//   4. SessionStart hook: 現行版が新しい → systemMessage だけ出す（人へ知らせる役）
//   5. UserPromptSubmit hook: 最初のプロンプトを updatedInput で包んで /sync-setup を実行させる
//      （SessionStart ではモデルが呼ばれないため、実行のトリガーはこちらが持つ）
//   6. hook: 子プロセスを起こさない（同期は /sync-setup 側で走らせる）
//   7. hook: SYNC_SETUP_DISABLE=1 で黙る（避難口）

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { APPLY, APPLY_UNITY, HOOKS_DIR, SYNC_HOOK, SYNC_PROMPT_HOOK, tempDir } from "./helpers.mjs";
/* global process */

function runApply(applyPath, target, args = []) {
  const res = spawnSync(process.execPath, [applyPath, target, ...args], { encoding: "utf8" });
  assert.equal(res.status, 0, `apply failed: ${res.stderr}\n${res.stdout}`);
  return res.stdout;
}

const PLUGIN_VERSION = JSON.parse(
  readFileSync(join(APPLY, "..", "..", "..", ".claude-plugin", "plugin.json"), "utf8")
).version;

// 偽の installed_plugins.json を書いて hook を本番同様 stdin JSON で起動する。
// 戻り値 stdout（空 = 何も注入しない）。
function fakePluginsJson(currentVersion, installPath = "C:/fake/project-setup/1.2.0") {
  const dir = tempDir("sync-plugins-");
  const pluginsJson = join(dir, "installed_plugins.json");
  writeFileSync(
    pluginsJson,
    JSON.stringify({
      version: 2,
      plugins: {
        "project-setup@hryooba": [
          { scope: "user", installPath, version: currentVersion, lastUpdated: "2026-07-21T00:00:00.000Z" },
        ],
      },
    }),
    "utf8"
  );
  return pluginsJson;
}

function runSyncHook(projectDir, currentVersion, { installPath = "C:/fake/project-setup/1.2.0", env = {} } = {}) {
  const pluginsJson = fakePluginsJson(currentVersion, installPath);
  const res = spawnSync(process.execPath, [SYNC_HOOK], {
    input: JSON.stringify({ hook_event_name: "SessionStart", cwd: projectDir }),
    encoding: "utf8",
    env: { ...process.env, SYNC_SETUP_PLUGINS_JSON: pluginsJson, CLAUDE_PROJECT_DIR: projectDir, SYNC_SETUP_DISABLE: "", ...env },
  });
  assert.equal(res.status, 0, `hook exited non-zero: ${res.stderr}`);
  return res.stdout.trim();
}

function writeState(projectDir, obj) {
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  writeFileSync(join(projectDir, ".claude", "sync-setup-state.json"), JSON.stringify(obj, null, 2) + "\n", "utf8");
}

test("setup-github apply が状態ファイルへ版と pr-copilot フラグを記録する", () => {
  const target = tempDir("sync-gh-");
  runApply(APPLY, target, ["--pr-copilot", "--review-targets=src,shared"]);
  const state = JSON.parse(readFileSync(join(target, ".claude", "sync-setup-state.json"), "utf8"));
  assert.equal(state["setup-github"].version, PLUGIN_VERSION);
  assert.ok(state["setup-github"].flags.includes("--pr-copilot"));
  assert.ok(state["setup-github"].flags.includes("--review-targets=src,shared"));
});

test("setup-github と setup-unity が状態ファイルへ各自のキーをマージ（相手を消さない）", () => {
  const target = tempDir("sync-merge-");
  // 先に setup-unity（Unity プロジェクトの体裁を用意）
  mkdirSync(join(target, "ProjectSettings"), { recursive: true });
  writeFileSync(join(target, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 2022.3.0f1\n", "utf8");
  runApply(APPLY_UNITY, target, ["--architecture"]);
  let state = JSON.parse(readFileSync(join(target, ".claude", "sync-setup-state.json"), "utf8"));
  assert.equal(state["setup-unity"].version, PLUGIN_VERSION);
  assert.ok(state["setup-unity"].flags.includes("--architecture"));
  assert.ok(!state["setup-unity"].flags.includes("--mcp"), "廃止された --mcp が保存されている");

  // 続けて setup-github → 両キーが揃う
  runApply(APPLY, target);
  state = JSON.parse(readFileSync(join(target, ".claude", "sync-setup-state.json"), "utf8"));
  assert.ok(state["setup-github"], "setup-github キーが無い");
  assert.ok(state["setup-unity"], "setup-github 適用で setup-unity キーが消えた");
  assert.ok(state["setup-unity"].flags.includes("--architecture"), "setup-unity のフラグが失われた");
});

test("setup-unity: 状態ファイルに残った旧フラグ --mcp を渡されても止まらない", () => {
  // テンプレ同期は state に記録されたフラグをそのまま再適用する。--mcp は Unity CLI 固定で
  // 消えたフラグなので、エラー終了すると配備先の同期が永久に失敗する。
  const target = tempDir("sync-legacy-mcp-");
  mkdirSync(join(target, "ProjectSettings"), { recursive: true });
  writeFileSync(join(target, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.3.9f1\n", "utf8");
  const out = runApply(APPLY_UNITY, target, ["--architecture", "--mcp", "mcp-for-unity"]);
  assert.match(out, /--mcp mcp-for-unity は無視しました/);
  const state = JSON.parse(readFileSync(join(target, ".claude", "sync-setup-state.json"), "utf8"));
  assert.deepEqual(state["setup-unity"].flags, ["--architecture"], "旧フラグが state に残っている");
});

test("旧名の状態ファイルは apply で新名へ移行される（追随が黙って止まらない）", () => {
  // 旧名のまま残すと sync-run.mjs / sync-setup-check.mjs が記録版を読めず、
  // その配備先が丸ごと「同期対象外」になる。エラーも出ないので気づけない。
  const target = tempDir("sync-migrate-");
  mkdirSync(join(target, ".claude"), { recursive: true });
  const legacy = { "setup-github": { version: "1.0.0", flags: ["--pr-copilot"] } };
  writeFileSync(
    join(target, ".claude", "setup-sync-state.json"),
    JSON.stringify(legacy, null, 2) + "\n",
    "utf8"
  );

  const out = runApply(APPLY, target);

  assert.ok(!existsSync(join(target, ".claude", "setup-sync-state.json")), "旧名が残っている");
  const state = JSON.parse(readFileSync(join(target, ".claude", "sync-setup-state.json"), "utf8"));
  assert.equal(state["setup-github"].version, PLUGIN_VERSION, "新名へ移った後に版が更新されていない");
  assert.match(out, /setup-sync-state\.json → sync-setup-state\.json/);
});

// 改名のたびにキーを引き継がずに捨てていたため、正名側に setup-github だけ、最初期の旧名側に
// setup-unity だけが残った配備先が実在する。畳まずに消すと setup-unity の追随が永久に止まる。
test("最初期の旧名 .setup-sync.json のキーも正名へ引き継がれる", () => {
  const target = tempDir("sync-migrate-oldest-");
  mkdirSync(join(target, ".claude"), { recursive: true });
  writeFileSync(
    join(target, ".claude", ".setup-sync.json"),
    JSON.stringify({ "setup-unity": { version: "1.3.0", flags: ["--architecture"] } }, null, 2) + "\n",
    "utf8"
  );
  writeFileSync(
    join(target, ".claude", "sync-setup-state.json"),
    JSON.stringify({ "setup-github": { version: "1.3.0", flags: [] } }, null, 2) + "\n",
    "utf8"
  );

  runApply(APPLY, target);

  assert.ok(!existsSync(join(target, ".claude", ".setup-sync.json")), "最初期の旧名が残っている");
  const state = JSON.parse(readFileSync(join(target, ".claude", "sync-setup-state.json"), "utf8"));
  assert.ok(state["setup-unity"], "旧名にしか無かった setup-unity のキーが失われた");
  assert.equal(state["setup-unity"].version, "1.3.0", "引き継いだキーの版が書き換わっている");
  assert.equal(state["setup-github"].version, PLUGIN_VERSION);
});

// hook 側も同じ規則で旧名を読む。読まないと、旧名にしか記録の無いスキルの更新を誰も知らせない。
test("hook: 正名と旧名にキーが散っていても両方のドリフトを知らせる", () => {
  const target = tempDir("sync-hook-mixed-");
  mkdirSync(join(target, ".claude"), { recursive: true });
  writeFileSync(
    join(target, ".claude", "sync-setup-state.json"),
    JSON.stringify({ "setup-github": { version: "1.3.0", flags: [] } }, null, 2) + "\n",
    "utf8"
  );
  writeFileSync(
    join(target, ".claude", ".setup-sync.json"),
    JSON.stringify({ "setup-unity": { version: "1.0.0", flags: ["--architecture"] } }, null, 2) + "\n",
    "utf8"
  );
  const out = JSON.parse(runSyncHook(target, "1.3.0"));
  assert.match(out.systemMessage, /setup-unity v1\.0\.0→v1\.3\.0/);
  assert.doesNotMatch(out.systemMessage, /setup-github v/);
});

test("旧名の SessionStart hook は実体も settings.json 登録も撤去される", () => {
  const target = tempDir("sync-hookrename-");
  mkdirSync(join(target, ".claude", "hooks"), { recursive: true });
  writeFileSync(join(target, ".claude", "hooks", "setup-sync-check.mjs"), "// 旧 hook\n", "utf8");
  writeFileSync(
    join(target, ".claude", "settings.json"),
    JSON.stringify(
      {
        hooks: {
          SessionStart: [
            {
              hooks: [
                { type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/setup-sync-check.mjs"' },
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

  runApply(APPLY, target);

  assert.ok(!existsSync(join(target, ".claude", "hooks", "setup-sync-check.mjs")), "旧 hook の実体が残っている");
  assert.ok(existsSync(join(target, ".claude", "hooks", "sync-setup-check.mjs")), "新 hook が配られていない");
  const settings = JSON.stringify(JSON.parse(readFileSync(join(target, ".claude", "settings.json"), "utf8")));
  assert.ok(!settings.includes("setup-sync-check.mjs"), "settings.json に旧 hook の登録が残っている");
  assert.ok(settings.includes("sync-setup-check.mjs"), "settings.json に新 hook が登録されていない");
});

test("hook: 状態ファイルが無ければ何も注入しない", () => {
  const target = tempDir("sync-none-");
  assert.equal(runSyncHook(target, "9.9.9"), "");
});

test("hook: 版が一致すれば何も注入しない", () => {
  const target = tempDir("sync-match-");
  writeState(target, { "setup-github": { version: PLUGIN_VERSION, flags: [] } });
  assert.equal(runSyncHook(target, PLUGIN_VERSION), "");
});

test("hook: 現行版のほうが古い（ダウングレード）なら何も注入しない", () => {
  const target = tempDir("sync-down-");
  writeState(target, { "setup-github": { version: "9.9.9", flags: [] } });
  assert.equal(runSyncHook(target, "1.0.0"), "");
});

test("hook: 壊れた状態ファイルは黙って無視する", () => {
  const target = tempDir("sync-broken-");
  mkdirSync(join(target, ".claude"), { recursive: true });
  writeFileSync(join(target, ".claude", "sync-setup-state.json"), "{ not json", "utf8");
  assert.equal(runSyncHook(target, "9.9.9"), "");
});


// ---- 更新を検知したときの出力 ----
// hook は知らせるだけ。強制はできない（SessionStart は仕様上ブロックできない）ので、
// **ユーザーの画面に出る systemMessage** を出すことが「気づかれる」ための唯一の手段になる。

test("hook: 現行版が新しければ systemMessage を出す（実行指示は持たない）", () => {
  const target = tempDir("sync-drift-");
  writeState(target, {
    "setup-github": { version: "1.0.0", flags: ["--pr-copilot", "--review-targets=Assets/App"] },
    "setup-unity": { version: "1.0.0", flags: ["--architecture", "--mcp", "mcp-for-unity"] },
  });
  const out = JSON.parse(runSyncHook(target, "1.3.0"));

  // ユーザーの画面に出る行。SessionStart で人が最初に見るのはこれだけ。
  assert.match(out.systemMessage, /setup-github v1\.0\.0→v1\.3\.0/);
  assert.match(out.systemMessage, /setup-unity v1\.0\.0→v1\.3\.0/);
  assert.match(out.systemMessage, /\/sync-setup/);

  // 実行指示は UserPromptSubmit 側が持つ。両方に置くと二重に走る。
  assert.equal(out.hookSpecificOutput, undefined, "SessionStart が実行指示を持っている");
});

test("hook: 子プロセスを起こさない（同期は /sync-setup 側で走らせる）", () => {
  for (const hook of [SYNC_HOOK, SYNC_PROMPT_HOOK, join(HOOKS_DIR, "lib", "sync-setup-drift.mjs")]) {
    const src = readFileSync(hook, "utf8");
    const spawners = [...src.matchAll(/\b(spawn|spawnSync|execFile|execFileSync|exec|execSync)\s*\(/g)];
    assert.deepEqual(
      spawners.map((m) => m[1]),
      [],
      `${hook} が子プロセスを起こしています。ここは検知だけに徹する`
    );
  }
});

test("hook: 片方のスキルだけドリフトしていればそのスキルだけ対象にする", () => {
  const target = tempDir("sync-partial-");
  writeState(target, {
    "setup-github": { version: "1.3.0", flags: [] },
    "setup-unity": { version: "1.0.0", flags: ["--architecture"] },
  });
  const out = JSON.parse(runSyncHook(target, "1.3.0"));
  assert.match(out.systemMessage, /setup-unity v1\.0\.0→v1\.3\.0/);
  assert.doesNotMatch(out.systemMessage, /setup-github v/);
});

test("hook: SYNC_SETUP_DISABLE=1 なら黙る（避難口）", () => {
  const target = tempDir("sync-disable-");
  writeState(target, { "setup-github": { version: "1.0.0", flags: [] } });
  assert.equal(runSyncHook(target, "1.3.0", { env: { SYNC_SETUP_DISABLE: "1" } }), "");
});


// ---- UserPromptSubmit hook（実行のトリガー）----
// SessionStart の時点ではモデルが呼ばれないため、「気づいたのに放置される」を断つのはここ。
// 最初のプロンプトを updatedInput で包み、ユーザー自身の依頼として /sync-setup を先に走らせる。

// prompted 記録は毎回テンポラリへ隔離する（実ホームの ~/.claude/plugins/data を汚さない）。
function runPromptHook(
  projectDir,
  currentVersion,
  { prompt = "READMEを直して", sessionId = "sess-1", promptedJson, env = {} } = {}
) {
  const pluginsJson = fakePluginsJson(currentVersion);
  const res = spawnSync(process.execPath, [SYNC_PROMPT_HOOK], {
    input: JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      cwd: projectDir,
      prompt,
    }),
    encoding: "utf8",
    env: {
      ...process.env,
      SYNC_SETUP_PLUGINS_JSON: pluginsJson,
      CLAUDE_PROJECT_DIR: projectDir,
      SYNC_SETUP_DISABLE: "",
      SYNC_SETUP_PROMPTED_JSON: promptedJson ?? join(tempDir("sync-prompted-"), "prompted.json"),
      ...env,
    },
  });
  assert.equal(res.status, 0, `prompt hook exited non-zero: ${res.stderr}`);
  return res.stdout.trim();
}

test("prompt hook: 版が一致すれば何も注入しない", () => {
  const target = tempDir("sync-p-match-");
  writeState(target, { "setup-github": { version: PLUGIN_VERSION, flags: [] } });
  assert.equal(runPromptHook(target, PLUGIN_VERSION), "");
});

test("prompt hook: 更新があれば updatedInput で元のプロンプトを包む", () => {
  const target = tempDir("sync-p-drift-");
  writeState(target, { "setup-github": { version: "1.0.0", flags: [] } });
  const out = JSON.parse(runPromptHook(target, "1.3.0", { prompt: "READMEを直して" }));

  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const input = out.hookSpecificOutput.updatedInput;
  assert.match(input, /\/project-setup:sync-setup/);
  // 元の依頼を落とさない。落とすとユーザーの用件が消える。
  assert.match(input, /READMEを直して/);
  // 書き換えたことを人に知らせる（打っていない文が会話ログに残るため）。
  assert.match(out.systemMessage, /setup-github v1\.0\.0→v1\.3\.0/);
});

test("prompt hook: 同じセッションでは 1 回だけ差し込む", () => {
  const target = tempDir("sync-p-once-");
  writeState(target, { "setup-github": { version: "1.0.0", flags: [] } });
  const promptedJson = join(tempDir("sync-prompted-"), "prompted.json");

  assert.notEqual(runPromptHook(target, "1.3.0", { promptedJson, sessionId: "s1" }), "");
  assert.equal(runPromptHook(target, "1.3.0", { promptedJson, sessionId: "s1" }), "", "同一セッションで 2 回差し込んだ");
  // 別セッションは別途差し込む。
  assert.notEqual(runPromptHook(target, "1.3.0", { promptedJson, sessionId: "s2" }), "");
});

test("prompt hook: スラッシュコマンドは書き換えず additionalContext で渡す", () => {
  const target = tempDir("sync-p-slash-");
  writeState(target, { "setup-github": { version: "1.0.0", flags: [] } });
  // 先頭に文字を足すと /foo や !cmd の展開が壊れるため、updatedInput を使ってはいけない。
  for (const prompt of ["/code-review", "!git status", "#メモ"]) {
    const out = JSON.parse(runPromptHook(target, "1.3.0", { prompt }));
    assert.equal(out.hookSpecificOutput.updatedInput, undefined, `${prompt} を書き換えている`);
    assert.match(out.hookSpecificOutput.additionalContext, /\/project-setup:sync-setup/);
  }
});

test("prompt hook: session_id が無ければ黙る（毎プロンプト差し込むのを避ける）", () => {
  const target = tempDir("sync-p-nosess-");
  writeState(target, { "setup-github": { version: "1.0.0", flags: [] } });
  assert.equal(runPromptHook(target, "1.3.0", { sessionId: "" }), "");
});

test("prompt hook: SYNC_SETUP_DISABLE=1 なら黙る（避難口）", () => {
  const target = tempDir("sync-p-disable-");
  writeState(target, { "setup-github": { version: "1.0.0", flags: [] } });
  assert.equal(runPromptHook(target, "1.3.0", { env: { SYNC_SETUP_DISABLE: "1" } }), "");
});

test("apply: 両 hook を settings.json へ登録する", () => {
  const target = tempDir("sync-reg-");
  runApply(APPLY, target);
  const settings = JSON.parse(readFileSync(join(target, ".claude", "settings.json"), "utf8"));
  const cmds = (event) =>
    (settings.hooks[event] ?? []).flatMap((g) => (g.hooks ?? []).map((h) => h.command));
  assert.ok(cmds("SessionStart").some((c) => c.includes("sync-setup-check.mjs")));
  assert.ok(cmds("UserPromptSubmit").some((c) => c.includes("sync-setup-prompt.mjs")));
});
