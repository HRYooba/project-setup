// PreToolUse hook: PR 作成（gh pr create）前に code-review / security-review 済みかを
// 確認する関門。
//
// 2 つの入口:
//   - hook 実行（stdin に JSON）: gh pr create をブロック/許可する門番（下記仕様）。
//   - `--required` 照会（引数実行）: 現在の diff への推奨 effort を print して終了。
//     CLAUDE.md のワークフロー行がこの照会を案内し、レビューの effort 選びの目安にする。
//     （フラグ名は旧仕様＝必要 effort を強制していた頃の名残。互換のため維持）
//
// 仕様（すべて公式ドキュメントで裏取り済み）:
//   - settings.json 側で matcher "Bash" + if "Bash(gh pr create *)" により、
//     gh pr create のときだけこの hook が起動する（毎 Bash 起動の税を回避）。
//     if がサブコマンド単位で評価されれば `git push && gh pr create` も捕捉される
//     （これは Claude Code 側の仕様に依存する）。仮に if を素通りしても、下記
//     PR_CREATE_ATTEMPT_RE による入口判定が二重の防波堤になる。
//   - stdin(JSON) の transcript_path で会話ログを読み、「今回の PR 作業（＝直近の
//     "成功した" gh pr create 以降）で /code-review と /security-review が実行されたか」
//     を判定する。
//   - PR の diff にスクリプト/シェーダ等の "reviewable なコード" を含み、かつ
//     どちらかが未実行なら permissionDecision:"deny" で PR 作成をブロックする。
//     不足分は 1 回の deny にまとめて提示する（レビュー種別ごとに別 hook / 別 deny に
//     分けると「code-review を済ませて再試行 → 今度は security-review で deny」という
//     二段の差し戻しになり、1 往復で済む修正が 2 往復になるため）。
//   - security-review の要否判定は code-review と同一（lib/reviewable-files.mjs の
//     isReviewableFile が唯一の基準）。docs のみ等のセキュリティ的に無意味な差分は
//     コードレビュー同様に素通りする。判定を分けない理由: 「gate は要求するのに
//     対象基準が食い違う」政策の不一致を作らないため（lib 冒頭コメントと同じ思想）。
//
// 合否は「実行の有無」だけ。effort は強制しない（重要）:
//   以前は種別・規模から必要 effort を算出し、達成 effort の不足も deny していた。
//   しかしその方式は「指摘反映のコミットで diff が閾値を跨ぎ、前回の要求どおり
//   レビューしたのにより重い再レビューを要求される」自己増幅ループを生んだ
//   （レビュー済みコードの再レビューに価値は無い）。effort の算出は残すが、
//   deny 文言と --required 照会で「推奨」として示すだけにする。
//     推奨の算出: 種別 base（最大）＋ 変更行数 > 300 で +1 ＋ 対象ファイル数 > 10 で
//     +1、下限 high・上限 xhigh。基本は high、量が多ければ xhigh。max は「かなり重要な
//     とき」に人が手動指定するもので自動推奨はしない（規模から重要度は測れないため）。
//     ultra はクラウド手動の最上位で、同様に自動推奨しない。
//
// ループ回避（重要）:
//   合格判定の基準を「最後のコミット以降」ではなく「gh pr create 試行以降」に置く。
//   review → 指摘修正 → commit → PR というフローでは、修正がコミットを生むため
//   "コミットより後のレビュー" を要求すると永久にループする。コミットを一切見ず
//   PR 試行だけを基準にすることで、1 PR につきレビュー 1 回で収束する。
//
// 注意: hook は /code-review を「実行」できない（公式仕様）。ここでできるのは
//   ブロック＋差し戻しまで。実際のレビュー実行は Claude が行う。

import { readFileSync } from "node:fs";
import {
  EFFORT_RANK,
  PR_CREATE_ATTEMPT_RE,
  RANK_LABEL,
  detectBase,
  execTrim,
  expandRename,
  isReviewableFile,
  rankOf,
  readStdin,
} from "./lib/reviewable-files.mjs";
/* global process */

