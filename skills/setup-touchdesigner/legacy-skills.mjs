// 1.x が `.claude/skills/` へ直置きした TDMCPSkills（td-*）を取り除く。
//
// 2.0 から skill はコンポーネントの Install Skills が入れる。直置きが残ると同じ td-* が二重に読まれる。
// 消すのは状態ファイルの記録（tdmcpSkills.placed）にあるものと、添えた LICENSE だけ。
// 記録は配備先にコミットされたファイルなので名前を信用しない: 配った種別の、単一のパス要素だけを受ける
// （`..` や区切りを含む名前で .claude の外を消させない）。

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const KINDS = ["skills", "commands", "agents"];
const LICENSE_NAME = "TDMCP-SKILLS-LICENSE.md";
const isPlainName = (n) => n !== "" && n !== "." && n !== ".." && !/[\\/:]/.test(n);

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
  for (const kind of KINDS) {
    const names = placed[kind];
    if (!Array.isArray(names)) continue;
    for (const n of names.map(String).filter(isPlainName)) remove(join(claudeDir, kind, n), `${kind}/${n}`);
  }
  remove(join(claudeDir, "skills", LICENSE_NAME), `skills/${LICENSE_NAME}`);

  const parts = [removed.length ? `${removed.length} 件を削除しました: ${removed.join(" ")}` : "削除するものはありませんでした"];
  if (failed.length) parts.push(`削除できなかったもの（手で消してから再実行してください）: ${failed.join(" ")}`);
  return { state: parts.join("。"), done: failed.length === 0 };
}
