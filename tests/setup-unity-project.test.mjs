// setup-unity が .claude/ の外へ配るもの（Roslyn analyzer と整合性検査の workflow）の検証。
//
// 観点:
//   1. 配布 DLL がソースから作り直されている（build.mjs の流し忘れを検知する）
//   2. 常時配置される（導入は任意ではない）
//   3. Unity が analyzer を読み込む条件（配置場所と .meta）が崩れていない
//   4. 設定ファイル（.ruleset / .globalconfig）を配らない ＝ Assets 直下を汚さない
//   5. 廃止フラグを渡されても止まらない（配備先の状態ファイルに記録が残っているため）
//   6. workflow が Editor を起こさない（ライセンスも secret も要らない形を保つ）
//   7. 配る Markdown が実在しない節を参照していない

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
    join("Assets", "Analyzers.meta"),
    join("Assets", "Analyzers", dist.assembly),
    join("Assets", "Analyzers", `${dist.assembly}.meta`),
    join("Assets", "Analyzers", "README.md"),
    join("Assets", "Analyzers", "README.md.meta"),
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
  // Assets 直下に置いてよいのは Analyzers フォルダの .meta だけ（Unity がフォルダにも
  // .meta を要求する。無いと `unity projects verify --strict` が META_MISSING で落ちる）。
  assert.deepEqual(
    readdirSync(join(target, "Assets"), { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name),
    ["Analyzers.meta"],
    "Assets 直下にファイルが増えている"
  );
});

test("配布する Assets の全エントリに .meta がある（verify --strict が落ちない）", () => {
  // Unity はファイルにもフォルダにも .meta を要求する。配り忘れると配備先の
  // `unity projects verify --strict` が META_MISSING で赤くなり、しかも
  // 原因は同期 PR の差分（この 3 ファイル）にしか無いので配備先では直せない。
  const target = unityProject();
  runApply(target);

  const missing = [];
  const scan = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.endsWith(".meta")) continue;
      if (!existsSync(join(dir, `${e.name}.meta`))) {
        missing.push(join(dir, e.name).slice(target.length + 1));
      }
      if (e.isDirectory()) scan(join(dir, e.name));
    }
  };
  scan(join(target, "Assets"));

  assert.deepEqual(missing, [], `.meta が無い:\n  ${missing.join("\n  ")}`);
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
  assert.ok(workflow.includes("  verify:"), "verify ジョブが無い");

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

test("workflow は Editor を起こさない（ライセンスも secret も要らない形を保つ）", () => {
  // Editor を起こすジョブは 1 回 10 分以上かかり、PR ゲートとして使えない。そこから
  // ライセンス secret・seat・private パッケージのトークンという運用の面倒も全部来ていた。
  // テストとコンパイル確認はローカルへ移した。ここへ戻すなら意図的な決定として戻す。
  const workflow = readFileSync(join(templateRoot, WORKFLOW), "utf8");
  assert.doesNotMatch(workflow, /^\s*container:/m, "container を使うジョブが増えている");
  assert.doesNotMatch(workflow, /secrets\./, "secret を読んでいる");
  assert.doesNotMatch(workflow, /unity test\b/, "CI でテストを走らせている");
  assert.match(
    workflow,
    /unity projects verify --strict/,
    "プロジェクト整合性の検査が無い（この workflow の唯一の仕事）"
  );
});

test("公式 unity-cli skill は配備先へ入れ、unity が無くても導入は止まらない", () => {
  // CLI の詳細（コマンド一覧・フラグ・exit code・ログの場所）は我々が写さず、CLI 自身が
  // 配る版を `--local` で入れる。写しを持つと CLI を上げるたびに黙ってズレる。
  // ただし CLI 未導入の配備先でも配置は決定的に完了させる（ここで落ちると導入が止まる）。
  const target = unityProject();
  const res = spawnSync(process.execPath, [APPLY_UNITY, target], {
    encoding: "utf8",
    env: { ...process.env, PATH: "", Path: "" }, // unity を見つけられない環境を作る
  });

  assert.equal(res.status, 0, `unity が無いだけで落ちた: ${res.stderr}\n${res.stdout}`);
  assert.match(res.stdout, /公式 unity-cli skill: 見送りました/, "見送りが報告されていない");
  assert.ok(
    existsSync(join(target, ".claude", "rules", "unity-cli.md")),
    "見送りの後に配置が中断している"
  );
});

