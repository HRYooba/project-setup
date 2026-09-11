// アプリ本体の置き場（--app-root）が、規約の適用範囲すべてへ一貫して届くかの検証。
//
// この値は 4 箇所へ効く。1 箇所でも取りこぼすと「lint は見るのに analyzer は見ない」
// といった無音の食い違いになる（どれもエラーを出さずにすり抜ける）:
//   - .claude/rules/folder-structure.md        規約の文面
//   - .claude/skills/lint-unity/SKILL.md       paths: と走査コマンド
//   - Assets/Analyzers/analyzable-root.txt     Roslyn analyzer の解析対象
//   - .claude/hooks/review-config.json         レビュー対象（--review-target 指定時）
//
// 観点:
//   1. 既定は Assets/App/（無指定でも従来どおり）
//   2. 指定すると上の 4 箇所すべてが揃う
//   3. テンプレートに素の Assets/App が残っていない（トークン化の漏れ検知）
//   4. 配置物に {{APP_ROOT}} が残らない
//   5. Assets/ 配下でない値と空値は落とす
//   6. 書式のゆらぎを吸収する
//   7. 既定以外のときだけ state へ記録する（テンプレ同期が同じ形で再適用する）
//   8. 同じ値で再実行しても要マージにならない

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { APPLY_UNITY, tempDir } from "./helpers.mjs";
/* global process */

const here = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(here, "..", "skills", "setup-unity", "templates");
const MARKER = join("Assets", "Analyzers", "analyzable-root.txt");

function unityProject({ reviewConfig = false } = {}) {
  const target = tempDir("setup-unity-approot-");
  mkdirSync(join(target, "ProjectSettings"), { recursive: true });
  writeFileSync(
    join(target, "ProjectSettings", "ProjectVersion.txt"),
    "m_EditorVersion: 6000.3.18f1\n",
    "utf8"
  );
  if (reviewConfig) {
    mkdirSync(join(target, ".claude", "hooks"), { recursive: true });
    writeFileSync(
      join(target, ".claude", "hooks", "review-config.json"),
      JSON.stringify({ reviewTargets: [], reviewExcludes: [".claude/"] }, null, 2) + "\n",
      "utf8"
    );
  }
  return target;
}

function runApply(target, args = []) {
  const res = spawnSync(process.execPath, [APPLY_UNITY, target, ...args], { encoding: "utf8" });
  assert.equal(res.status, 0, `apply failed: ${res.stderr}\n${res.stdout}`);
  return res.stdout;
}

function read(target, ...parts) {
  return readFileSync(join(target, ...parts), "utf8");
}

// マーカーは注釈行を持つので、値の行だけを取り出す（analyzer 側の読み方と同じ規則）。
function markerValue(target) {
  return read(target, MARKER)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && l[0] !== "#");
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

test("既定は Assets/App/（無指定でも従来どおり）", () => {
  const target = unityProject();
  const out = runApply(target);
  assert.match(out, /アプリ本体の置き場（--app-root）: Assets\/App\/（既定）/);
  assert.equal(markerValue(target), "Assets/App/");
  assert.match(read(target, ".claude", "skills", "lint-unity", "SKILL.md"), /^paths: Assets\/App\/\*\*$/m);
});

test("指定すると規約の適用範囲が 4 箇所とも揃う", () => {
  const target = unityProject({ reviewConfig: true });
  runApply(target, ["--app-root=Assets/Game", "--review-target"]);

  assert.equal(markerValue(target), "Assets/Game/");

  const lint = read(target, ".claude", "skills", "lint-unity", "SKILL.md");
  assert.match(lint, /^paths: Assets\/Game\/\*\*$/m);
  assert.match(lint, /git diff --name-only HEAD -- 'Assets\/Game\/'/);

  assert.match(read(target, ".claude", "rules", "folder-structure.md"), /Assets\/Game\//);

  const cfg = JSON.parse(read(target, ".claude", "hooks", "review-config.json"));
  assert.deepEqual(cfg.reviewTargets, ["Assets/Game/"]);
});

// テンプレ側に素の Assets/App が残っていると、その 1 行だけが置き場を無視して固定される。
// 見た目では気づけないので機械で止める。
test("テンプレートに素の Assets/App が残っていない", () => {
  const offenders = walk(templatesDir)
    .filter((f) => /\.(md|txt)$/i.test(f))
    .filter((f) => readFileSync(f, "utf8").includes("Assets/App"));
  assert.deepEqual(offenders, [], "{{APP_ROOT}} へ置き換え忘れたテンプレートがある");
});

test("配置物にトークンが残らない", () => {
  const target = unityProject();
  runApply(target, ["--app-root=Assets/Game"]);
  const left = walk(target)
    .filter((f) => /\.(md|txt|json)$/i.test(f))
    .filter((f) => readFileSync(f, "utf8").includes("{{APP_ROOT}}"));
  assert.deepEqual(left, []);
});

test("Assets/ 配下でない値は落とす", () => {
  const target = unityProject();
  const res = spawnSync(process.execPath, [APPLY_UNITY, target, "--app-root=Packages/com.foo"], {
    encoding: "utf8",
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /Assets\/ 配下を指定してください/);
  assert.equal(existsSync(join(target, MARKER)), false);
});

test("空の値は落とす", () => {
  const target = unityProject();
  const res = spawnSync(process.execPath, [APPLY_UNITY, target, "--app-root="], { encoding: "utf8" });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /空のパスは指定できません/);
});

// 手打ちされる値なので、末尾スラッシュや Windows 区切りで結果が変わらないことを固定する。
// Windows 区切りは JS のエスケープで消えやすいので、文字コードから組んで確実に 1 文字入れる。
const BACKSLASH = String.fromCharCode(92);
for (const written of ["Assets/Game/", "/Assets/Game", "./Assets/Game", `Assets${BACKSLASH}Game`]) {
  test(`書式のゆらぎを吸収する: ${JSON.stringify(written)}`, () => {
    const target = unityProject();
    runApply(target, [`--app-root=${written}`]);
    assert.equal(markerValue(target), "Assets/Game/");
  });
}

test("既定以外のときだけ state の flags へ記録する", () => {
  const custom = unityProject();
  runApply(custom, ["--app-root=Assets/Game"]);
  const a = JSON.parse(read(custom, ".claude", "sync-setup-state.json"))["setup-unity"];
  assert.ok(a.flags.includes("--app-root=Assets/Game/"));

  const def = unityProject();
  runApply(def, ["--app-root=Assets/App"]);
  const b = JSON.parse(read(def, ".claude", "sync-setup-state.json"))["setup-unity"];
  assert.deepEqual(b.flags.filter((f) => f.startsWith("--app-root")), []);
});

// 置換前の内容と現物を比べていると、置き場を変えた配備先が毎回「要マージ」になる。
test("同じ値で再実行しても要マージにならない", () => {
  const target = unityProject();
  runApply(target, ["--app-root=Assets/Game"]);
  const out = runApply(target, ["--app-root=Assets/Game"]);
  assert.doesNotMatch(out, /要マージ/);
});
