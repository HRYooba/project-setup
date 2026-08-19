// unity-parallel の coordinator（検証レーンの貸し出し管理）。
//
// Unity Editor は 1 つしか無く、開いているフォルダ 1 つしか見ない。並列作業する worktree が
// Editor を必要としたとき、このスクリプトが「順番に 1 人だけへ貸す」を機械的に担保する。
// 散文の手順書では担保できない（守られなかったことが出力に現れないため）。
//
// 状態は <git-common-dir>/unity-parallel/ に置く。checkout で切り替わらず、
// どの worktree から見ても同じ実体を指す必要があるため。
//
// 使い方: node lane.mjs <command> [options]
//   doctor                    前提と現状の点検（破壊的操作なし）
//   init [--lane <path>]      レーンの初期化（既定のレーンはリポジトリのルート）
//   add <name> [--base <ref>] 作業用 worktree を作る
//   request --worktree <name> --commit <sha>   Editor の順番待ちに入る（差分ゲートを通る）
//   grant                     先頭の待ち手へ貸し出す（PREPARING → checkout --detach）
//   activate                  Editor の準備完了を確認して ACTIVE にする
//   delegate <agentType>      検証エージェント（unity-tester 等）へ一時的に権限を渡す
//   undelegate                委譲を戻す
//   drain                     新規 MCP を締め切る（ACTIVE → DRAINING）
//   seal -m <msg>             レーン上の Editor 成果をコミットする（.meta の取りこぼし防止）
//   return                    成果を worktree へ cherry-pick して返却する
//   abandon --reason <text>   成果を戻さずに返却する（レーンの変更は破棄しない）
//   status                    現在の状態
//   recover [--abort]         異常終了からの検査・解除
//   remove <name>             worktree を安全確認つきで削除する
//
// 依存なし（Node 標準のみ）。

import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  LEASE_MS,
  appendJournal,
  emptyState,
  ensureStateDir,
  git,
  isUnitySerialized,
  laneStateDir,
  readState,
  withStateLock,
  writeState,
} from "./protocol.mjs";
/* global process, console */

const IDENTITY_MAX_AGE_MS = 120 * 1000;

// ---------------------------------------------------------------------------
// 引数
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const command = argv[0];
const positional = [];
const opts = {};
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) opts[key] = true;
    else opts[key] = argv[++i];
  } else if (a === "-m") {
    opts.message = argv[++i];
  } else {
    positional.push(a);
  }
}

