// 1.x が `.claude/skills/` へ直置きした TDMCPSkills（td-*）を取り除く。
//
// 2.0 から skill はコンポーネントの Install Skills が入れる。直置きが残ると同じ td-* が二重に読まれる。
// 消すのは状態ファイルの記録（tdmcpSkills.placed）にあるものと、添えた LICENSE だけ。
// 記録も `.claude/` もリポジトリから来るので信用しない:
//   - 名前は上流の名前空間 `td-` で始まる単一のパス要素だけを受ける（`..`・区切り・末尾のドットを通さない）
//   - `.claude` と種別ディレクトリが symlink / junction なら、その下は消さない（リンク先の実ファイルを消させない）

import { existsSync, lstatSync, rmSync } from "node:fs";
import { join } from "node:path";

const KINDS = ["skills", "commands", "agents"];
const LICENSE_NAME = "TDMCP-SKILLS-LICENSE.md";
const isTdName = (n) => /^td-[A-Za-z0-9_-]+$/.test(n);
const isRealDir = (p) => {
  try {
    const st = lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * @param {string} claudeDir   配備先の .claude
 * @param {object} [recorded]  前回の記録（{ sha, placed }）。無ければ何もしない
 * @returns {{ state: string, done: boolean }} done が false なら消せなかったものがある（記録を残してやり直す）
 */
export function removeLegacySkills(claudeDir, recorded) {
  const placed = recorded?.placed && typeof recorded.placed === "object" ? recorded.placed : null;
  if (!placed) return { state: "対象なし", done: true };

  const removed = [];
  const failed = [];
  const remove = (p, label) => {
    if (!existsSync(p)) return;
    try {
      rmSync(p, { recursive: true });
      removed.push(label);
    } catch (e) {
      failed.push(`${label}（${e.message}）`);
    }
  };
  if (!isRealDir(claudeDir)) return { state: "対象なし（.claude が実ディレクトリでない）", done: true };
  for (const kind of KINDS) {
    const names = placed[kind];
    const dir = join(claudeDir, kind);
    if (!Array.isArray(names) || !isRealDir(dir)) continue;
    for (const n of names.map(String).filter(isTdName)) remove(join(dir, n), `${kind}/${n}`);
  }
  if (isRealDir(join(claudeDir, "skills"))) remove(join(claudeDir, "skills", LICENSE_NAME), `skills/${LICENSE_NAME}`);

  const parts = [removed.length ? `${removed.length} 件を削除しました: ${removed.join(" ")}` : "削除するものはありませんでした"];
  if (failed.length) parts.push(`削除できなかったもの（手で消してから再実行してください）: ${failed.join(" ")}`);
  return { state: parts.join("。"), done: failed.length === 0 };
}
