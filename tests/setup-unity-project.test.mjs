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
import {
  bundleCandidates,
  insideBundleDir,
  partitionFindings,
  readExtraExtensions,
  resolveExtensions,
} from "../skills/setup-unity/templates/project/.github/scripts/unity-verify.mjs";
/* global process */

const here = dirname(fileURLToPath(import.meta.url));
const templateRoot = join(here, "..", "skills", "setup-unity", "templates", "project");
const dist = JSON.parse(readFileSync(join(here, "..", "analyzers", "dist.json"), "utf8"));
const WORKFLOW = join(".github", "workflows", "unity-ci.yml");
const CLI_ACTION = join(".github", "actions", "setup-unity-cli", "action.yml");
const VERIFY_SCRIPT = join(templateRoot, ".github", "scripts", "unity-verify.mjs");

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

// 部分展開でない普通の適用では検査が生きていること。誤報を消すために検査ごと殺さない
// （Assets/App を持たないプロジェクトへ規約を配っても誰も気づけなくなる）。
test("Assets/App が無ければ注意を出す（部分展開でないとき）", () => {
  const target = unityProject();
  assert.match(runApply(target), /Assets\/App\/ が存在しません/);
});

// テンプレ同期は sparse-checkout の worktree の中で apply を走らせる。展開範囲外を
// 「無い」と読むと、すべての Unity 同期 PR の本文に嘘の警告が載る。
test("部分展開の実行では Assets/App の存在確認を省く", () => {
  const target = unityProject();
  const out = runApply(target, [], { SYNC_SETUP_SPARSE_WORKTREE: "1" });
  assert.doesNotMatch(out, /Assets\/App\/ が存在しません/);
  assert.match(out, /作業ツリーが部分展開のため/);
});

function runApply(target, args = [], env = {}) {
  const res = spawnSync(process.execPath, [APPLY_UNITY, target, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
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
    join(".github", "scripts", "unity-verify.mjs"),
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
    /node \.github\/scripts\/unity-verify\.mjs --strict/,
    "プロジェクト整合性の検査が無い（この workflow の唯一の仕事）"
  );
});

// 誤検知を消すためにラッパーを噛ませた。**噛ませたことで検査が死んでいない**ことを
// ここで見る（抑止範囲・判定不能時の扱い・exit code）。
test("verify ラッパーはバンドルフォルダの中身だけを抑止する", () => {
  const exts = [".bundle", ".xcframework"];
  // Unity はバンドル形式のフォルダを 1 プラグインとして取り込むので、.meta が付くのは
  // フォルダ自身だけ。中身の META_MISSING は誤検知で、フォルダ自身のそれは本物。
  assert.equal(insideBundleDir("Assets/P/AVProVideo.xcframework/ios-arm64/Info.plist", exts), true);
  assert.equal(insideBundleDir("Assets/P/AVProVideo.xcframework", exts), false);
  assert.equal(insideBundleDir("Assets/App/Scripts/Foo.cs", exts), false);
  // バンドル名の一部に拡張子が現れるだけのフォルダを巻き込まない。
  assert.equal(insideBundleDir("Assets/Bundles/Data.json", exts), false);

  const findings = [
    { code: "META_MISSING", path: "Assets/P/X.bundle/Contents/Info.plist" },
    { code: "META_MISSING", path: "Assets/P/X.bundle" },
    { code: "META_MISSING", path: "Assets/App/Foo.cs" },
    // .meta 以外は本物の事故なので、バンドルの中でも通す。
    { code: "CONFLICT_MARKERS", path: "Assets/P/X.bundle/Contents/Info.plist" },
    { code: "GUID_DUPLICATE", path: "Assets/P/X.bundle/Contents/a.meta" },
  ];
  const { kept, suppressed } = partitionFindings(findings, exts);
  assert.deepEqual(
    suppressed.map((f) => f.path),
    ["Assets/P/X.bundle/Contents/Info.plist"]
  );
  assert.deepEqual(
    kept.map((f) => f.code),
    ["META_MISSING", "META_MISSING", "CONFLICT_MARKERS", "GUID_DUPLICATE"]
  );
});

