// TDMCP 本体（TDMCP.tox）を上流の release から取得し、プロジェクト直下へ置く。
//
// 置く版と中身は upstream.mjs が tag と sha256 で固定する。照合の基準をこちらのリポジトリに
// 持つので、release 側の差し替えや破損はダウンロード後の照合で止まる。
// 配備先の現物が固定 sha256 と一致すればネットワークへ出ない。
//
// 再配布なので LICENSE を隣に置く（Shared Use License は再配布物にライセンス表記の保持を求める）。

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
/* global process, fetch, AbortSignal, Buffer */

export const TOX_NAME = "TDMCP.tox";
export const TOX_LICENSE_NAME = "TDMCP-LICENSE.md";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// 取得口。SETUP_TOUCHDESIGNER_RELEASE_DIR は**テスト専用**（そのディレクトリから同名ファイルを読む）。
async function download(url, localName) {
  const dir = process.env.SETUP_TOUCHDESIGNER_RELEASE_DIR;
  if (dir) return readFileSync(join(dir, localName));
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * @param {object} o
 * @param {string} o.target   プロジェクト直下
 * @param {string} o.repo     `owner/name`
 * @param {string} o.tag      release tag
 * @param {string} o.sha256   TDMCP.tox の期待ハッシュ
 * @returns {Promise<{ state: string, warning?: string }>}
 */
export async function placeTdmcpTox({ target, repo, tag, sha256: expected }) {
  const toxPath = join(target, TOX_NAME);
  const licensePath = join(target, TOX_LICENSE_NAME);
  if (existsSync(toxPath) && sha256(readFileSync(toxPath)) === expected && existsSync(licensePath)) {
    return { state: `導入済み（${tag} と一致）` };
  }

  let tox;
  let license;
  try {
    tox = await download(`https://github.com/${repo}/releases/download/${tag}/${TOX_NAME}`, TOX_NAME);
    license = await download(`https://raw.githubusercontent.com/${repo}/${tag}/LICENSE.md`, "LICENSE.md");
  } catch (e) {
    return { state: `見送りました（取得できません: ${e.message}）。既存の ${TOX_NAME} は触っていません` };
  }
  const actual = sha256(tox);
  if (actual !== expected) {
    return {
      state: "見送りました（ハッシュ不一致）",
      warning: `${TOX_NAME}（${tag}）のハッシュが固定値と一致しません（期待 ${expected.slice(0, 12)} / 実際 ${actual.slice(0, 12)}）。置いていません`,
    };
  }
  const existed = existsSync(toxPath);
  writeFileSync(toxPath, tox);
  writeFileSync(licensePath, license);
  return { state: existed ? `${tag} へ置き換えました` : `${tag} を置きました` };
}
