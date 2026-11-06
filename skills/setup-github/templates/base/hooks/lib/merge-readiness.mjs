// PR をマージしてよいかの判定。読み手は 2 つ:
//   - before-pr-merge.mjs（Claude の gh pr merge を PreToolUse で止める）
//   - .github/workflows/merge-gate.yml（人が GitHub 上で見る check。CLI として起動する）
// 条件を 2 箇所に書くと食い違うため、判定はこのファイルだけに置く。
//
// マージを止める条件:
//   - 他の CI が失敗・未完了（checks。merge-gate 自身の check は数えない）
//   - 未解決のレビュースレッドがある（threads）
//   - base ブランチの最新から遅れている（behind）
//
// CI の状態は workflow からは判定しない（includeChecks: false）。pull_request で起動した時点では
// 他の workflow も走り始めたばかりで常に「未完了」になり、完了を拾って再評価するトリガーも無い。
// CI の赤は GitHub が PR 画面に出すので、workflow はそれ以外の 2 条件だけを見る。
//
// CLI: node merge-readiness.mjs <PR番号> --repo=<owner/name> [--no-checks]
//   止める条件があれば exit 1 と理由、無ければ exit 0。gh が要る（GH_TOKEN で認証）。

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
/* global process, console */

// merge-gate.yml の workflow 名。自身の check を CI 条件から外すのに使う
// （外さないと、赤になった gate が自分を理由に赤のまま残り、Claude のマージを永久に止める）。
export const GATE_WORKFLOW = "merge-gate";

const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

// statusCheckRollup の 1 件を { name, state: "passed" | "failed" | "pending" } にする。
// CheckRun（Actions 等）と StatusContext（外部の commit status）で形が違う。
function classifyCheck(c) {
  if (c?.__typename === "StatusContext") {
    const s = String(c.state ?? "").toUpperCase();
    return {
      name: c.context ?? "(status)",
      state: s === "SUCCESS" ? "passed" : s === "PENDING" || s === "EXPECTED" ? "pending" : "failed",
    };
  }
  const name = c?.workflowName ? `${c.workflowName} / ${c.name}` : (c?.name ?? "(check)");
  if (String(c?.status ?? "").toUpperCase() !== "COMPLETED") return { name, state: "pending" };
  return { name, state: PASSED.has(String(c?.conclusion ?? "").toUpperCase()) ? "passed" : "failed" };
}

const isGateCheck = (c) => c?.workflowName === GATE_WORKFLOW;

// 取得済みの状態から、止める理由の一覧を返す（空 = マージしてよい）。gh を呼ばない。
export function judge({ checks = [], unresolvedThreads = 0, behindBy = 0 }, { includeChecks = true } = {}) {
  const problems = [];
  if (includeChecks) {
    const classified = checks.filter((c) => !isGateCheck(c)).map(classifyCheck);
    const failed = classified.filter((c) => c.state === "failed").map((c) => c.name);
    const pending = classified.filter((c) => c.state === "pending").map((c) => c.name);
    if (failed.length) problems.push({ kind: "failed", detail: failed });
    if (pending.length) problems.push({ kind: "pending", detail: pending });
  }
  if (unresolvedThreads > 0) problems.push({ kind: "threads", detail: unresolvedThreads });
  if (behindBy > 0) problems.push({ kind: "behind", detail: behindBy });
  return problems;
}

// 止める理由を、次に取る行動つきの文にする。
export function describe(problems, prNumber) {
  return problems.map((p) => {
    switch (p.kind) {
      case "failed":
        return `CI が失敗している: ${p.detail.join(", ")}（直して push する）`;
      case "pending":
        return `CI が終わっていない: ${p.detail.join(", ")}（\`gh pr checks ${prNumber} --watch\` で完了を待つ）`;
      case "threads":
        return `未解決のレビュースレッドが ${p.detail} 件ある（直すか、理由を返信してから Resolve する）`;
      case "behind":
        return `base ブランチより ${p.detail} コミット遅れている（\`gh pr update-branch ${prNumber}\` で取り込む）`;
      default:
        return String(p.kind);
    }
  });
}