function fail(msg) {
  console.error(`エラー: ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(msg);
}

// ---------------------------------------------------------------------------
// 共通
// ---------------------------------------------------------------------------

const cwd = process.cwd();
let stateDir;
try {
  stateDir = laneStateDir(cwd);
} catch {
  fail("git リポジトリの中で実行してください。");
}

function repoRoot() {
  // レーンの既定値。common-dir の 1 つ上がリポジトリ本体の作業ツリー。
  return resolve(git(["rev-parse", "--show-toplevel"], cwd));
}

function loadState() {
  const s = readState(stateDir);
  if (!s) fail("レーンが初期化されていません。先に `lane.mjs init` を実行してください。");
  return s;
}

function mutate(fn) {
  return withStateLock(stateDir, () => {
    const s = loadState();
    const result = fn(s);
    writeState(stateDir, s);
    return result;
  });
}

function shortSha(sha) {
  return String(sha || "").slice(0, 8);
}

function isClean(dir) {
  // untracked も見る。Editor が生成した .meta を取りこぼしたまま次へ進ませないため。
  return git(["status", "--porcelain"], dir) === "";
}

function headOf(dir) {
  return git(["rev-parse", "HEAD"], dir);
}

// 門番が記録した呼び出し元の識別子を読む。エージェントは自分の agent_id を知らないので、
// 自己申告させると identity が意味を持たなくなる。hook 側でしか観測できない値を使う。
function consumeIdentity() {
  const p = join(stateDir, "pending-identity.json");
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    const age = Date.now() - new Date(parsed.at).getTime();
    if (!(age >= 0 && age < IDENTITY_MAX_AGE_MS)) return null;
    return { agentId: parsed.agentId || null, agentType: parsed.agentType || null };
  } catch {
    return null;
  } finally {
    rmSync(p, { force: true });
  }
}

function markRecovery(state, reason) {
  state.recovery = { reason, at: new Date().toISOString(), holder: state.holder };
  appendJournal(stateDir, { event: "recovery", reason, holder: state.holder });
}

// ---------------------------------------------------------------------------
// 差分ゲート
// ---------------------------------------------------------------------------

// Editor を通さずに Unity アセットが書き換えられていないかを、checkout する前に見る。
// checkout してから見ると、常駐 Editor が壊れたファイルを読み込んだ後になる。
function inspectRange(worktreePath, base, target) {
  const raw = git(["diff", "--name-status", "-M", `${base}...${target}`], worktreePath);
  const violations = [];
  const changed = [];
  for (const line of raw.split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    const status = parts[0];
    const paths = parts.slice(1);
    const target1 = paths[paths.length - 1];
    changed.push({ status, paths });

    if (paths.some((p) => isUnitySerialized(p))) {
      violations.push(
        `${status} ${paths.join(" -> ")} : Unity がシリアライズするファイルは Editor（MCP）経由でしか変更できません`
      );
      continue;
    }
    // .cs / .asmdef の rename・delete は .meta の GUID が分岐する。
    // Editor を借りている間に MCP のアセット操作で行う必要がある。
    if (/^R/.test(status) && /\.(cs|asmdef|asmref)$/i.test(target1)) {
      violations.push(`${status} ${paths.join(" -> ")} : アセットの移動・改名は Editor 経由で行ってください（.meta が分岐します）`);
    }
    if (/^D/.test(status) && /\.(cs|asmdef|asmref)$/i.test(target1)) {
      violations.push(`${status} ${paths.join(" -> ")} : アセットの削除は Editor 経由で行ってください（.meta が残ります）`);
    }
  }
  return { violations, changed };
}

// ---------------------------------------------------------------------------
// コマンド
// ---------------------------------------------------------------------------

function cmdInit() {
  ensureStateDir(stateDir);
  const lanePath = resolve(opts.lane || repoRoot());
  if (!existsSync(join(lanePath, "ProjectSettings", "ProjectVersion.txt"))) {
    fail(`レーンに指定した ${lanePath} が Unity プロジェクトではありません（ProjectSettings/ProjectVersion.txt が無い）。`);
  }
  withStateLock(stateDir, () => {
    const existing = (() => {
      try {
        return readState(stateDir);
      } catch {
        return null;
      }
    })();
    const s = existing || emptyState(lanePath);
    s.lanePath = lanePath;
    s.worktrees = s.worktrees || {};
    writeState(stateDir, s);
  });
  appendJournal(stateDir, { event: "init", lanePath });
  ok(`レーンを初期化しました: ${lanePath}`);
  ok(`状態ディレクトリ: ${stateDir}`);
  ok("Unity Editor はこのフォルダを開いたままにしてください。");
}

function cmdAdd() {
  const name = positional[0];
  if (!name) fail("worktree 名を指定してください: lane.mjs add <name>");
  const s = loadState();
  const base = opts.base || defaultBranchRef();
  const branch = opts.branch || `feat/${name}`;
  // Unity のリポジトリはパスが深く MAX_PATH に当たりやすい。リポジトリの隣に浅く作る。
  const path = resolve(opts.path || join(s.lanePath, "..", `wt-${name}`));
  if (existsSync(path)) fail(`${path} が既に存在します。`);

  git(["worktree", "add", "-b", branch, path, base], s.lanePath);
  const baseCommit = headOf(path);
  mutate((st) => {
    st.worktrees = st.worktrees || {};
    st.worktrees[name] = { name, path, branch, baseCommit, createdAt: new Date().toISOString() };
  });
  appendJournal(stateDir, { event: "worktree-add", name, path, branch, baseCommit });
  ok(`worktree を作成しました: ${path}`);
  ok(`  branch: ${branch}`);
  ok(`  base:   ${shortSha(baseCommit)}`);
}

function defaultBranchRef() {
  try {
    return git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
  } catch {
    return "HEAD";
  }
}

function cmdRequest() {
  const name = opts.worktree || positional[0];
  if (!name) fail("--worktree <name> を指定してください。");
  const identity = consumeIdentity();
  const s = loadState();
  const wt = (s.worktrees || {})[name];
  if (!wt) fail(`未登録の worktree です: ${name}（lane.mjs add で作ったものだけを扱えます）`);
  if (!isClean(wt.path)) {
    fail(
      `${wt.path} に未コミットの変更があります。Editor へ渡せるのは commit だけです。\n` +
        git(["status", "--short"], wt.path)
    );
  }

  const target = opts.commit ? git(["rev-parse", opts.commit], wt.path) : headOf(wt.path);
  // 2 回目以降は「前回 Editor へ載せて承認された commit」を基準にする。
  // 初回 base に戻すと、レーンで正規に作られた .prefab などを毎回違反として弾いてしまう。
  const gateBase = (s.approvedSnapshots || {})[name] || wt.baseCommit;
  const { violations, changed } = inspectRange(wt.path, gateBase, target);
  if (violations.length) {
    console.error(`検証レーンへ載せられません（${gateBase.slice(0, 8)}...${shortSha(target)} に禁止された変更があります）:`);
    for (const v of violations) console.error(`  - ${v}`);
    console.error("\nこれらは Editor を借りている間に MCP 経由で行ってください。");
    process.exit(1);
  }

  mutate((st) => {
    st.queue = st.queue || [];
    if (st.holder && st.holder.worktree === name) fail(`${name} は既に Editor を借りています。`);
    const dup = st.queue.findIndex((q) => q.worktree === name);
    const entry = {
      worktree: name,
      branch: wt.branch,
      path: wt.path,
      // 待っている間に worker が commit を進めても、載せるのは要求時点の commit（不変）。
      // branch 名で解決し直すと、承認した差分と違うものを検証してしまう。
      commit: target,
      gateBase,
      agentId: identity ? identity.agentId : null,
      agentType: identity ? identity.agentType : null,
      requestedAt: new Date().toISOString(),
    };
    if (dup >= 0) st.queue[dup] = entry;
    else st.queue.push(entry);
  });
  appendJournal(stateDir, { event: "request", worktree: name, commit: target, agentId: identity && identity.agentId });
  const pos = loadState().queue.findIndex((q) => q.worktree === name) + 1;
  ok(`順番待ちに入りました: ${name} @ ${shortSha(target)}（${changed.length} 件の変更 / ${pos} 番目）`);
  if (!identity) {
    ok("注意: 呼び出し元の識別子を記録できませんでした。メインセッションからの代理要求として扱います。");
  }
}

function cmdGrant() {
  const s = loadState();
  if (s.recovery) fail("RECOVERY_REQUIRED です。lane.mjs recover で解除してください。");
  if (s.holder) fail(`既に ${s.holder.worktree} が借りています（phase: ${s.holder.phase}）。`);
  if (!s.queue || !s.queue.length) fail("順番待ちがいません。");
  if (!isClean(s.lanePath)) {
    console.error(`レーン（${s.lanePath}）に未コミットの変更があります。上書きせずに止めます:`);
    console.error(git(["status", "--short"], s.lanePath));
    console.error("\nEditor 側で未保存のシーン / Prefab Stage が無いか確認し、必要な変更を commit するか破棄してください。");
    process.exit(1);
  }

  const entry = mutate((st) => {
    const e = st.queue.shift();
    st.generation += 1;
    st.holder = {
      ...e,
      phase: "PREPARING",
      generation: st.generation,
      loadedCommit: null,
      delegate: null,
      acquiredAt: new Date().toISOString(),
    };
    return e;
  });

  // checkout は detach で行う。対象 branch は worker の worktree が掴んでいるため、
  // 通常の checkout は必ず "already checked out" で失敗する。
  git(["checkout", "--detach", entry.commit], s.lanePath);
  const head = headOf(s.lanePath);
  mutate((st) => {
    st.holder.loadedCommit = head;
  });
  appendJournal(stateDir, { event: "grant", worktree: entry.worktree, commit: head, generation: loadState().generation });

  ok(`${entry.worktree} へ貸し出しました（phase: PREPARING）。`);
  ok(`  レーン: ${s.lanePath} → ${shortSha(head)}`);
  ok("");
  ok("次にメインセッションが行うこと:");
  ok("  1. Editor が Play Mode でなく、インポート・コンパイルが終わっていることを確認する");
  ok("  2. バインディング表の「コンパイル確認」で refresh し、ready を待つ");
  ok("  3. node lane.mjs activate  ← ここで初めて借り手が Unity MCP を呼べるようになる");
}

function cmdActivate() {
  mutate((st) => {
    if (!st.holder) fail("貸し出し中の worktree がありません。");
    if (st.holder.phase !== "PREPARING") fail(`PREPARING ではありません（現在 ${st.holder.phase}）。`);
    const head = headOf(st.lanePath);
    if (head !== st.holder.loadedCommit) {
      markRecovery(st, `activate 時点で HEAD が想定と違う（${shortSha(head)} != ${shortSha(st.holder.loadedCommit)}）`);
      fail("レーンの HEAD が貸し出し時と違います。RECOVERY_REQUIRED にしました。");
    }
    st.holder.phase = "ACTIVE";
    st.holder.activatedAt = new Date().toISOString();
  });
  appendJournal(stateDir, { event: "activate", holder: loadState().holder });
  ok("ACTIVE にしました。借り手が Unity MCP を使えます。");
}

function cmdDelegate() {
  const agentType = positional[0] || opts.agent;
  if (!agentType) fail("委譲先のエージェント種別を指定してください: lane.mjs delegate unity-tester");
  mutate((st) => {
    if (!st.holder) fail("貸し出し中の worktree がありません。");
    if (st.holder.phase !== "ACTIVE") fail(`ACTIVE ではありません（現在 ${st.holder.phase}）。`);
    st.holder.delegate = { agentType, at: new Date().toISOString() };
  });
  appendJournal(stateDir, { event: "delegate", agentType });
  ok(`${agentType} へ権限を委譲しました。終わったら lane.mjs undelegate を実行してください。`);
}

function cmdUndelegate() {
  mutate((st) => {
    if (!st.holder) fail("貸し出し中の worktree がありません。");
    st.holder.delegate = null;
  });
  ok("委譲を戻しました。");
}

function cmdDrain() {
  mutate((st) => {
    if (!st.holder) fail("貸し出し中の worktree がありません。");
    if (st.holder.phase !== "ACTIVE") fail(`ACTIVE ではありません（現在 ${st.holder.phase}）。`);
    st.holder.phase = "DRAINING";
    st.holder.delegate = null;
  });
  appendJournal(stateDir, { event: "drain" });
  ok("DRAINING にしました。新規の Unity MCP 呼び出しは止まります。");
  ok("Editor 側でシーン / Prefab Stage を保存し、lane.mjs seal -m \"...\" で成果をコミットしてください。");
}

function cmdSeal() {
  const message = opts.message;
  if (!message) fail('コミットメッセージを指定してください: lane.mjs seal -m "feat: ..."');
  const s = loadState();
  if (!s.holder) fail("貸し出し中の worktree がありません。");
  if (!["DRAINING", "ACTIVE"].includes(s.holder.phase)) fail(`ACTIVE / DRAINING ではありません（現在 ${s.holder.phase}）。`);

  const status = git(["status", "--porcelain"], s.lanePath);
  if (!status) {
    ok("レーンに変更はありません（Editor 作業の成果なし）。");
    return;
  }
  // Editor が生成した .meta を取りこぼすと、worktree 側で別の GUID が再生成されて参照が壊れる。
  // よって untracked も含めてまとめて拾う。何を拾ったかは必ず表示する。
  console.log("レーン上の変更:");
  console.log(status);
  git(["add", "-A"], s.lanePath);
  git(["commit", "-m", message], s.lanePath);
  const head = headOf(s.lanePath);
  appendJournal(stateDir, { event: "seal", commit: head, message });
  ok(`レーンでコミットしました: ${shortSha(head)}`);
}

function cmdReturn() {
  const s = loadState();
  if (!s.holder) fail("貸し出し中の worktree がありません。");
  const h = s.holder;
  if (h.phase !== "DRAINING") fail(`DRAINING ではありません（現在 ${h.phase}）。先に lane.mjs drain を実行してください。`);
  if (!isClean(s.lanePath)) {
    console.error("レーンに未コミットの変更が残っています。lane.mjs seal でコミットしてから返却してください:");
    console.error(git(["status", "--short"], s.lanePath));
    process.exit(1);
  }

  const laneHead = headOf(s.lanePath);
  const wtHead = headOf(h.path);
  if (wtHead !== h.commit) {
    markRecoveryAndFail(
      `貸し出し中に ${h.worktree} の HEAD が進みました（${shortSha(wtHead)} != ${shortSha(h.commit)}）。` +
        "自動では戻しません。手で確認してください。"
    );
  }

  if (laneHead === h.loadedCommit) {
    // Editor 作業の成果なし。返すものが無い。
    finishRelease(h, laneHead, "no-changes");
    ok(`${h.worktree} へ返却しました（レーン上の変更なし）。`);
    return;
  }

  mutate((st) => {
    st.holder.phase = "RETURNING";
  });
  const range = `${h.loadedCommit}..${laneHead}`;
  try {
    git(["cherry-pick", range], h.path);
  } catch (e) {
    // 競合を残したまま次へ進ませない。人が判断するまで止める。
    markRecoveryAndFail(
      `cherry-pick に失敗しました（${range} → ${h.path}）。\n${e.stdout || ""}${e.stderr || ""}\n` +
        `${h.path} で競合を解決するか git cherry-pick --abort してから lane.mjs recover を実行してください。`
    );
  }

  // 戻したものがレーンの内容と一致するかを tree で確かめる。
  // cherry-pick が通っても、内容が一致していなければ戻せていない。
  const laneTree = git(["rev-parse", `${laneHead}^{tree}`], s.lanePath);
  const wtTree = git(["rev-parse", "HEAD^{tree}"], h.path);
  if (laneTree !== wtTree) {
    markRecoveryAndFail(
      `cherry-pick 後の内容がレーンと一致しません（tree ${laneTree.slice(0, 8)} != ${wtTree.slice(0, 8)}）。` +
        `.meta の取りこぼしや競合解決のずれが疑われます。`
    );
  }

  finishRelease(h, laneHead, "returned");
  ok(`${h.worktree} へ返却しました。`);
  ok(`  cherry-pick: ${range}`);
  ok(`  ${h.path} の HEAD: ${shortSha(headOf(h.path))}`);
}

function finishRelease(h, laneHead, kind) {
  withStateLock(stateDir, () => {
    const st = loadState();
    st.approvedSnapshots = st.approvedSnapshots || {};
    // 次回の差分ゲートの基準。ここで承認した内容を、次に違反として弾かないため。
    st.approvedSnapshots[h.worktree] = kind === "returned" ? headOf(h.path) : h.commit;
    st.holder = null;
    writeState(stateDir, st);
  });
  rmSync(join(stateDir, "heartbeat"), { force: true });
  appendJournal(stateDir, { event: "release", worktree: h.worktree, kind, laneHead });
}

function cmdAbandon() {
  const reason = opts.reason || "理由未記入";
  const s = loadState();
  if (!s.holder) fail("貸し出し中の worktree がありません。");
  const h = s.holder;
  // レーンの変更は破棄しない（消すと取り返しがつかない）。detached のまま残し、場所を伝える。
  const laneHead = headOf(s.lanePath);
  finishRelease(h, laneHead, "abandoned");
  appendJournal(stateDir, { event: "abandon", worktree: h.worktree, reason, laneHead });
  ok(`${h.worktree} の貸し出しを終了しました（戻していません）。`);
  if (laneHead !== h.loadedCommit) {
    ok(`レーン上のコミットは破棄していません: ${laneHead}`);
    ok(`必要なら手で回収してください: git -C ${h.path} cherry-pick ${h.loadedCommit}..${laneHead}`);
  }
}

function markRecoveryAndFail(msg) {
  withStateLock(stateDir, () => {
    const st = loadState();
    markRecovery(st, msg);
    writeState(stateDir, st);
  });
  console.error(`エラー: ${msg}`);
  console.error("RECOVERY_REQUIRED にしました。lane.mjs recover で検査してください。");
  process.exit(1);
}

function cmdStatus() {
  const s = loadState();
  ok(`レーン: ${s.lanePath}`);
  ok(`  HEAD: ${shortSha(safe(() => headOf(s.lanePath)))}`);
  ok(`  作業ツリー: ${safe(() => (isClean(s.lanePath) ? "clean" : "dirty")) || "不明"}`);
  ok(`世代: ${s.generation}`);
  if (s.recovery) {
    ok(`\n*** RECOVERY_REQUIRED ***`);
    ok(`  理由: ${s.recovery.reason}`);
    ok(`  検出: ${s.recovery.at}`);
  }
  if (s.holder) {
    const h = s.holder;
    ok(`\n貸し出し中: ${h.worktree}（phase: ${h.phase}）`);
    ok(`  commit: ${shortSha(h.commit)} / 読み込み済み: ${shortSha(h.loadedCommit)}`);
    ok(`  agentId: ${h.agentId || "(メインセッション)"}`);
    if (h.delegate) ok(`  委譲中: ${h.delegate.agentType}`);
    ok(`  経過: ${elapsed(h.acquiredAt)}${leaseExpired(h) ? "（リース期限超過）" : ""}`);
  } else {
    ok("\n貸し出し中: なし");
  }
  ok(`\n順番待ち: ${(s.queue || []).length} 件`);
  for (const [i, q] of (s.queue || []).entries()) {
    ok(`  ${i + 1}. ${q.worktree} @ ${shortSha(q.commit)}（${elapsed(q.requestedAt)}待ち）`);
  }
  const wts = Object.values(s.worktrees || {});
  ok(`\n登録 worktree: ${wts.length} 件`);
  for (const w of wts) ok(`  - ${w.name}  ${w.branch}  ${w.path}`);
}

function cmdDoctor() {
  const problems = [];
  const s = (() => {
    try {
      return readState(stateDir);
    } catch (e) {
      problems.push(`状態ファイルが壊れています: ${e.message}`);
      return null;
    }
  })();

  ok(`状態ディレクトリ: ${stateDir}`);
  if (!s) {
    ok("レーン: 未初期化（lane.mjs init）");
  } else {
    ok(`レーン: ${s.lanePath}`);
    if (!existsSync(join(s.lanePath, "ProjectSettings", "ProjectVersion.txt"))) {
      problems.push(`レーンが Unity プロジェクトではありません: ${s.lanePath}`);
    }
    try {
      if (!isClean(s.lanePath)) problems.push(`レーンに未コミットの変更があります（貸し出し前に解消が必要）`);
    } catch (e) {
      problems.push(`レーンの git 状態を読めません: ${e.message}`);
    }
    if (s.recovery) problems.push(`RECOVERY_REQUIRED: ${s.recovery.reason}`);
    if (s.holder) {
      if (leaseExpired(s.holder)) problems.push(`リース期限を超過しています（${elapsed(s.holder.acquiredAt)}）`);
      const hb = heartbeatAge();
      if (hb !== null && hb > 15 * 60 * 1000) problems.push(`借り手の応答が ${Math.round(hb / 60000)} 分ありません`);
    }
  }

  // Unity MCP の実装をルールから導出できるか（guard がツール名を判定するのに使う）
  const rulePath = join(repoRoot(), ".claude", "rules", "unity-mcp.md");
  if (!existsSync(rulePath)) {
    problems.push(`.claude/rules/unity-mcp.md がありません（setup-unity を実行してください）`);
  } else {
    const prefixes = new Set();
    for (const m of readFileSync(rulePath, "utf8").matchAll(/mcp__([A-Za-z0-9_.-]+)__/g)) prefixes.add(`mcp__${m[1]}__`);
    if (!prefixes.size) {
      problems.push("rules/unity-mcp.md から Unity MCP のツール接頭辞を導出できません（門番が名前で推測する縮退動作になります）");
    } else {
      ok(`Unity MCP 接頭辞: ${[...prefixes].join(" ")}`);
    }
  }

  const stale = join(stateDir, "state.lock");
  if (existsSync(stale)) problems.push(`state.lock が残っています: ${stale}（プロセスが落ちた可能性）`);

  ok("");
  if (problems.length) {
    ok(`問題 ${problems.length} 件:`);
    for (const p of problems) ok(`  - ${p}`);
    process.exit(1);
  }
  ok("問題なし。");
}

function cmdRecover() {
  const s = loadState();
  if (!s.recovery) {
    // 期限切れの検出もここで行う。期限切れでも自動剥奪はしない。
    if (s.holder && leaseExpired(s.holder)) {
      mutate((st) => markRecovery(st, `リース期限超過（${elapsed(st.holder.acquiredAt)}）`));
      ok("リース期限超過を検出し RECOVERY_REQUIRED にしました。もう一度 recover を実行して内容を確認してください。");
      return;
    }
    ok("復旧が必要な状態ではありません。");
    return;
  }

  ok("*** RECOVERY_REQUIRED ***");
  ok(`理由: ${s.recovery.reason}`);
  ok(`検出: ${s.recovery.at}`);
  const h = s.recovery.holder || s.holder;
  if (h) {
    ok(`\n中断時の借り手: ${h.worktree}（phase: ${h.phase}）`);
    ok(`  読み込み済み commit: ${h.loadedCommit}`);
    ok(`  worktree: ${h.path}`);
    ok(`  worktree の HEAD: ${safe(() => headOf(h.path))}`);
  }
  ok(`\nレーンの HEAD: ${safe(() => headOf(s.lanePath))}`);
  ok(`レーンの状態: ${safe(() => (isClean(s.lanePath) ? "clean" : "dirty"))}`);
  if (existsSync(join(s.lanePath, ".git", "CHERRY_PICK_HEAD")) || existsSync(join(s.lanePath, "CHERRY_PICK_HEAD"))) {
    ok("cherry-pick が中断されたまま残っています。");
  }

  if (!opts.abort) {
    ok("\n中身を確認したうえで解除する場合: lane.mjs recover --abort");
    ok("（--abort は貸し出しを取り消して順番待ちを再開できる状態に戻します。ファイルは消しません）");
    return;
  }

  mutate((st) => {
    appendJournal(stateDir, { event: "recover-abort", holder: st.holder, recovery: st.recovery });
    st.holder = null;
    st.recovery = null;
  });
  rmSync(join(stateDir, "heartbeat"), { force: true });
  ok("貸し出しを取り消しました。レーンの内容は変更していません。");
  ok("レーンの HEAD とコミットを確認してから、次の grant を行ってください。");
}

function cmdRemove() {
  const name = positional[0];
  if (!name) fail("worktree 名を指定してください: lane.mjs remove <name>");
  const s = loadState();
  const wt = (s.worktrees || {})[name];
  if (!wt) fail(`未登録の worktree です: ${name}`);
  if (s.holder && s.holder.worktree === name) fail(`${name} は Editor を借りている最中です。返却してから削除してください。`);

  // 消す前に「消えたら戻せないもの」を数える。作業量ではなく不可逆性の確認。
  const dirty = git(["status", "--porcelain"], wt.path);
  let unpushed = "";
  try {
    unpushed = git(["log", "--oneline", `@{upstream}..HEAD`], wt.path);
  } catch {
    unpushed = git(["log", "--oneline", `${wt.baseCommit}..HEAD`], wt.path);
  }

  if ((dirty || unpushed) && !opts.force) {
    console.error(`${name} には失われる変更があります。--force を付けない限り削除しません。`);
    if (dirty) console.error(`\n未コミットの変更:\n${dirty}`);
    if (unpushed) console.error(`\n未 push のコミット:\n${unpushed}`);
    process.exit(1);
  }

  git(["worktree", "remove", ...(opts.force ? ["--force"] : []), wt.path], s.lanePath);
  mutate((st) => {
    delete st.worktrees[name];
    st.queue = (st.queue || []).filter((q) => q.worktree !== name);
    delete (st.approvedSnapshots || {})[name];
  });
  appendJournal(stateDir, { event: "worktree-remove", name, path: wt.path });
  ok(`削除しました: ${wt.path}`);
}

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

function elapsed(iso) {
  if (!iso) return "不明";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  return m < 60 ? `${m}分` : `${Math.floor(m / 60)}時間${m % 60}分`;
}

function leaseExpired(holder) {
  if (!holder || !holder.acquiredAt) return false;
  return Date.now() - new Date(holder.acquiredAt).getTime() > LEASE_MS;
}

function heartbeatAge() {
  const p = join(stateDir, "heartbeat");
  if (!existsSync(p)) return null;
  try {
    return Date.now() - statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------

const commands = {
  init: cmdInit,
  add: cmdAdd,
  request: cmdRequest,
  grant: cmdGrant,
  activate: cmdActivate,
  delegate: cmdDelegate,
  undelegate: cmdUndelegate,
  drain: cmdDrain,
  seal: cmdSeal,
  return: cmdReturn,
  abandon: cmdAbandon,
  status: cmdStatus,
  doctor: cmdDoctor,
  recover: cmdRecover,
  remove: cmdRemove,
};

if (!command || !commands[command]) {
  console.error(`使い方: node lane.mjs <${Object.keys(commands).join(" | ")}> [options]`);
  process.exit(1);
}

try {
  commands[command]();
} catch (e) {
  if (e && e.status !== undefined && (e.stdout || e.stderr)) {
    console.error(`エラー: git コマンドが失敗しました。\n${e.stdout || ""}${e.stderr || ""}`);
    process.exit(1);
  }
  throw e;
}

