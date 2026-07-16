// PreToolUse hook: PR 作成（gh pr create）前に code-review 済みかを確認する関門。
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
//     "成功した" gh pr create 以降）で /code-review が実行されたか」を判定する。
//   - PR の diff にスクリプト/シェーダ等の "reviewable なコード" を含み、かつ
//     未レビューなら permissionDecision:"deny" で PR 作成をブロックする。
//
// 合否は「実行の有無」だけ。effort は強制しない（重要）:
//   以前は種別・規模から必要 effort を算出し、達成 effort の不足も deny していた。
//   しかしその方式は「指摘反映のコミットで diff が閾値を跨ぎ、前回の要求どおり
//   レビューしたのにより重い再レビューを要求される」自己増幅ループを生んだ
//   （レビュー済みコードの再レビューに価値は無い）。effort の算出は残すが、
//   deny 文言と --required 照会で「推奨」として示すだけにする。
//     推奨の算出: 種別 base（最大）＋ 変更行数 > 300 で +1 ＋ 対象ファイル数 > 10 で
//     +1、下限 medium・上限 max（ultra はクラウド手動なので自動推奨しない）。
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
  execTrim,
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
const FLOOR_RANK = EFFORT_RANK.medium; // 推奨 effort の下限
const CAP_RANK = EFFORT_RANK.max; // 推奨 effort の上限（ultra は自動推奨しない）

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

// diff のベースを検出。優先順:
//   1. gh pr create の --base / -B フラグ（PR が default 以外を向くケースに対応）
//   2. origin/HEAD（デフォルトブランチ）
//   3. origin/main / origin/master / main / master へのフォールバック
// 取れなければ null（呼び出し側で fail-safe＝要レビュー）。
//
// クォート除去: --title/--body の本文に "…--base develop…" と書かれた文字列を base
// フラグと誤認しないよう、"..." / '...' の中身を除いてから走査する。副作用として
// `--base "develop"` のようにクォート付きで渡した base 値は拾えず origin/HEAD 等へ
// フォールバックするが、これは安全側（大半の PR は default ブランチ向き）。
//
// ref 照会は for-each-ref 1 回で ref 名の集合を作り membership 判定する（旧実装の
// rev-parse 逐次 spawn 最大 4 回を回避）。集合は必要になったときだけ 1 度だけ引く。
function detectBase(cwd, command) {
  const unquoted = String(command || "")
    .replace(/"[^"]*"/g, " ")
    .replace(/'[^']*'/g, " ");
  let refs = null;
  const knownRefs = () => {
    if (refs === null) {
      const out = git(cwd, [
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/remotes/origin",
        "refs/heads",
      ]);
      refs = new Set(out ? out.split(/\r?\n/).filter(Boolean) : []);
    }
    return refs;
  };
  const m = unquoted.match(/(?:--base|-B)[=\s]+([^\s"']+)/);
  if (m) {
    for (const cand of [`origin/${m[1]}`, m[1]]) {
      if (knownRefs().has(cand)) return cand;
    }
  }
  const head = git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]); // 例: origin/main
  if (head) return head;
  for (const b of ["origin/main", "origin/master", "main", "master"]) {
    if (knownRefs().has(b)) return b;
  }
  return null;
}

// numstat の rename 表記を新パスへ展開する。rename 検出は git デフォルトで有効なため、
// リネームは "src/{old.ts => new.ts}"（共通部分あり）や "old.ts => new.ts"（共通部分なし）
// の形で出力される。展開しないと末尾が "}" になり拡張子判定が外れる
// （.ts のリネームが medium 扱い / リネームのみの docs PR が「コードあり」と誤判定）。
// --no-renames 案は不採用: 純リネームの全行が追加+削除として計上され、リネーム主体の
// リファクタ PR で推奨 effort が不当に跳ね上がるため。
function expandRename(path) {
  if (!path.includes(" => ")) return path;
  let p = path.replace(/\{([^{}]*) => ([^{}]*)\}/g, "$2").replace(/\/{2,}/g, "/");
  const i = p.indexOf(" => "); // ブレース無し形式（パス全体のリネーム）
  if (i !== -1) p = p.slice(i + 4);
  return p;
}

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

// transcript を走査し「今回の PR 作業で /code-review が完了しているか」を返す。
// 読めなければ false（安全側＝未レビュー扱い）。
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
function hasReviewSincePrCreate(transcriptPath) {
  let lines;
  try {
    lines = readFileSync(transcriptPath, "utf8").split(/\r?\n/);
  } catch {
    return false;
  }
  const attempts = []; // { idx, id } — gh pr create 試行（deny された過去の試行も残る）
  const reviews = []; // { idx, id } — code-review イベント（手打ちは id: null）
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
    // 手打ちの /code-review の検出。ユーザーが直接スラッシュコマンドを打った場合、
    // transcript には tool_use ではなく「content が文字列の user メッセージ」
    // （<command-name>/code-review</command-name> ... <command-args>max</command-args>）
    // として残る。これを見逃すと、手打ちレビュー済みでも未レビュー扱いで deny し続ける。
    if (
      obj?.message?.role === "user" &&
      typeof content === "string" &&
      /^\s*<command-name>\/?code-?review\b/i.test(content)
    ) {
      reviews.push({ idx, id: null });
      return;
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
      // code-review の検出（Skill 実行 or SlashCommand）。
      // 判定は「スキル名 / コマンド名そのものが code-review であること」に限定する。
      // input 全体や引数文字列に "code-review" が含まれるだけの別コマンド
      // （例: /create-issue "code-review の max 対応"）を拾って幻のレビュー実績を
      // 作ってしまわないため。
      if (
        (name === "Skill" && /(^|[:/])code-?review$/i.test(String(input.skill || "").trim())) ||
        (name === "SlashCommand" && /^\s*\/?code-?review(\s|$)/i.test(String(input.command || "")))
      ) {
        reviews.push({ idx, id: block.id || null });
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
  // anchor 以降に「完了した」レビューが 1 つでもあれば合格。
  return reviews.some((r) => {
    if (r.idx <= anchor) return false;
    if (r.id !== null) {
      const res = results.get(r.id);
      if (!res || res.error) return false; // 中断・起動失敗は数えない
    }
    return true;
  });
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

// レビュー済み判定を先に行う（レビュー済みなら通すので、その場合 git を一切叩かない）。
// 未レビューの初回 gh pr create でだけ detectBase / git diff の spawn を払う。
const transcriptPath = data?.transcript_path || "";
if (transcriptPath && hasReviewSincePrCreate(transcriptPath)) allow(); // レビュー済みなら通す

const cwd = data?.cwd || process.cwd();
const base = detectBase(cwd, command);
const { files, lines } = changedStats(cwd, base);
const summary = summarize(files);
if (!summary.hasScript) allow(); // レビュー対象コードを含まない PR は素通り

// 未レビュー: 推奨 effort（種別 base ＋ 規模の加算）を添えて差し戻す。
const { reco, note } = recommendation(summary, lines);

deny(
  `この PR にはレビュー対象のコード変更（.cs/.ts/shader やスクリプト等）が含まれますが、今回の PR 作業で /code-review が実行されていません。` +
    `\`/code-review ${reco}\` を実行し（推奨 effort: ${reco}。${note}）、指摘に対応してから PR 作成を再実行してください。`
);
