// skill ごとの版（`skills/<skill>/SKILL.md` の frontmatter `version:`）と drift 判定。
//
// **なぜプラグイン全体の版で判定しないか。**
// プラグイン版は marketplace の更新トリガーであって「どの skill が変わったか」を表さない。
// setup-unity のテンプレだけ変えてもプラグイン版は上がるため、プラグイン版で判定すると
// setup-github だけを入れた配備先も drift 扱いになり、状態ファイルの版を進めるだけの PR が出る。
// 判定は skill 版どうしで行う。プラグイン版は識別子（ブランチ名・試行上限キー）として残す。
//
// skill 版は手で bump する数字なので、忘れると更新が黙って届かない。
// **忘れを機械で止めるのが `scripts/check-skill-version-bump.mjs`**（PR で
// `templates/**` か `apply.mjs` が変わったのに版が動いていなければ CI を落とす）。
//
// 配備先へ配る hook（setup-github/templates/base/hooks/lib/sync-setup-drift.mjs）は
// プラグインを import できないため同じ規則を自前で持つ。**ここが正本**。変えるときは両方。
//
// 依存なし（Node 標準のみ）。

import { readFileSync } from "node:fs";
import { join } from "node:path";

// 追随の対象になる skill。状態ファイルのキーでもある。
export const SKILL_KEYS = ["setup-github", "setup-unity"];

// "1.2.0" 同士を数値比較。a > b で正。パースできない値（"unknown" 等）は 0 扱い。
export function cmpVer(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10));
  const pb = String(b).split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// SKILL.md の frontmatter から version を読む。読めなければ null。
//
// 本文に `version:` と書かれた行を拾わないよう、先頭の `---` で囲まれた塊だけを見る。
export function parseSkillVersion(src) {
  const fm = String(src)
    .replace(/^\uFEFF/, "")
    .match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const m = fm[1].match(/^version:[ \t]*["']?(\d+(?:\.\d+){0,2})["']?[ \t]*$/m);
  return m ? m[1] : null;
}

export function readSkillVersion(pluginRoot, skillKey) {
  try {
    return parseSkillVersion(readFileSync(join(pluginRoot, "skills", skillKey, "SKILL.md"), "utf8"));
  } catch {
    return null;
  }
}

// 1 skill 分の drift 判定。drift していれば { from, to, basis }、していなければ null。
//
// basis は判定の根拠:
//   "skill"  … skill 版どうしの比較（本筋）
//   "plugin" … 記録に skillVersion が無い旧配備先。プラグイン版での旧規則へ落とす。
//              ここを「判定しない」にすると、既存の配備先が黙って追随を止める。
//              次の apply が skillVersion を書くので、この経路を通るのは各配備先で 1 度だけ。
//              from / to はこのとき**プラグイン版**になる（実際に比べた値を人へ出すため。
//              skill 版を混ぜて出すと「v2.6.3→v1.27.0」と後退したように見える）。
//
// 発火はアップグレード方向のみ（現行版 > 記録版）。複数マシンで版がずれていても、古い版の
// マシンが新しい版で同期済みのプロジェクトを巻き戻す churn を防ぐ。
export function decideDrift(rec, curSkillVersion, curPluginVersion) {
  if (!rec || typeof rec !== "object") return null;
  if (rec.skillVersion) {
    if (!curSkillVersion) return null; // 現行 skill 版が読めない＝プラグインが居ない。何もしない
    return cmpVer(curSkillVersion, rec.skillVersion) > 0
      ? { from: rec.skillVersion, to: curSkillVersion, basis: "skill" }
      : null;
  }
  if (!rec.version || !curPluginVersion) return null;
  return cmpVer(curPluginVersion, rec.version) > 0
    ? { from: rec.version, to: curPluginVersion, basis: "plugin" }
    : null;
}
