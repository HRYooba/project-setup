// テスト共通ヘルパー（パス定数と一時ディレクトリ生成）。

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readSkillVersion } from "../skills/sync-setup/skill-version.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = join(here, "..");
export const HOOKS_DIR = join(here, "..", "skills", "setup-github", "templates", "base", "hooks");
export const SYNC_HOOK = join(HOOKS_DIR, "sync-setup-check.mjs");
export const SYNC_PROMPT_HOOK = join(HOOKS_DIR, "sync-setup-prompt.mjs");
export const APPLY = join(here, "..", "skills", "setup-github", "apply.mjs");
export const APPLY_UNITY = join(here, "..", "skills", "setup-unity", "apply.mjs");
export const SYNC_RUN = join(here, "..", "skills", "sync-setup", "sync-run.mjs");

export function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// テンプレ追随の判定に使う skill 版（`skills/<skill>/SKILL.md` の frontmatter）。
// テスト側で数字を写すと bump のたびに嘘になるため、必ずここから読む。
export function skillVersion(skillKey) {
  const v = readSkillVersion(PLUGIN_ROOT, skillKey);
  if (!v) throw new Error(`skills/${skillKey}/SKILL.md から version を読めません`);
  return v;
}

// 偽のプラグイン展開先（installPath）。skill 版の判定には SKILL.md が要るため、
// frontmatter だけを持つ SKILL.md を temp へ書く。versions を省くと SKILL.md を置かない
// （プラグインが見つからない状況の挙動を確かめるため）。
export function fakePluginRoot(versions = {}) {
  const root = tempDir("fake-pluginroot-");
  for (const [skill, v] of Object.entries(versions)) {
    mkdirSync(join(root, "skills", skill), { recursive: true });
    writeFileSync(
      join(root, "skills", skill, "SKILL.md"),
      ["---", `name: ${skill}`, `version: ${v}`, "---", "", `# ${skill}`, ""].join("\n"),
      "utf8"
    );
  }
  return root;
}