// 脱出口: Claude Code の更新で transcript 形式が変わると、この hook は
// fails-closed（未レビュー扱い→全 PR ブロック）に化ける。そのときは各自が
// 環境変数 CR_GATE_DISABLE=1 を設定すれば、コミット済みファイルを触らずに
// 一時的に無効化できる。修正版の配布後に解除すること。
if (process.env.CR_GATE_DISABLE === "1") process.exit(0);

// 推奨 effort 算出の閾値（合否には使わない）。
const LINES_BUMP = 300; // 変更行数（追加+削除）がこれを超えたら +1 ランク
const FILES_BUMP = 10; // レビュー対象ファイル数がこれを超えたら +1 ランク
const FLOOR_RANK = EFFORT_RANK.high; // 推奨 effort の下限（基本は high）
const CAP_RANK = EFFORT_RANK.xhigh; // 推奨 effort の上限（自動は xhigh 止まり。max/ultra は手動）

// gh pr create「試行」の検出は lib の PR_CREATE_ATTEMPT_RE を共有（after-pr-create.mjs と
// 同一定義。二重定義すると片方だけ拡張して gate と Copilot の判定が食い違うため）。

function allow() {
  // 何も出力せず exit 0 = 通常許可
  process.exit(0);
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
}

// git をシェル非経由（execFile 方式）で実行。失敗時は null。
function git(cwd, args) {
  return execTrim("git", ["-C", cwd, ...args]);
}

// detectBase / expandRename は lib/reviewable-files.mjs から import（security-review-nudge.mjs と
// 走査範囲・rename 展開を共有する。二重定義すると片方だけ直して判定が食い違うため）。

// PR の変更ファイル一覧と変更行数（追加+削除）を 1 回の git diff --numstat で取得。
// 行数はレビュー対象ファイル（rankOf が定義されるもの）だけを数える。対象外
// （ベンダー・ドキュメント等）の大量変更が推奨 effort を膨らませないため。
// 判定不能な値は null（呼び出し側で fail-safe＝要レビュー）。
// テスト用に CR_GATE_FILES(改行区切り) / CR_GATE_LINES で差し替え可能。
function changedStats(cwd, base) {
  const envFiles =
    process.env.CR_GATE_FILES !== undefined
      ? process.env.CR_GATE_FILES.split(/\r?\n/).filter(Boolean)
      : undefined;
  const envLines =
    process.env.CR_GATE_LINES !== undefined
      ? (() => {
          const n = parseInt(process.env.CR_GATE_LINES, 10);
          return Number.isNaN(n) ? null : n;
        })()
      : undefined;
  if (envFiles !== undefined && envLines !== undefined) {
    return { files: envFiles, lines: envLines };
  }
  let diffFiles = null;
  let diffLines = null;
  if (base) {
    const out = git(cwd, ["diff", "--numstat", `${base}...HEAD`]);
    if (out !== null) {
      diffFiles = [];
      diffLines = 0;
      for (const line of out.split(/\r?\n/)) {
        if (!line) continue;
        const parts = line.split("\t");
        const [add, del] = parts;
        const path = expandRename(parts.slice(2).join("\t")); // パスに tab を含む極端なケースへの保険
        if (path) diffFiles.push(path);
        if (add === "-" || del === "-") continue; // バイナリは行数計上しない
        if (!isReviewableFile(path)) continue; // レビュー対象外は行数計上しない
        diffLines += (parseInt(add, 10) || 0) + (parseInt(del, 10) || 0);
      }
    }
  }
  return {
    files: envFiles !== undefined ? envFiles : diffFiles,
    lines: envLines !== undefined ? envLines : diffLines,
  };
}

