// setup-unity が .claude/ の外へ配るもの（Roslyn analyzer と PR ゲートの workflow）の検証。
//
// 観点:
//   1. 配布 DLL がソースから作り直されている（build.mjs の流し忘れを検知する）
//   2. 常時配置される（導入は任意ではない）
//   3. Unity が analyzer を読み込む条件（配置場所と .meta）が崩れていない
//   4. 設定ファイル（.ruleset / .globalconfig）を配らない ＝ Assets 直下を汚さない
//   5. 廃止フラグを渡されても止まらない（配備先の状態ファイルに記録が残っているため）
//   6. workflow が Editor 版を直書きしていない
//   7. CI の secret 確認が導入を止めない（gh が使えない環境でも完走して状態を報告する）

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { hashAnalyzerSources } from "../analyzers/source-hash.mjs";
import { APPLY_UNITY, tempDir } from "./helpers.mjs";
/* global process */

const here = dirname(fileURLToPath(import.meta.url));
const templateRoot = join(here, "..", "skills", "setup-unity", "templates", "project");
const dist = JSON.parse(readFileSync(join(here, "..", "analyzers", "dist.json"), "utf8"));
const WORKFLOW = join(".github", "workflows", "unity-ci.yml");
const CLI_ACTION = join(".github", "actions", "setup-unity-cli", "action.yml");

function unityProject() {
  const target = tempDir("setup-unity-project-");
  mkdirSync(join(target, "ProjectSettings"), { recursive: true });
  writeFileSync(
    join(target, "ProjectSettings", "ProjectVersion.txt"),
    "m_EditorVersion: 6000.3.18f1\n",
    "utf8"
  );
  return target;
}

function runApply(target, args = []) {
  const res = spawnSync(process.execPath, [APPLY_UNITY, target, ...args], { encoding: "utf8" });
  assert.equal(res.status, 0, `apply failed: ${res.stderr}\n${res.stdout}`);
  return res.stdout;
}

test("配布 DLL はソースから作り直されている（build.mjs の流し忘れ検知）", () => {
  assert.equal(
    hashAnalyzerSources(),
    dist.sourceHash,
    "analyzers/src を変更したのに配布物が古い。`node analyzers/build.mjs` を実行してコミットする"
  );
  assert.ok(
    existsSync(join(templateRoot, "Assets", "Analyzers", dist.assembly)),
    `配布 DLL が無い: ${dist.assembly}`
  );
});

test("フラグ無しで analyzer と workflow が配置される", () => {
  const target = unityProject();
  runApply(target);

  for (const f of [
    join("Assets", "Analyzers", dist.assembly),
    join("Assets", "Analyzers", `${dist.assembly}.meta`),
    join("Assets", "Analyzers", "README.md"),
    WORKFLOW,
    CLI_ACTION,
  ]) {
    assert.ok(existsSync(join(target, f)), `${f} が配置されていない`);
  }
});

test(".meta は Unity が analyzer を読み込む条件を満たす", () => {
  const target = unityProject();
  runApply(target);
  const meta = readFileSync(join(target, "Assets", "Analyzers", `${dist.assembly}.meta`), "utf8");

  // ラベルが落ちると Unity は DLL を csc へ渡さない。診断が 1 件も出ず
  // 「違反ゼロ」と見分けが付かないので、ここは必ず検証する。
  assert.match(meta, /labels:\s*\n- RoslynAnalyzer/, ".meta に RoslynAnalyzer ラベルが無い");
  // analyzer は Unity のランタイムアセンブリではない。参照検証を有効にすると
  // 未解決参照の警告が出るし、Auto Reference が付くとユーザーコードから見えてしまう。
  assert.match(meta, /validateReferences: 0/, "validateReferences が有効のまま");
  assert.match(meta, /isExplicitlyReferenced: 1/, "Auto Reference が有効のまま");
});

