// 配布物を変えた PR で skill 版（`skills/<skill>/SKILL.md` の `version:`）の bump 忘れを止める。
//
// **なぜ必要か。** テンプレ自動追随の drift 判定は skill 版どうしの比較で行う
//（規則の正本は `skills/sync-setup/skill-version.mjs`）。プラグイン版で判定すると、
// setup-unity のテンプレだけ変えた更新で setup-github だけの配備先まで drift 扱いになるため。
// 代わりに手で bump する数字が判定に載るので、忘れると更新が**黙って**どの配備先にも届かない。
// エラーも出ないので誰も気づけない。だから機械で止める。
//
// 判定: merge-base から作業ツリーまでで `skills/<skill>/templates/**` か `skills/<skill>/apply.mjs` が変わったなら、
// その skill の SKILL.md の version が base より大きくなっていること。
// この 2 つが「配備先のファイルを変えうる入力」のすべて（SKILL.md 自身と他のヘルパーは配らない）。
//
// 使い方:
//   node scripts/check-skill-version-bump.mjs <base-ref>
//     例: node scripts/check-skill-version-bump.mjs origin/main
//   比較は merge-base から**作業ツリー**まで。CI では HEAD と同じで、ローカルでは
//   コミット前でも同じ判定が出る（push してから CI で気づく往復を無くす）。
//
// 依存なし（Node 標準のみ）。

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cmpVer, parseSkillVersion, readSkillVersion, SKILL_KEYS } from "../skills/sync-setup/skill-version.mjs";
/* global process, console */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function git(...a) {
  return execFileSync("git", ["-C", repoRoot, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const base = process.argv[2];
if (!base) {
  console.error("base ref を渡してください（例: node scripts/check-skill-version-bump.mjs origin/main）");
  process.exit(1);
}

let mergeBase;
try {
  mergeBase = git("merge-base", base, "HEAD").trim();
} catch {
  console.error(`base ref を解決できません: ${base}（CI では fetch-depth: 0 が必要）`);
  process.exit(1);
}

// 配布物を変えうる入力。ここを増やすときは「配備先のファイルが変わるか」で決める。
const deployables = (skill) => [`skills/${skill}/templates`, `skills/${skill}/apply.mjs`];

const failures = [];
for (const skill of SKILL_KEYS) {
  // merge-base と作業ツリーの比較。`base...HEAD` にするとローカルの未コミット変更を見落とす。
  const changed = git("diff", "--name-only", mergeBase, "--", ...deployables(skill)).trim();
  if (!changed) continue;

  const head = readSkillVersion(repoRoot, skill);
  if (!head) {
    failures.push(`${skill}: SKILL.md の frontmatter から version を読めません`);
    continue;
  }
  // base 側に SKILL.md が無い（skill を新設した PR）なら 0.0.0 扱い。
  let baseVersion = "0.0.0";
  try {
    baseVersion = parseSkillVersion(git("show", `${mergeBase}:skills/${skill}/SKILL.md`)) || "0.0.0";
  } catch {
    /* 新設 skill。0.0.0 のままで比較する */
  }

  if (cmpVer(head, baseVersion) > 0) {
    console.log(`OK  ${skill}: v${baseVersion} → v${head}（配布物の変更あり）`);
    continue;
  }
  failures.push(
    `${skill}: 配布物が変わっているのに SKILL.md の version が上がっていません（base v${baseVersion} / HEAD v${head}）\n` +
      `        変更されたファイル:\n${changed
        .split("\n")
        .map((f) => `          ${f}`)
        .join("\n")}`
  );
}

if (failures.length === 0) {
  console.log("skill 版の bump 忘れはありません。");
  process.exit(0);
}

console.error("skill 版の bump 忘れがあります。\n");
for (const f of failures) console.error(`  - ${f}`);
console.error(
  "\nテンプレ自動追随はこの版で drift を判定します。上げないと、この更新はどの配備先にも" +
    "黙って届きません（エラーも出ません）。該当 skill の SKILL.md の version を上げてください。"
);
process.exit(1);