// **抑止リストは配布しない。** 何がバンドル形式かは配備先の Assets が持つ事実で、
// plugin 側は確かめられない。憶測で配ると、その中の本物の .meta 欠落を全配備先で
// 黙って隠す。ここが空でなくなったら、その拡張子を実物で確かめたのか問い直すこと。
test("verify ラッパーは抑止リストを配布しない（既定は空）", () => {
  assert.deepEqual(resolveExtensions(null), []);
  assert.deepEqual(partitionFindings([{ code: "META_MISSING", path: "a/x.bundle/y" }], []).suppressed, []);
});

test("verify ラッパーの抑止対象は配備先の設定から来る", () => {
  assert.deepEqual(resolveExtensions('{"extraBundleExtensions":[".Weirdlib"]}'), [".weirdlib"]);
  assert.deepEqual(resolveExtensions("{}"), []);
  // 壊れた設定を黙って無視すると、書いたつもりの拡張子が効かないまま緑で通り続ける。
  assert.throws(() => readExtraExtensions('{"extraBundleExtensions":"weird"}'));
  assert.throws(() => readExtraExtensions('{"extraBundleExtensions":["weird"]}'));
  assert.throws(() => readExtraExtensions("{"));
});

// 抑止リストを配らない代わりに、**落ちたその場で足し方を出す**のが配備先の唯一の導線。
// 候補が拾えなくなると、誤検知に当たった配備先は doc を読むまで詰む
// （そして「.meta を作って commit」という実害の出る直し方へ行く）。
test("verify ラッパーは残った指摘からバンドル候補を拾う", () => {
  assert.deepEqual(
    bundleCandidates([
      { code: "META_MISSING", path: "Assets/P/AVProVideo.xcframework/ios-arm64/libA.a" },
      { code: "META_MISSING", path: "Assets/P/X.bundle/Contents/Info.plist" },
    ]),
    [".bundle", ".xcframework"]
  );
  // 末端のファイル拡張子は候補にしない（フォルダの話であって、ファイルの話ではない）。
  assert.deepEqual(bundleCandidates([{ code: "META_MISSING", path: "Assets/App/Foo.cs" }]), []);
  // .meta 以外の指摘からは拾わない（抑止の対象外なので足しても解決しない）。
  assert.deepEqual(
    bundleCandidates([{ code: "CONFLICT_MARKERS", path: "Assets/P/X.bundle/Contents/a.txt" }]),
    []
  );
});

test("verify ラッパーは判定不能を成功にしない", () => {
  // CLI が失敗した／出力形式が変わったときに exit 0 を返すと、検査があるのに
  // 何も見ていない状態が緑で通り続ける。unity を PATH から外して撃つ。
  const res = spawnSync(process.execPath, [VERIFY_SCRIPT, "--strict"], {
    encoding: "utf8",
    env: { ...process.env, PATH: tempDir("verify-nopath-"), Path: tempDir("verify-nopath-") },
  });
  assert.notEqual(res.status, 0, `判定不能なのに成功した:
${res.stdout}${res.stderr}`);
});

test("git が無くても導入は止まらない（見送りを報告して続行する）", () => {
  // 上流プラグインの取得は git に依存する唯一の箇所。オフラインや git 未導入の配備先でも
  // 規約一式の配置は決定的に完了させる（ここで落ちると導入そのものが止まる）。
  const target = unityProject();
  const res = spawnSync(process.execPath, [APPLY_UNITY, target], {
    encoding: "utf8",
    env: { ...process.env, PATH: "", Path: "" }, // git を見つけられない環境を作る
  });

  assert.equal(res.status, 0, `git が無いだけで落ちた: ${res.stderr}\n${res.stdout}`);
  assert.match(res.stdout, /公式 unity プラグイン: 見送りました/, "見送りが報告されていない");
  assert.ok(
    existsSync(join(target, ".claude", "rules", "coding-standards.md")),
    "見送りの後に配置が中断している"
  );
});

test("unity-cli skill は上流版をそのまま配る（CLI 埋め込み版で上書きしない）", () => {
  // CLI 埋め込み版（`unity skill install`）は上流より古いことが実測で分かっている
  // （CLI 1.0.0-beta.9 の埋め込み版は CHANGELOG が beta.8 止まりで references も 1 本少ない）。
  // 加えて CLI 経由だと「同期を回した人のマシンの CLI 版」が配布物になり、中身がマシンごとに揺れる。
  const target = unityProject();
  runApply(target);
  const state = JSON.parse(readFileSync(join(target, ".claude", "sync-setup-state.json"), "utf8"));
  if (!state["setup-unity"].unityPlugin) return; // clone できない環境では検証しない

  assert.ok(
    state["setup-unity"].unityPlugin.placed.skills.includes("unity-cli"),
    "unity-cli を上流から配っていない"
  );
  assert.equal(
    state["setup-unity"].unityCli,
    undefined,
    "CLI 経由の配布はやめたのに unityCli を記録している"
  );
});