test("rules/unity-cli.md は公式 skill にある表を持たない（写しを増やさない）", () => {
  // exit code 表・ログの場所・Safe Mode の復旧手順は公式 unity-cli skill が持つ。
  // ここに写すと CLI を上げたときに黙って古くなる。残すのは方針と実測の罠だけ。
  const rule = readFileSync(
    join(here, "..", "skills", "setup-unity", "templates", "base", "rules", "unity-cli.md"),
    "utf8"
  );
  assert.doesNotMatch(rule, /^\| 130 \/ 143 \|/m, "exit code の一覧表が復活している");
  assert.doesNotMatch(rule, /AppData\\Local\\Unity|Library\/Logs\/Unity|config\/unity3d/, "Editor ログのパス表が復活している");
  // 逆に、公式に無い実測はここが正本なので消えていないことを見る。
  assert.match(rule, /到達不可でも exit 0/, "pipeline list の罠が消えている");
  assert.match(rule, /0 件マッチを緑と読まない/, "0 件マッチの罠が消えている");
  assert.match(rule, /シリアライズファイルを手編集しない/, "手編集の禁止が消えている");
});

test("配布 Markdown が指す rules の節は実在する（消した節への参照を残さない）", () => {
  // 節を消しても参照が残ると、読んだ側は「どこかに書いてある」と信じて探し、見つからない。
  // 書いた時点では正しかった記述が、周りが変わって黙って嘘になる典型。
  const templates = join(here, "..", "skills", "setup-unity", "templates");
  const dangling = [];

  for (const layer of ["base", "architecture"]) {
    const layerRoot = join(templates, layer);
    if (!existsSync(layerRoot)) continue;

    // 同じレイヤーの rules/*.md の見出しを集める。architecture は base のファイルを
    // 差し替える形なので、architecture に無いものは base 側を見る。
    const headings = (dir) => {
      const map = new Map();
      const rulesDir = join(dir, "rules");
      if (!existsSync(rulesDir)) return map;
      for (const name of readdirSync(rulesDir).filter((n) => n.endsWith(".md"))) {
        const text = readFileSync(join(rulesDir, name), "utf8");
        map.set(name, [...text.matchAll(/^#{2,3} (.+)$/gm)].map((m) => m[1]));
      }
      return map;
    };
    const own = headings(layerRoot);
    const base = layer === "base" ? own : headings(join(templates, "base"));

    // templates 直下の .md（CLAUDE.md へ配る節）と SKILL.md も同じ規則で見る。
    // 参照先は base の rules。SKILL.md は配布物ではないが、配る規約の節を指す記述を持つ。
    const rootMds =
      layer === "base"
        ? [
            ...readdirSync(templates)
              .filter((n) => n.endsWith(".md"))
              .map((n) => join(templates, n)),
            join(templates, "..", "SKILL.md"),
          ]
        : [];

    for (const file of [...walk(layerRoot), ...rootMds].filter((f) => f.endsWith(".md"))) {
      const text = readFileSync(file, "utf8");
      for (const [, target, section] of text.matchAll(/rules\/([a-z-]+\.md)`?「([^」]+)」/g)) {
        const list = own.get(target) ?? base.get(target);
        // 見出しは「Safe Mode（…）」のように補足が付く。前方一致で足りる。
        if (list?.some((h) => h.startsWith(section))) continue;
        dangling.push(`${file.slice(templates.length + 1)}: rules/${target}「${section}」`);
      }
    }
  }

  assert.deepEqual(dangling, [], `存在しない節を参照している:\n  ${dangling.join("\n  ")}`);
});

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