test("設定ファイルは配らない（Assets 直下を汚さない）", () => {
  const target = unityProject();
  runApply(target);

  assert.ok(!existsSync(join(target, "Assets", "Default.ruleset")), "ruleset を配ってしまっている");
  assert.deepEqual(
    readdirSync(join(target, "Assets"), { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name),
    [],
    "Assets 直下にファイルが増えている"
  );
});

test("廃止フラグ（--analyzer / --analyzer-severity）を渡されても止まらない", () => {
  const target = unityProject();
  // 配備先の sync-setup-state.json に記録が残っていると、テンプレ同期がこの形で渡してくる。
  // ここでエラー終了すると、その配備先の自動追随が永久に失敗する。
  const out = runApply(target, ["--analyzer", "--analyzer-severity=error"]);
  assert.match(out, /廃止したオプションを無視しました/);
  assert.ok(existsSync(join(target, "Assets", "Analyzers", dist.assembly)), "配置まで落ちた");

  const state = JSON.parse(readFileSync(join(target, ".claude", "sync-setup-state.json"), "utf8"));
  assert.deepEqual(state["setup-unity"].flags, [], "廃止フラグが状態ファイルへ書き戻された");
});

test("workflow は YAML として壊れていない（生 CR や欠けた行継続を混入させない）", () => {
  for (const f of [WORKFLOW, CLI_ACTION]) {
    const text = readFileSync(join(templateRoot, f), "utf8");
    // 生の CR が 1 つ混ざるだけで、その行以降の YAML の意味が変わる（クォートが閉じない等）。
    assert.doesNotMatch(text, /\r/, `${f} に生の CR が混ざっている`);
    // シェルの行継続が落ちると複数行が 1 行に潰れ、引数が壊れたまま静かに走る。
    assert.doesNotMatch(text, /  {4,}--[a-z-]+ +--[a-z-]+/, `${f} で行継続が落ちている疑い`);
  }
  const workflow = readFileSync(join(templateRoot, WORKFLOW), "utf8");
  for (const job of ["  changes:", "  resolve:", "  verify:", "  test:", "  gate:"]) {
    assert.ok(workflow.includes(job), `${job} が無い`);
  }

  // **列 0 の行は `run: |` ブロックを終わらせる。** シェルを書いているつもりで
  // ヒアドキュメントの終端や継続行を左端へ置くと、そこから先が YAML の別トークンとして
  // 読まれ、workflow が丸ごと読み込めなくなる（実際に壊れたまま main へ入った）。
  // トップレベルのキーとコメントだけを列 0 に許す。
  const topLevel = /^(name|on|concurrency|env|jobs|permissions|defaults|run-name):/;
  for (const [i, line] of workflow.split(/\r?\n/).entries()) {
    if (line === "" || line.startsWith(" ") || line.startsWith("#")) continue;
    assert.match(
      line,
      topLevel,
      `${WORKFLOW}:${i + 1} が列 0 にある（run: | ブロックを終わらせてしまう）: ${line}`
    );
  }
});

test("workflow は Editor 版を直書きせず ProjectVersion.txt から読む", () => {
  const workflow = readFileSync(join(templateRoot, WORKFLOW), "utf8");
  assert.match(workflow, /ProjectSettings\/ProjectVersion\.txt/, "Editor 版の出所が workflow に無い");
  // 版を直書きすると Editor を上げたときに黙ってズレる。コメント中の例示も含めて禁止する。
  assert.doesNotMatch(workflow, /\b\d{4}\.\d+\.\d+[abf]\d+\b/, "Editor 版が直書きされている");
});

test("CI の secret 確認は導入を止めない（gh が使えなくても完走して状態を報告する）", () => {
  // 状態確認は報告だけの段。gh が無い / 未認証 / git リポジトリでない配備先でも、
  // 配置そのものは決定的に完了させる（ここで exit 1 にすると導入が止まる）。
  const target = unityProject(); // git リポジトリではないので gh はリポジトリを特定できない
  const out = runApply(target);

  assert.match(out, /CI の Unity ライセンス secret:/, "secret の状態が報告されていない");
  assert.ok(
    existsSync(join(target, ".github", "workflows", "unity-ci.yml")),
    "確認の失敗で配置が中断している"
  );
});