// marketplace.json（Claude Code がローカルへ置く clone の中身）を偽装する。
// pin した sha を書いた 1 件だけ持つディレクトリを返す。
function fakeMarketplaces(sha) {
  const root = tempDir("marketplaces-");
  writeFile(
    join(root, "fake", ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      plugins: [
        {
          name: "unity",
          source: { source: "url", url: "https://github.com/Unity-Technologies/unity-agent-plugin.git", sha },
        },
      ],
    })
  );
  return root;
}

test("配る sha は marketplace が pin した値に従う（HEAD ではなく）", () => {
  // 検知（記録 ↔ ローカルの現行値）と配布が同じ値を見ないと、pin と HEAD がズレている間ずっと
  // drift 扱いになり、同期 PR が出続ける。
  const repo = fakeUpstream((root) => {
    writeFile(join(root, "skills", "demo", "SKILL.md"), "---\nname: demo\n---\n");
  });
  const oldSha = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  // pin より後に上流が進んだ状況を作る。
  writeFile(join(repo, "skills", "added-later", "SKILL.md"), "---\nname: added-later\n---\n");
  for (const a of [["add", "-A"], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "later"]]) {
    assert.equal(spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" }).status, 0);
  }

  const target = unityProject();
  runApply(target, [], {
    SETUP_UNITY_PLUGIN_REPO: repo,
    SETUP_UNITY_MARKETPLACES_DIR: fakeMarketplaces(oldSha),
  });
  const plugin = JSON.parse(
    readFileSync(join(target, ".claude", "sync-setup-state.json"), "utf8")
  )["setup-unity"].unityPlugin;

  assert.equal(plugin.sha, oldSha, "pin ではなく HEAD を配っている");
  assert.ok(
    !existsSync(join(target, ".claude", "skills", "added-later")),
    "pin より後の commit の skill を配っている"
  );
});

test("marketplace の pin が読めなくても配置は完了する", () => {
  // pin はあれば従う値であって、前提ではない。読めないだけで導入が止まると、
  // marketplace を登録していないマシンで setup-unity が使えなくなる。
  const target = unityProject();
  const out = runApply(target, [], { SETUP_UNITY_MARKETPLACES_DIR: tempDir("empty-marketplaces-") });

  assert.match(out, /公式 unity プラグイン: (導入しました|導入済み|見送りました)/);
});

test("公式 unity プラグインの skills は直置きされ、出所の sha を記録する", () => {
  // プラグインとして入れると実体は ~/.claude/plugins/cache/ へ行き、そこから読まれる。
  // 配備先のリポジトリを正本にするには直置きしかない。
  const target = unityProject();
  const first = runApply(target);
  const state = JSON.parse(readFileSync(join(target, ".claude", "sync-setup-state.json"), "utf8"));
  const plugin = state["setup-unity"].unityPlugin;

  // clone できない環境（git 無し・オフライン）では見送られる。そこまでは確かめない。
  if (!plugin) {
    assert.match(first, /公式 unity プラグインの skills: 見送りました/);
    return;
  }

  assert.match(plugin.sha, /^[0-9a-f]{40}$/, "sha を記録していない");
  assert.ok(plugin.placed.skills.length > 0, "配った skill 名を記録していない");
  const skillsDir = join(target, ".claude", "skills");
  for (const n of plugin.placed.skills) {
    assert.ok(existsSync(join(skillsDir, n, "SKILL.md")), `記録した ${n} が配備先に無い`);
  }
  // 再配布にはライセンス表記が付いて回る。
  assert.ok(
    existsSync(join(skillsDir, "UNITY-AGENT-PLUGIN-LICENSE.md")),
    "LICENSE を配っていない"
  );

  // プラグイン経由で同じ skill が並ぶと、どちらを引くか決まらない。名指しで伏せる。
  const overrides = JSON.parse(
    readFileSync(join(target, ".claude", "settings.json"), "utf8")
  ).skillOverrides;
  for (const n of plugin.placed.skills) {
    assert.equal(overrides[`unity:${n}`], "off", `unity:${n} を伏せていない`);
  }

  // sha が一致していれば触らない（同期のたびに配布物が揺れないこと）。
  assert.match(runApply(target), /公式 unity プラグイン: 導入済み（.+ と一致）/);
});