// files を rankOf で 1 回だけ走査し、判定に必要な指標をまとめて返す。
// 旧実装は hasScriptChange / baseRankFromFiles / reviewableFileCount / note 生成で
// 同一リストを最大 4 回走査していた（rankOf は正規化＋正規表現を伴う）ため 1 パスに集約。
//   files === null（判定不能）: 安全側（要レビュー・base=max・fileCount=null）。
//   files === []（異常系）    : 要レビュー・base=high・fileCount=0（fail-closed）。
function summarize(files) {
  if (files === null) {
    return { hasScript: true, fileCount: null, baseRank: EFFORT_RANK.max };
  }
  const ranks = [];
  for (const f of files) {
    const r = rankOf(f);
    if (r !== undefined) ranks.push(r);
  }
  return {
    // 空配列（ベース==HEAD・既マージ済みブランチ指定・未コミット等）は素通りさせず要レビュー。
    hasScript: files.length === 0 ? true : ranks.length > 0,
    fileCount: ranks.length,
    baseRank: ranks.length ? Math.max(...ranks) : EFFORT_RANK.high,
  };
}

// 種別 base に規模の加算を足し、[FLOOR_RANK, CAP_RANK] にクランプして推奨 effort を算出。
//   base(種別) + (行数 > 300 で +1) + (対象ファイル数 > 10 で +1)
// 行数・ファイル数が判定不能（null）なら安全側で加算する。
function recommendedRank(summary, lines) {
  let rank = summary.baseRank;
  if (lines === null || lines > LINES_BUMP) rank += 1;
  if (summary.fileCount === null || summary.fileCount > FILES_BUMP) rank += 1;
  return Math.min(CAP_RANK, Math.max(FLOOR_RANK, rank));
}

// 推奨 effort ラベルとその根拠ノート。deny 文言と --required 照会の両経路が使う
// 唯一の実装（二重実装すると片方だけ直して文言が乖離するため、ここに集約する）。
function recommendation(summary, lines) {
  const reco = RANK_LABEL[recommendedRank(summary, lines)];
  const note =
    lines === null || summary.fileCount === null
      ? "変更規模を判定できなかったため安全側"
      : `種別 base: ${RANK_LABEL[summary.baseRank]} / 変更 ${lines} 行 / 対象 ${summary.fileCount} ファイル`;
  return { reco, note };
}

// tool_result の本文をテキスト化（string / ブロック配列の両形式に対応）。
function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c.text === "string" ? c.text : "")).join("\n");
  }
  return "";
}

// 検出するレビュー種別。key は戻り値のフラグ名。
//   skillRe: Skill ツールの skill 名 / slashRe: SlashCommand の command /
//   typedRe: ユーザー手打ち（content が文字列の user メッセージ）。
// 判定は「スキル名 / コマンド名そのものがレビューコマンドであること」に限定する。
// input 全体や引数文字列に名前が含まれるだけの別コマンド（例: /create-issue
// "code-review の max 対応"）を拾って幻のレビュー実績を作ってしまわないため。
//
// typedRe は `<command-name>` タグを本文中で捕捉する（行頭固定にしない）。理由:
// 新しめの Claude Code は手打ちコマンドの content 先頭へ `<command-message>…</command-message>`
// を前置きするようになり（実測: `<command-message>code-review</command-message>\n
// <command-name>/code-review</command-name>\n<command-args>max</command-args>`）、
// `^\s*<command-name>` 固定だとマッチせず、手打ちレビューを取りこぼして deny し続けた
// （＝「レビュー後 HEAD が動く→再レビュー」に見えるループの正体）。タグ全体
// （`<command-name>…</command-name>`）で一致させるので引数や別コマンドの誤ヒットは起きない。
const REVIEW_KINDS = [
  {
    key: "codeReview",
    skillRe: /(^|[:/])code-?review$/i,
    slashRe: /^\s*\/?code-?review(\s|$)/i,
    typedRe: /<command-name>\s*\/?code-?review\s*<\/command-name>/i,
  },
  {
    key: "securityReview",
    skillRe: /(^|[:/])security-review$/i,
    slashRe: /^\s*\/?security-review(\s|$)/i,
    typedRe: /<command-name>\s*\/?security-review\s*<\/command-name>/i,
  },
];

