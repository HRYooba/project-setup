// テンプレ自動追随の状態ファイル（`.claude/sync-setup-state.json`）の読み書き。
//
// **旧名の解決をここに閉じる**のが目的。過去に 2 回改名しており、配備先には旧名だけが残った
// リポジトリが実在する。読み手（sync-run.mjs / SessionStart hook）が正名しか見ないと、
// その配備先は「同期対象外」として黙って落ちる — エラーも出ないので誰も気づけない。
// 改名の後始末を apply.mjs だけに持たせると、apply は drift 検知の後にしか走らないため
// 永久に到達しない（検知が空振りしているのが原因なので）。よって **読み手側でも旧名を解決する**。
//
// 配備先へ配る hook（setup-github/templates/base/hooks/sync-setup-check.mjs）は
// プラグインを import できないため、読み取り側の同じ規則を自前で持つ。**ここが正本**。
//
// 依存なし（Node 標準のみ）。

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// 現行の正名。
export const STATE_FILENAME = "sync-setup-state.json";

// 旧名。**新しい世代から順に並べる**（同じキーを複数の世代が持つときの優先順位になる）。
export const LEGACY_STATE_FILENAMES = ["setup-sync-state.json", ".setup-sync.json"];

function readJson(p) {
  try {
    // BOM 除去。リテラルの U+FEFF を書くと eslint(no-irregular-whitespace) に当たるのでエスケープで書く。
    return JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

// 正名 → 旧名（新しい世代順）の順に存在するものを列挙する。
export function stateFiles(claudeDir) {
  return [STATE_FILENAME, ...LEGACY_STATE_FILENAMES]
    .map((name) => ({ name, path: join(claudeDir, name) }))
    .filter((f) => existsSync(f.path));
}

// 記録内容を 1 つのオブジェクトに畳んで返す。1 つも無ければ null。
//
// **キー単位で新しい世代が勝つ。** 旧名は「新しい世代がまだ知らないキー」だけを補う。
// 例: 正名に setup-github v2.1.0、旧名に setup-unity v1.3.0 が残っている配備先では、
// setup-unity のドリフトだけが浮かび上がる（改名時にキーが引き継がれず取り残された形）。
// 逆にしてはいけない — 旧名を優先すると、正しく追随済みのキーが毎回ドリフト扱いになる。
export function readSyncState(claudeDir) {
  const files = stateFiles(claudeDir);
  if (files.length === 0) return null;
  const merged = {};
  for (const f of files) {
    const obj = readJson(f.path);
    if (!obj || typeof obj !== "object") continue;
    for (const [k, v] of Object.entries(obj)) {
      if (!(k in merged)) merged[k] = v;
    }
  }
  return merged;
}

// 旧名を正名へ畳んで消す（apply.mjs が呼ぶ書き込み側の後始末）。
// 読み手と同じ優先順位で畳むので、消しても見える内容は変わらない。
// 戻り値は人へ出す 1 行（何もしなければ null）。
export function consolidateSyncState(claudeDir) {
  const legacy = stateFiles(claudeDir).filter((f) => f.name !== STATE_FILENAME);
  if (legacy.length === 0) return null;
  const merged = readSyncState(claudeDir) || {};
  writeFileSync(join(claudeDir, STATE_FILENAME), JSON.stringify(merged, null, 2) + "\n", "utf8");
  for (const f of legacy) rmSync(f.path, { force: true });
  return `${legacy.map((f) => f.name).join(" / ")} → ${STATE_FILENAME}（記録を引き継いで旧名を削除）`;
}