test("上流から消えた skill は配備先からも消え、伏せる設定も取り下げる", () => {
  // 記録が無いと、取り残された skill が常時コンテキストへ載り続ける（誰も検出できない）。
  const target = unityProject();
  runApply(target);
  const statePath = join(target, ".claude", "sync-setup-state.json");
  const settingsPath = join(target, ".claude", "settings.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  if (!state["setup-unity"].unityPlugin) return; // clone できない環境では検証しない

  // 「前回は配ったが上流にはもう無い」skill を作る。
  const ghost = "ghost-skill";
  state["setup-unity"].unityPlugin.placed.skills.push(ghost);
  state["setup-unity"].unityPlugin.sha = "0".repeat(40);
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
  mkdirSync(join(target, ".claude", "skills", ghost), { recursive: true });
  writeFileSync(join(target, ".claude", "skills", ghost, "SKILL.md"), "---\n", "utf8");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.skillOverrides[`unity:${ghost}`] = "off";
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");

  runApply(target);

  assert.ok(
    !existsSync(join(target, ".claude", "skills", ghost)),
    "上流から消えた skill が配備先に残った"
  );
  assert.ok(
    !(`unity:${ghost}` in JSON.parse(readFileSync(settingsPath, "utf8")).skillOverrides),
    "上流から消えた skill の off が残った"
  );
});

// 上流の構成が変わった場合の挙動は、本物の上流に hooks/ が生えるのを待てない。
// 偽の上流を立てて SETUP_UNITY_PLUGIN_REPO で差し替える。
function fakeUpstream(build) {
  const repo = tempDir("unity-upstream-");
  build(repo);
  const run = (...a) => {
    const r = spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
    assert.equal(r.status, 0, `git ${a[0]} 失敗: ${r.stderr}`);
  };
  run("init", "-q", ".");
  run("add", "-A");
  run("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return repo;
}

function writeFile(p, body) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body, "utf8");
}

test("上流が直置きで再現できない構成要素を足したら、黙って無視せず報告する", () => {
  // これが無いと、上流が hook や MCP を足した更新は「入ったつもりで入っていない」状態になる。
  // エラーも差分も出ないので誰も気づけない。
  const repo = fakeUpstream((root) => {
    writeFile(join(root, "skills", "demo", "SKILL.md"), "---\nname: demo\n---\n");
    writeFile(join(root, "hooks", "hooks.json"), "{}\n");
    writeFile(join(root, ".mcp.json"), "{}\n");
    writeFile(join(root, "brand-new-kind", "x.txt"), "x\n");
    writeFile(join(root, "LICENSE.md"), "LICENSE\n");
  });
  const out = runApply(unityProject(), [], { SETUP_UNITY_PLUGIN_REPO: repo });

  assert.match(out, /警告: 上流に直置きでは再現できない構成要素があります.*hooks/);
  assert.match(out, /\.mcp\.json/, "MCP 定義を報告していない");
  assert.match(out, /警告: 上流に扱いを決めていない要素があります.*brand-new-kind/);
});

test("上流が commands / agents を足したら配る", () => {
  // skills 決め打ちだと、上流が構成要素を増やしたときに黙って落ちる。
  const repo = fakeUpstream((root) => {
    writeFile(join(root, "skills", "demo", "SKILL.md"), "---\nname: demo\n---\n");
    writeFile(join(root, "commands", "do-thing.md"), "# do\n");
    writeFile(join(root, "agents", "helper.md"), "# helper\n");
  });
  const target = unityProject();
  runApply(target, [], { SETUP_UNITY_PLUGIN_REPO: repo });

  assert.ok(existsSync(join(target, ".claude", "commands", "do-thing.md")), "command を配っていない");
  assert.ok(existsSync(join(target, ".claude", "agents", "helper.md")), "agent を配っていない");
});