// transcript を走査し「今回の PR 作業で各レビューが完了しているか」をレビュー種別ごとの
// フラグ（{ codeReview, securityReview }）で返す。
// 読めなければ全 false（安全側＝未レビュー扱い）。
//
// anchor（今回の PR 作業の起点）の決め方:
//   gh pr create の試行を tool_result と突き合わせ、「成功した試行」（結果に PR URL が
//   ある）だけを PR の区切りとして扱う。末尾に連なる失敗試行（deny・エラー・中断）は
//   同一 PR のリトライなので除外し、直近の成功試行を anchor とする。
//   こうする理由: 以前は「末尾の試行のコマンドが今回と完全一致したら除外」だったが、
//   `gh pr create --fill` のような PR 固有の引数を持たないコマンドは別 PR 間で
//   衝突し、前の PR の成功試行を誤除外 → 前の PR のレビューを流用してしまう。
//   成功/失敗で判別すれば、コマンド文字列に依存せず「PR が実際に作られたか」で
//   区切れる。in-flight の今回の試行は PreToolUse 時点で transcript に無い（実測）が、
//   将来載るようになっても結果が無い＝失敗扱いで除外されるため壊れない。
//
// レビューのカウント条件:
//   Skill / SlashCommand 経由のレビューは、対応する tool_result が存在し
//   is_error でないものだけを数える（ESC 中断・起動失敗を合格扱いしない）。
//   手打ち /code-review（content が文字列の user メッセージ）もカウントする。
function reviewsSincePrCreate(transcriptPath) {
  const done = Object.fromEntries(REVIEW_KINDS.map((k) => [k.key, false]));
  let lines;
  try {
    lines = readFileSync(transcriptPath, "utf8").split(/\r?\n/);
  } catch {
    return done;
  }
  const attempts = []; // { idx, id } — gh pr create 試行（deny された過去の試行も残る）
  const reviews = []; // { idx, id, kind } — レビューイベント（手打ちは id: null）
  const results = new Map(); // tool_use_id → { error, text }
  lines.forEach((line, idx) => {
    if (!line) return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    const content = obj?.message?.content;
    // 手打ちの /code-review・/security-review の検出。ユーザーが直接スラッシュコマンドを
    // 打った場合、transcript には tool_use ではなく「content が文字列の user メッセージ」
    // （新しめの版では先頭に <command-message> が前置きされる:
    //  <command-message>code-review</command-message> <command-name>/code-review</command-name>
    //  ... <command-args>max</command-args>）として残る。typedRe はタグを本文中で捕捉する
    // ので前置きの有無に依存しない。これを見逃すと手打ちレビュー済みでも deny し続ける。
    if (obj?.message?.role === "user" && typeof content === "string") {
      const typed = REVIEW_KINDS.find((k) => k.typedRe.test(content));
      if (typed) {
        reviews.push({ idx, id: null, kind: typed.key });
        return;
      }
    }
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block) continue;
      // tool_result を収集（試行の成否・レビュー起動の完了確認に使う）
      if (block.type === "tool_result" && block.tool_use_id) {
        results.set(block.tool_use_id, {
          error: block.is_error === true,
          text: resultText(block.content),
        });
        continue;
      }
      if (block.type !== "tool_use") continue;
      const name = block.name;
      const input = block.input || {};
      // gh pr create 試行の検出
      if (
        name === "Bash" &&
        typeof input.command === "string" &&
        PR_CREATE_ATTEMPT_RE.test(input.command)
      ) {
        attempts.push({ idx, id: block.id, command: input.command });
      }
      // レビューの検出（Skill 実行 or SlashCommand）。名前限定の理由は REVIEW_KINDS を参照。
      const kind = REVIEW_KINDS.find(
        (k) =>
          (name === "Skill" && k.skillRe.test(String(input.skill || "").trim())) ||
          (name === "SlashCommand" && k.slashRe.test(String(input.command || "")))
      );
      if (kind) {
        reviews.push({ idx, id: block.id || null, kind: kind.key });
      }
    }
  });
  // 成功した試行 = エラーでなく、かつ「結果に PR URL（/pull/<番号>）がある」または
  // 「--web / -w 指定」。--web はブラウザで開くだけで stdout に /pull/ URL を出さないため、
  // URL の有無だけで判定すると成功試行を失敗リトライと誤認し、前 PR のレビューを次 PR へ
  // 流用してしまう（fail-open）。
  const WEB_FLAG_RE = /(?:^|\s)(?:--web|-w)\b/;
  const succeeded = (a) => {
    const r = results.get(a.id);
    if (!r || r.error) return false;
    return /\/pull\/\d+/.test(r.text) || WEB_FLAG_RE.test(a.command || "");
  };
  attempts.sort((a, b) => a.idx - b.idx);
  // 末尾に連なる失敗試行（同一 PR のリトライ・in-flight）を除外し、
  // 直近の成功試行を anchor にする。成功が無ければ anchor 無し（セッション全体）。
  while (attempts.length && !succeeded(attempts[attempts.length - 1])) attempts.pop();
  const anchor = attempts.length ? attempts[attempts.length - 1].idx : -1;
  // anchor 以降に「完了した」レビューがあれば、その種別を合格にする。
  for (const r of reviews) {
    if (r.idx <= anchor) continue;
    if (r.id !== null) {
      const res = results.get(r.id);
      if (!res || res.error) continue; // 中断・起動失敗は数えない
    }
    done[r.kind] = true;
  }
  return done;
}

