// テンプレート同期の「無人起動」側。SessionStart hook（setup-sync-check.mjs）から
// detached で起動され、ユーザーのセッションとは独立に同期 PR を出すところまで走る。
//
// 旧設計（方式B）は hook が additionalContext で「/setup-sync を実行して」と**頼む**だけだった。
// 実行主体を持たないため、いま起動した Claude が従うかどうかに賭ける形になり、実際に 3 版
// （v1.9.1 → v1.12.0）放置された。この launcher は「頼む」をやめて**プロセスを起こす**。
//
// このスクリプトが担保すること:
//   1. 作業ツリーの分離 — 対象リポジトリの作業ツリーには一切触れない。使い捨て worktree を
//      origin の default ブランチから切り、その中だけで apply / マージ / commit / push / PR を行う。
//      ユーザーが Unity Editor で編集中でも、ブランチを足元で切り替えられることも、無関係な
//      変更が `git add -A` で巻き込まれることも構造的に起こらない。
//   2. 多重起動の防止 — ロックファイル。セッションを何度開き直しても同時に 1 本だけ。
//   3. 結果の受け渡し — 結果を results/<key>.json に残す。UserPromptSubmit hook
//      （setup-sync-report.mjs）がそれを読んで 1 行報告し、ファイルを消す。
//      動いているセッションへ外から差し込む口が無いため、報告は「次にユーザーが何か打った時」になる。
//
// 実際の同期は既存の `/project-setup:setup-sync` スキル（sync-run.mjs + md-merge-contract）が
// そのまま行う。マージを LLM が担う設計は変えていない。ここが変えるのは**誰が起動するか**だけ。
//
// 裏で走る Claude は権限確認に答えられないため `--permission-mode bypassPermissions` で起動する。
// 許可リスト方式は漏れがあると無言で固まる（＝また放置される）ので採らない。行える副作用は
// 使い捨て worktree 内の編集と push / PR 作成に限られ、merge の経路は sync-run.mjs に無い。
//
// 使い方:
//   node sync-launch.mjs <target-dir>
// 環境変数（主にテスト用）:
//   SETUP_SYNC_DATA_DIR      データディレクトリ（既定 ~/.claude/plugins/data/project-setup）
//   SETUP_SYNC_CLAUDE_BIN    claude 実行ファイル（既定 PATH の claude → ~/.local/bin/claude.exe）
//   SETUP_SYNC_LAUNCH_DRY    "1" なら claude を起動せず、worktree の作成・後始末だけ行う
//   SETUP_SYNC_LAUNCH_KEEP   "1" なら後始末で worktree を消さない（dry と併用してテストで中身を見る）
//   SETUP_SYNC_LAUNCH_TIMEOUT_MS  裏 Claude の打ち切り時間（既定 1800000 = 30 分）
//   SETUP_SYNC_LOCK_STALE_MS ロックを死んだとみなす時間（既定 3600000 = 60 分）
//   SETUP_SYNC_PLUGINS_JSON  installed_plugins.json のパス
//
// 依存なし（Node 標準のみ）。

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
/* global process, console */

const here = dirname(fileURLToPath(import.meta.url));

// ---- 共通ユーティリティ ----

function readJson(path) {
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return null;
  }
}

// 子プロセス共通のオプション。**windowsHide は必須**。
// この launcher は hook から detached で起動されるためコンソールを持たない。Windows では
// コンソールを持たない親から起動されたコンソールアプリ（git / gh / claude.exe）が
// **新しいコンソールウィンドウを確保して画面に出る**。windowsHide でそれを抑止する。
// 既にコンソールがある場合（対話実行）は継承するだけなので、付けても害はない。
const HIDDEN = { windowsHide: true };

