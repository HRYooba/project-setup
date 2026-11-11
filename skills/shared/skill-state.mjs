// setup-* の apply.mjs が共通で使う、skill 版の読み取りと状態ファイルへの記録。
//
// 状態ファイル `.claude/sync-setup-state.json` は複数の setup-* が各自のキーで書く。
// 読み手（配備先の hook と sync-run.mjs）はこの記録版と現行の skill 版を比べて追随を判断する。

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseSkillVersion } from "../sync-setup/skill-version.mjs";

// skill ディレクトリの SKILL.md の frontmatter `version:` を読む。読めなければ null
// （呼び手は状態ファイルを書かない＝自動追随は無効のまま）。
// **プラグイン全体の版ではない。** プラグイン版は marketplace の更新トリガーであって
// 「どの skill が変わったか」を表さないため、これで判定すると他スキルの更新でも配備先が drift 扱いになる。
export function readOwnSkillVersion(skillDir) {
  try {
    return parseSkillVersion(readFileSync(join(skillDir, "SKILL.md"), "utf8"));
  } catch {
    return null;
  }
}

// 状態ファイルへ自分のキーだけをマージ更新する。他のキーや未知フィールドは消さない。
//
// `entry` がキーの新しい中身。`carryOver` に挙げたフィールドは、entry 側が undefined なら
// 前回の記録（オブジェクトのときだけ）を引き継ぐ — 上流の clone に失敗した回に記録を消すと、
// その配備先が以後の更新を検出できなくなるため。
//
// 返り値: 既存ファイルが不正な JSON で作り直したなら true（他スキルのキーは失われている）。
export function writeSyncState(claudeDir, skillKey, entry, { carryOver = [] } = {}) {
  const p = join(claudeDir, "sync-setup-state.json");
  let obj = {};
  let recreated = false;
  if (existsSync(p)) {
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
      if (parsed && typeof parsed === "object") obj = parsed;
    } catch {
      recreated = true;
    }
  }
  const prev = obj[skillKey];
  const next = {};
  for (const [k, v] of Object.entries(entry)) if (v !== undefined) next[k] = v;
  for (const k of carryOver) {
    if (next[k] !== undefined) continue;
    const old = prev?.[k];
    if (old && typeof old === "object") next[k] = old;
  }
  obj[skillKey] = next;
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
  return recreated;
}

// 状態ファイルから自分のキーの前回記録を読む。無い・壊れているなら {}。
export function readRecordedState(claudeDir, skillKey) {
  const p = join(claudeDir, "sync-setup-state.json");
  if (!existsSync(p)) return {};
  try {
    const v = JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""))?.[skillKey];
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