// ---- 照会モード: node pr-code-review-gate.mjs --required [--base <branch>] ----
// 現在の diff への推奨 effort を print する（合否には影響しない）。算出は deny 文言と
// 完全に同一パス（detectBase/changedStats/recommendedRank）。
// --base は gh pr create と同じ書式のまま detectBase が拾うので、引数をそのまま渡す。
// 前提: diff はコミット済みであること（gate と同じ base...HEAD の three-dot diff を見る。
// 未コミットの作業ツリーは含まれない）。
if (process.argv.includes("--required")) {
  const cwd = process.cwd();
  const base = detectBase(cwd, process.argv.slice(2).join(" "));
  const { files, lines } = changedStats(cwd, base);
  const summary = summarize(files);
  if (!summary.hasScript) {
    process.stdout.write("none: レビュー対象のコード変更なし。/code-review は不要です。\n");
    process.exit(0);
  }
  const { reco, note } = recommendation(summary, lines);
  process.stdout.write(
    `${reco}: 推奨 effort は ${reco}（${note}）。/code-review ${reco} を実行してください。\n`
  );
  process.exit(0);
}

const raw = (await readStdin()).replace(/^\uFEFF/, ""); // 先頭 BOM を除去
let data = {};
try {
  data = JSON.parse(raw);
} catch {
  allow(); // 入力を解釈できないときは邪魔しない
}

const command = data?.tool_input?.command || "";
if (!PR_CREATE_ATTEMPT_RE.test(command)) allow(); // gh pr create 以外は無関係

// レビュー済み判定を先に行う（全レビュー済みなら通すので、その場合 git を一切叩かない）。
// 不足がある初回 gh pr create でだけ detectBase / git diff の spawn を払う。
const transcriptPath = data?.transcript_path || "";
const reviews = transcriptPath
  ? reviewsSincePrCreate(transcriptPath)
  : Object.fromEntries(REVIEW_KINDS.map((k) => [k.key, false])); // path 不明は安全側＝未実行扱い
if (reviews.codeReview && reviews.securityReview) allow(); // 両レビュー済みなら通す

const cwd = data?.cwd || process.cwd();
const base = detectBase(cwd, command);
const { files, lines } = changedStats(cwd, base);
const summary = summarize(files);
if (!summary.hasScript) allow(); // レビュー対象コードを含まない PR は素通り

// 不足レビューをまとめて 1 回で差し戻す（code-review には推奨 effort を添える）。
const missing = [];
if (!reviews.codeReview) {
  const { reco, note } = recommendation(summary, lines);
  missing.push(`\`/code-review ${reco}\`（推奨 effort: ${reco}。${note}）`);
}
if (!reviews.securityReview) {
  missing.push("`/security-review`（セキュリティレビュー。引数なし）");
}

deny(
  `この PR にはレビュー対象のコード変更（.cs/.ts/shader やスクリプト等）が含まれますが、` +
    `今回の PR 作業で次のレビューが実行されていません: ${missing.join(" と ")}。` +
    `不足分をすべて実行し、指摘に対応してから PR 作成を再実行してください。`
);