// git をシェル非経由で実行。失敗時は null。
function git(cwd, ...a) {
  try {
    return execFileSync("git", ["-C", cwd, ...a], {
      ...HIDDEN,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

// 結果ファイルのキー。git を叩かずプロジェクトパスだけから決める（hook 側の起動税を増やさない）。
// setup-sync-report.mjs が同一仕様の実装を持つ。hook は配備先へ単体コピーされる制約上 import
// できないため、ここは意図的な重複。変えるときは両方を揃える（cmpVer と同じ扱い）。
function resultKey(dir) {
  const norm = resolve(dir).replace(/[\\/]+$/, "");
  const canon = process.platform === "win32" ? norm.toLowerCase() : norm;
  let h = 0;
  for (let i = 0; i < canon.length; i++) h = (Math.imul(h, 31) + canon.charCodeAt(i)) | 0;
  const name = (canon.split(/[\\/]/).pop() || "repo").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
  return `${name}-${(h >>> 0).toString(16)}`;
}

await main();

async function main() {
  const target = resolve(process.argv[2] || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const dataDir =
    process.env.SETUP_SYNC_DATA_DIR || join(homedir(), ".claude", "plugins", "data", "project-setup");
  const resultsDir = join(dataDir, "results");
  const resultPath = join(resultsDir, `${resultKey(target)}.json`);
  const lockPath = join(dataDir, "sync-lock.json");

  // 結果ディレクトリは実際に書くときだけ作る（起動を見送ったときに空 dir を残さない）。
  const finish = (status, message, extra = {}) => {
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(
      resultPath,
      JSON.stringify(
        { status, message, repo: target, finishedAt: new Date().toISOString(), ...extra },
        null,
        2
      ) + "\n",
      "utf8"
    );
    console.log(`[setup-sync] ${status}: ${message}`);
  };

  // ---- ロック（多重起動の防止）----
  // stale 判定は時刻のみで行う。pid の生存確認は OS 差が大きく、誤判定で永久ロックになるため。
  const staleMs = parseInt(process.env.SETUP_SYNC_LOCK_STALE_MS || "3600000", 10);
  const lock = readJson(lockPath);
  if (lock && Date.now() - Date.parse(lock.startedAt || 0) < staleMs) {
    console.log(`[setup-sync] 既に同期プロセスが走っています（pid=${lock.pid}）。起動しません。`);
    return;
  }
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, repo: target, startedAt: new Date().toISOString() }, null, 2) + "\n",
    "utf8"
  );

  let worktree = null;
  try {
    if (git(target, "rev-parse", "--is-inside-work-tree") !== "true") {
      finish("failed", `対象が git リポジトリではありません: ${target}`);
      return;
    }

    // ---- 現行プラグイン版（ブランチ名の決定に要る。sync-run.mjs と同じ読み方）----
    const version = readCurrentVersion();
    if (!version) {
      finish("failed", "現行プラグイン版を特定できませんでした（installed_plugins.json / plugin.json とも読めず）。");
      return;
    }
    const branch = `chore/setup-sync-v${version}`;

    // ---- origin の最新を取り、default ブランチを起点にする ----
    // 起点を明示しないと「ユーザーがいま乗っているブランチ」から同期ブランチが生え、
    // 無関係なコミットごと PR に載る。
    if (git(target, "fetch", "origin", "--prune", "--quiet") === null) {
      finish("failed", "git fetch origin に失敗しました（ネットワーク / 認証を確認してください）。");
      return;
    }
    const base = resolveDefaultBranch(target);
    if (!base) {
      finish("failed", "origin の default ブランチを特定できませんでした。");
      return;
    }

    // ---- 使い捨て worktree ----
    // sparse-checkout でテンプレが触る領域だけを展開する。Unity のような巨大リポジトリで
    // 全チェックアウトすると起動のたびに数分と数 GB を払うことになるため。
    worktree = join(dataDir, "worktrees", `${resultKey(target)}-v${version}`);
    if (existsSync(worktree)) {
      git(target, "worktree", "remove", "--force", worktree);
      rmSync(worktree, { recursive: true, force: true });
    }
    git(target, "worktree", "prune");
    mkdirSync(dirname(worktree), { recursive: true });
    if (git(target, "worktree", "add", "--no-checkout", "--detach", worktree, `origin/${base}`) === null) {
      finish("failed", `worktree の作成に失敗しました（${worktree}）。`);
      return;
    }
    // cone モードのルート直下ファイル（CLAUDE.md 等）は常に含まれる。
    git(worktree, "sparse-checkout", "set", "--cone", ".claude", ".github", ".githooks");
    if (git(worktree, "checkout") === null) {
      finish("failed", "worktree の sparse checkout に失敗しました。");
      return;
    }

    // ---- 裏 Claude を起動して同期スキルを走らせる ----
    if (process.env.SETUP_SYNC_LAUNCH_DRY === "1") {
      finish("skipped", `dry: worktree のみ作成しました（${worktree}）。`, { version, branch });
      return;
    }
    const claudeBin = resolveClaudeBin();
    if (!claudeBin) {
      finish("failed", "claude 実行ファイルが見つかりませんでした。");
      return;
    }
    const res = spawnSync(
      claudeBin,
      [
        "-p",
        `/project-setup:setup-sync ${worktree}`,
        "--permission-mode",
        "bypassPermissions",
        "--add-dir",
        installRoot(),
      ],
      {
        ...HIDDEN, // これが無いと裏の Claude がターミナルウィンドウを開いて数分居座る
        cwd: worktree,
        encoding: "utf8",
        timeout: parseInt(process.env.SETUP_SYNC_LAUNCH_TIMEOUT_MS || "1800000", 10),
        // 裏 Claude 自身の SessionStart hook が同じ検知をして再帰起動しないよう止める。
        env: { ...process.env, SETUP_SYNC_DISABLE: "1", CLAUDE_PROJECT_DIR: worktree },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    // ---- 結果は claude の出力ではなく gh に聞く（LLM の文面に依存しない）----
    const pr = findPr(worktree, branch);
    if (pr) {
      finish("pr", `テンプレ同期 PR を作成しました（v${version}）`, { version, branch, prUrl: pr.url, prNumber: pr.number });
    } else if (res.error || res.status !== 0) {
      const detail = String(res.error?.message || res.stderr || "").trim().slice(0, 500);
      finish("failed", `同期の実行に失敗しました（v${version}）: ${detail}`, { version, branch });
    } else {
      // 同期不要 / 既存 PR あり / 試行上限 のいずれか。sync-run.mjs が理由を出力している。
      const tail = String(res.stdout || "").trim().split("\n").slice(-3).join(" / ").slice(0, 300);
      finish("skipped", `同期 PR は作成されませんでした（v${version}）: ${tail}`, { version, branch });
    }
  } catch (e) {
    finish("failed", `想定外のエラー: ${String(e?.message || e).trim().slice(0, 500)}`);
  } finally {
    if (worktree && process.env.SETUP_SYNC_LAUNCH_KEEP !== "1") {
      git(target, "worktree", "remove", "--force", worktree);
      rmSync(worktree, { recursive: true, force: true });
      git(target, "worktree", "prune");
    }
    rmSync(lockPath, { force: true });
  }
}

// ---- 補助 ----

// installed_plugins.json から現行版を読む（sync-run.mjs / setup-sync-check.mjs と同一仕様）。
function pluginEntry() {
  const p =
    process.env.SETUP_SYNC_PLUGINS_JSON || join(homedir(), ".claude", "plugins", "installed_plugins.json");
  const installed = readJson(p);
  if (!installed?.plugins) return null;
  const key = Object.keys(installed.plugins).find((k) => /^project-setup@/.test(k));
  const entries = key && installed.plugins[key];
  if (!Array.isArray(entries) || entries.length === 0) return null;
  return entries.slice().sort((a, b) => String(b.lastUpdated || "").localeCompare(String(a.lastUpdated || "")))[0];
}

function readCurrentVersion() {
  const e = pluginEntry();
  let v = e?.version;
  if (!v || v === "unknown") v = readJson(join(installRoot(), ".claude-plugin", "plugin.json"))?.version;
  return v || null;
}

// プラグインのルート。installed_plugins.json の installPath を優先し、無ければ
// このファイルの位置から推定する（skills/setup-sync/ の 2 つ上）。
function installRoot() {
  return pluginEntry()?.installPath || join(here, "..", "..");
}

// origin の default ブランチ名。symbolic-ref が未設定のリポジトリのために fallback を持つ。
function resolveDefaultBranch(target) {
  const sym = git(target, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
  if (sym) return sym.replace(/^origin\//, "");
  // origin/HEAD 未設定。remote から引き直してもう一度試す。
  git(target, "remote", "set-head", "origin", "--auto");
  const sym2 = git(target, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
  if (sym2) return sym2.replace(/^origin\//, "");
  for (const b of ["main", "develop", "master"]) {
    if (git(target, "rev-parse", "--verify", `origin/${b}`) !== null) return b;
  }
  return null;
}

function resolveClaudeBin() {
  if (process.env.SETUP_SYNC_CLAUDE_BIN) return process.env.SETUP_SYNC_CLAUDE_BIN;
  const which = process.platform === "win32" ? "where" : "which";
  try {
    const out = execFileSync(which, ["claude"], {
      ...HIDDEN,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = out.split(/\r?\n/).find(Boolean);
    if (first) return first.trim();
  } catch {
    /* PATH に無い。既定の配置を見る */
  }
  const fallback = join(homedir(), ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude");
  return existsSync(fallback) ? fallback : null;
}

// 同期ブランチの open PR を gh に問い合わせる。claude の出力文面には依存しない。
function findPr(cwd, branch) {
  try {
    const raw = execFileSync("gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "number,url"], {
      ...HIDDEN,
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const list = JSON.parse(raw);
    return Array.isArray(list) && list.length ? list[0] : null;
  } catch {
    return null;
  }
}
