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
import { realpathSync } from "node:fs";
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
const MERGE_RE =
  /(?:^|[;|&\n(])\s*(?:\w+=(?:"[^"]*"|'[^']*'|\S*)\s+)*(?:command\s+)?(?:\S*\/)?gh\s+pr\s+merge\b([^;|&\n)]*)/;

// 値を取るフラグ。直後の語を PR 指定と取り違えないために要る。
const VALUE_FLAGS = new Set([
  "-R", "--repo", "-t", "--subject", "-b", "--body", "-F", "--body-file",
  "-A", "--author-email", "--match-head-commit",
]);

// Bash コマンドから gh pr merge の PR 指定とリポジトリ指定を取り出す。呼び出しが無ければ null。
// PR 指定が無いとき pr は undefined（gh は現在のブランチの PR を対象にする）。
export function parseMergeArgs(command) {
  const m = String(command).match(MERGE_RE);
  if (!m) return null;
  const tokens = (m[1].match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^(["'])(.*)\1$/, "$2"));
  let pr;
  let repo;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("--repo=")) repo = t.slice("--repo=".length);
    else if (t === "-R" || t === "--repo") repo = tokens[++i];
    else if (VALUE_FLAGS.has(t)) i++;
    else if (!t.startsWith("-") && pr === undefined) pr = t;
  }
  return { pr, repo };
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// gh pr view で取るフィールド。statusCheckRollup は checks / statuses の読み取り権限を要し、
// workflow の GITHUB_TOKEN はそれを持たないので、CI を見ないときは取らない。
export function viewFields({ includeChecks = true } = {}) {
  return ["number", "url", "baseRefName", "headRefOid", ...(includeChecks ? ["statusCheckRollup"] : [])].join(",");
}

// GitHub から状態を取る。prArg は番号・URL・ブランチ名（gh pr view が受ける形）。
// 失敗は throw する（握り潰すかは呼び手が決める）。
export function fetchState(prArg, { repo, includeChecks = true } = {}) {
  const repoArgs = repo ? ["--repo", repo] : [];
  const view = JSON.parse(
    gh(["pr", "view", ...(prArg ? [String(prArg)] : []), ...repoArgs, "--json", viewFields({ includeChecks })])
  );
  const m = String(view.url).match(/\/([^/]+)\/([^/]+)\/pull\/\d+/);
  if (!m) throw new Error(`PR の URL を解釈できません: ${view.url}`);
  const [, owner, name] = m;

  // スレッドの解決状態は REST に無いため GraphQL で取る。
  const threadsQuery =
    "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}}}}";
  const threads = JSON.parse(
    gh(["api", "graphql", "-f", `query=${threadsQuery}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${view.number}`])
  );
  const nodes = threads?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];

  // mergeStateStatus の BEHIND はブランチ保護がある場合しか出ないため、compare で数える。
  const compare = JSON.parse(gh(["api", `repos/${owner}/${name}/compare/${view.baseRefName}...${view.headRefOid}`]));

  return {
    number: view.number,
    checks: view.statusCheckRollup ?? [],
    unresolvedThreads: nodes.filter((n) => n && n.isResolved === false).length,
    behindBy: Number(compare?.behind_by ?? 0),
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