test("上流の配布物が setup-unity 自前のものと同名なら、上書きせず報告する", () => {
  // 黙って潰すと unity-worker や lint-unity が別物へ差し替わる。どちらを採るかは人の判断。
  const repo = fakeUpstream((root) => {
    writeFile(join(root, "skills", "demo", "SKILL.md"), "---\nname: demo\n---\n");
    writeFile(join(root, "skills", "lint-unity", "SKILL.md"), "---\nname: hijacked\n---\n");
    writeFile(join(root, "agents", "unity-worker.md"), "# hijacked\n");
  });
  const target = unityProject();
  const out = runApply(target, [], { SETUP_UNITY_PLUGIN_REPO: repo });

  assert.match(out, /警告: 上流の配布物が setup-unity 自前のものと同名です/);
  assert.doesNotMatch(
    readFileSync(join(target, ".claude", "skills", "lint-unity", "SKILL.md"), "utf8"),
    /hijacked/,
    "自前の lint-unity が上流に潰された"
  );
  assert.doesNotMatch(
    readFileSync(join(target, ".claude", "agents", "unity-worker.md"), "utf8"),
    /hijacked/,
    "自前の unity-worker が上流に潰された"
  );
});

test("配備先が自分で置いた skillOverrides は奪わない", () => {
  // "on" を明示した配備先は、重複を承知で両方見たいという意思表示。黙って戻すと
  // 理由の分からない挙動になる。
  const target = unityProject();
  runApply(target);
  const settingsPath = join(target, ".claude", "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const name = Object.keys(settings.skillOverrides)[0];
  if (!name) return; // clone できない環境では検証しない
  settings.skillOverrides[name] = "on";
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");

  runApply(target);

  assert.equal(
    JSON.parse(readFileSync(settingsPath, "utf8")).skillOverrides[name],
    "on",
    `配備先が明示した ${name} を上書きした`
  );
});

test("Unity 操作の方針は CLAUDE.md の 2 行だけ（CLI の写しを持たない）", () => {
  // CLI の詳細（コマンド・フラグ・exit code・ログの場所・復旧手順）は公式 unity-cli skill が
  // 持つ。写しを持つと CLI を上げたときに黙って古くなるので、rules は配らない。
  // 残すのは公式が課さない方針だけ。
  const md = readFileSync(
    join(here, "..", "skills", "setup-unity", "templates", "claude-md.md"),
    "utf8"
  );
  assert.match(md, /Unity CLI 経由で行う/, "CLI 経由の方針が消えている");
  assert.match(md, /\.prefab.*手編集しない/, "手編集の禁止が消えている");

  // テストと lint は **アプリ本体のホワイトリスト**。外部アセットの置き場は数え上げ
  // られないので、除外リストにすると漏れが直せない失敗・指摘になって返ってくる
  // （analyzer と CI で同じ結論に至っている）。実値は配備時に --app-root が決めるので、
  // テンプレ側で見るのはトークンの有無。
  for (const line of md.split(/\r?\n/).filter((l) => /^- \*\*(テスト|lint)\*\*/.test(l))) {
    assert.match(line, /\{\{APP_ROOT\}\}/, `アプリ本体の置き場に絞られていない: ${line}`);
  }
  assert.ok(
    !existsSync(
      join(here, "..", "skills", "setup-unity", "templates", "base", "rules", "unity-cli.md")
    ),
    "rules/unity-cli.md が復活している（公式 skill と写しになる）"
  );
});
test("lint-unity の description は自分で起動する条件を書いている", () => {
  // description は skill の発火条件そのもの。ユーザーの依頼語だけを書くと、
  // 誰も頼まない skill になって PR 前の検査が抜ける（実際にそうなっていた）。
  const skill = readFileSync(
    join(
      here, "..", "skills", "setup-unity", "templates", "base",
      "skills", "lint-unity", "SKILL.md"
    ),
    "utf8"
  );
  const front = skill.slice(0, skill.indexOf("\n---", 4));
  assert.match(front, /PR を作る前に/, "PR 前に回す条件が description に無い");
  assert.match(front, /依頼を待たずに/, "自分で起動する指示が description に無い");
  assert.match(front, /\{\{APP_ROOT\}\}/, "対象がアプリ本体の置き場に絞られていない");
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

// 公式 unity プラグインも unity-cli skill を同梱する。プラグイン側は `unity:unity-cli` へ
// 名前空間化されてローカル版と**並んで**提示されるため、伏せないと古い方を引く余地が残る。
// skillOverrides はその 1 キーだけを名指しする（プラグイン全体は無効化しない）。
test("同梱の unity:unity-cli を skillOverrides で伏せる", () => {
  const target = unityProject();
  runApply(target);
  const settings = JSON.parse(readFileSync(join(target, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.skillOverrides["unity:unity-cli"], "off");
});

// settings.json は配備先が育てるファイル。こちらのキーだけ足して、他は触らない。
test("既存の settings.json の他キーを温存する", () => {
  const target = unityProject();
  mkdirSync(join(target, ".claude"), { recursive: true });
  const p = join(target, ".claude", "settings.json");
  writeFileSync(p, JSON.stringify({ env: { FOO: "1" }, skillOverrides: { "other:skill": "off" } }), "utf8");
  runApply(target);
  const settings = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(settings.env.FOO, "1");
  assert.equal(settings.skillOverrides["other:skill"], "off");
  assert.equal(settings.skillOverrides["unity:unity-cli"], "off");
});

// "on" を明示した配備先は、重複を承知で両方見たいという意思表示。黙って戻すと
// 理由の分からない挙動になるので、値があるときは触らない。
test("既に値があれば上書きしない", () => {
  const target = unityProject();
  mkdirSync(join(target, ".claude"), { recursive: true });
  const p = join(target, ".claude", "settings.json");
  writeFileSync(p, JSON.stringify({ skillOverrides: { "unity:unity-cli": "on" } }), "utf8");
  const out = runApply(target);
  assert.equal(JSON.parse(readFileSync(p, "utf8")).skillOverrides["unity:unity-cli"], "on");
  assert.match(out, /触っていません/);
});

// 不正な JSON で導入全体を止めない（他の配置物は決定的に配り切る）。
test("settings.json が壊れていても導入は完走する", () => {
  const target = unityProject();
  mkdirSync(join(target, ".claude"), { recursive: true });
  const p = join(target, ".claude", "settings.json");
  writeFileSync(p, "{ broken", "utf8");
  const out = runApply(target);
  assert.match(out, /見送りました（settings\.json が不正な JSON です/);
  assert.equal(readFileSync(p, "utf8"), "{ broken");
});

// CI の走らせ方には配備先の事情が乗る（LFS を引くか・トリガー・runner）。無条件に上書きすると
// その改変が同期のたびに黙って巻き戻り、配備先は理由の説明がないまま同じ修正を繰り返す。
test("配備先が書き換えた workflow は上書きせず要マージにする", () => {
  const target = unityProject();
  runApply(target);

  const p = join(target, WORKFLOW);
  const edited = readFileSync(p, "utf8").replace("lfs: false", "lfs: true");
  writeFileSync(p, edited, "utf8");

  const out = runApply(target);
  assert.equal(readFileSync(p, "utf8"), edited, "配備先の改変が巻き戻された");
  assert.match(out, /\.github\/workflows\/unity-ci\.yml: 要マージ/);
  assert.match(out, /要マージ（/);
});

// 差が無いのに要マージへ回すと、毎回の同期 PR が人の判断を要求する（警告が無視される）。
test("workflow が同じなら要マージにしない", () => {
  const target = unityProject();
  runApply(target);
  const out = runApply(target);
  assert.match(out, /\.github\/workflows\/unity-ci\.yml: 変更なし/);
  assert.doesNotMatch(out, /要マージ（/);
});

// verify スクリプトは抑止リストを .github/unity-verify.config.json へ逃がしてあるので、
// 本体を書き換える理由が無い。配布物として上書きし、検査ロジックの修正を全配備先へ届ける。
test("verify スクリプトの改変は上書きで戻る", () => {
  const target = unityProject();
  runApply(target);

  const p = join(target, ".github", "scripts", "unity-verify.mjs");
  writeFileSync(p, "// 配備先の改変\n", "utf8");

  const out = runApply(target);
  assert.notEqual(readFileSync(p, "utf8"), "// 配備先の改変\n", "上書きされていない");
  assert.doesNotMatch(out, /要マージ（/);
});

// この検査が読むのは .meta と GUID と conflict marker で、LFS の実体は要らない。実体を引くと
// 毎 PR で LFS の帯域（課金対象）をアセットの総量だけ消費する。戻すなら意図的な決定として戻す。
test("checkout は LFS の実体を引かない", () => {
  const workflow = readFileSync(join(templateRoot, WORKFLOW), "utf8");
  assert.match(workflow, /^\s*lfs: false$/m, "checkout が LFS の実体を引く形になっている");
  assert.doesNotMatch(workflow, /^\s*lfs: true$/m);
});
