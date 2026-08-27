// テスト共通ヘルパー（パス定数と一時ディレクトリ生成）。

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const HOOKS_DIR = join(here, "..", "skills", "setup-github", "templates", "base", "hooks");
export const SYNC_HOOK = join(HOOKS_DIR, "setup-sync-check.mjs");
export const APPLY = join(here, "..", "skills", "setup-github", "apply.mjs");
export const APPLY_UNITY = join(here, "..", "skills", "setup-unity", "apply.mjs");
export const SYNC_RUN = join(here, "..", "skills", "setup-sync", "sync-run.mjs");

export function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}