// gh pr merge の呼び出しを捕まえる（コマンド段の先頭だけ。echo などの引数に含まれる文字列は拾わない）。
// 1: 段の区切り文字 / 2: 前置きの環境変数代入 / 3: gh pr merge の引数
const MERGE_RE =
  /(^|[;|&\n(])\s*((?:\w+=(?:"[^"]*"|'[^']*'|\S*)\s+)*)(?:command\s+)?(?:\S*\/)?gh\s+pr\s+merge\b([^;|&\n)]*)/;

// 値を取るフラグ。直後の語を PR 指定と取り違えないために要る。
const VALUE_FLAGS = new Set([
  "-R", "--repo", "-t", "--subject", "-b", "--body", "-F", "--body-file",
  "-A", "--author-email", "--match-head-commit",
]);

const words = (s) => (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^(["'])(.*)\1$/, "$2"));

// gh pr merge より前の段にある cd の行き先を、書かれた順に返す。
// 静的に追えない形（変数・コマンド置換・cd -・pushd/popd・cd の後でサブシェルを閉じる・
// || で cd の失敗側に分岐する）なら null。
function cdTargets(prefix) {
  if (/\bcd\b/.test(prefix) && prefix.includes("||")) return null;
  const targets = [];
  for (const stage of prefix.split(/[;&|\n]+/)) {
    const w = words(stage.replace(/^[\s(]+/, ""));
    if (w[0] === "pushd" || w[0] === "popd") return null;
    if (w[0] !== "cd") continue;
    const args = w.slice(1).filter((a) => a !== "--");
    if (args.length > 1) return null;
    const dir = args[0] ?? "~";
    if (dir === "-" || /[$`*?]/.test(dir)) return null;
    targets.push(dir);
  }
  if (targets.length && prefix.includes(")")) return null;
  return targets;
}

// Bash コマンドから gh pr merge の PR 指定・リポジトリ指定・前段の cd を取り出す。呼び出しが無ければ null。
// PR 指定が無いとき pr は undefined（gh は現在のブランチの PR を対象にする）。
// cd は gh pr merge より前の段の cd の行き先（無ければ []、追えなければ null）。
export function parseMergeArgs(command) {
  const text = String(command);
  const m = text.match(MERGE_RE);
  if (!m) return null;
  const tokens = words(m[3]);
  let pr;
  let repo = words(m[2])
    .find((a) => a.startsWith("GH_REPO="))
    ?.slice("GH_REPO=".length)
    .replace(/^(["'])(.*)\1$/, "$2");
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("--repo=")) repo = t.slice("--repo=".length);
    else if (t === "-R" || t === "--repo") repo = tokens[++i];
    else if (VALUE_FLAGS.has(t)) i++;
    else if (!t.startsWith("-") && pr === undefined) pr = t;
  }
  return { pr, repo, cd: cdTargets(text.slice(0, m.index + m[1].length)) };
}

// gh pr merge の対象 PR を解決するために、gh をどのディレクトリで動かすか。
// PR を URL か --repo で指していれば cwd は対象に効かないので base のまま。
// cd を辿れない・行き先が無いときは null（別リポジトリの同じ番号の PR を見て止めるより、判定しない方がよい）。
export function resolveMergeCwd({ pr, repo, cd }, base, { platform = process.platform, home = homedir() } = {}) {
  if (repo || /^https?:\/\//.test(pr ?? "")) return base;
  if (cd === null) return null;
  let dir = base;
  for (const raw of cd) {
    let t = raw.replace(/^~(?=$|[\\/])/, home);
    // Bash ツールは Git Bash なので /c/... の形で来る
    if (platform === "win32") t = t.replace(/^\/([a-zA-Z])(?=$|\/)/, (_, d) => `${d.toUpperCase()}:/`);
    dir = resolve(dir, t);
  }
  try {
    return existsSync(dir) && statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

function gh(args, cwd) {
  return execFileSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// gh pr view で取るフィールド。statusCheckRollup は checks / statuses の読み取り権限を要し、
// workflow の GITHUB_TOKEN はそれを持たないので、CI を見ないときは取らない。
export function viewFields({ includeChecks = true } = {}) {
  return ["number", "url", "baseRefName", "headRefOid", ...(includeChecks ? ["statusCheckRollup"] : [])].join(",");
}

// GitHub から状態を取る。prArg は番号・URL・ブランチ名（gh pr view が受ける形）。
// repo も URL も無いとき、PR は cwd のリポジトリで解決される。
// 失敗は throw する（握り潰すかは呼び手が決める）。
export function fetchState(prArg, { repo, cwd, includeChecks = true } = {}) {
  const repoArgs = repo ? ["--repo", repo] : [];
  const view = JSON.parse(
    gh(["pr", "view", ...(prArg ? [String(prArg)] : []), ...repoArgs, "--json", viewFields({ includeChecks })], cwd)
  );
  const m = String(view.url).match(/\/([^/]+)\/([^/]+)\/pull\/\d+/);
  if (!m) throw new Error(`PR の URL を解釈できません: ${view.url}`);
  const [, owner, name] = m;

  // スレッドの解決状態は REST に無いため GraphQL で取る。
  const threadsQuery =
    "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}}}}";
  const threads = JSON.parse(
    gh(["api", "graphql", "-f", `query=${threadsQuery}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${view.number}`], cwd)
  );
  const nodes = threads?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];

  // mergeStateStatus の BEHIND はブランチ保護がある場合しか出ないため、compare で数える。
  // compare の応答は差分（files の patch）を丸ごと含み、大きい PR では execFileSync の maxBuffer を超えるので、
  // 要る数だけを --jq で抜く。
  const behindBy = gh(
    ["api", `repos/${owner}/${name}/compare/${view.baseRefName}...${view.headRefOid}`, "--jq", ".behind_by"],
    cwd
  );

  return {
    number: view.number,
    checks: view.statusCheckRollup ?? [],
    unresolvedThreads: nodes.filter((n) => n && n.isResolved === false).length,
    behindBy: Number(behindBy.trim() || 0),
  };
}

function main(argv) {
  const prArg = argv.find((a) => !a.startsWith("--"));
  const repoArg = argv.find((a) => a.startsWith("--repo="))?.slice("--repo=".length);
  const includeChecks = !argv.includes("--no-checks");
  const state = fetchState(prArg, { repo: repoArg, includeChecks });
  const problems = judge(state, { includeChecks });
  if (!problems.length) {
    console.log(`PR #${state.number}: マージを止める条件はありません`);
    return 0;
  }
  for (const line of describe(problems, state.number)) console.log(`::error::${line}`);
  return 1;
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
