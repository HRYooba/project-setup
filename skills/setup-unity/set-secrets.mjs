// Unity ライセンスの GitHub secret を登録する対話スクリプト。
//
// **独立したコンソールで動かす前提**。Claude Code の中（`!` 実行）では動かさない。
// `!` の出力は会話へ入るため、入力した値がそのまま会話に残る。別ウィンドウなら子プロセスの
// 画面が親の stdout に流れないので、値が会話へ入る経路が構造的に無い。
//
// 値は stdin で gh へ渡す。`--body` は argv に載り、プロセス一覧とシェル履歴に残る。
//
// 使い方: node set-secrets.mjs [repo-dir] [--result <path>]
//         (repo-dir 省略時は cwd)
//
// 依存なし（Node 標準のみ）。

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
/* global process, console */

const args = process.argv.slice(2);
let repoDir = process.cwd();
let resultPath = join(tmpdir(), "unity-secrets-result.json");
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--result") resultPath = args[++i];
  else repoDir = args[i];
}

// 結果だけを書く。**値は書かない** — 呼び出し元（Claude）がこのファイルを読む。
function finish(status, detail, set = []) {
  try {
    writeFileSync(resultPath, JSON.stringify({ status, detail, set }, null, 2) + "\n", "utf8");
  } catch (e) {
    console.log(`結果ファイルを書けませんでした: ${e.message}`);
  }
  console.log("");
  console.log(status === "ok" ? "完了しました。3秒後閉じます。" : `終了: ${detail}`);
  // 閉じる前に読む時間を残す（このウィンドウは自分で閉じる）。
  // ビジーループにしないよう Atomics.wait で止める。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
  process.exit(status === "ok" ? 0 : 1);
}

function gh(argv, input) {
  const res = spawnSync("gh", argv, { cwd: repoDir, encoding: "utf8", input, timeout: 60000 });
  if (res.error) return { ok: false, message: res.error.code === "ENOENT" ? "gh コマンドがありません" : res.error.message };
  if (res.status !== 0) return { ok: false, message: (res.stderr || res.stdout || "").trim() };
  return { ok: true, stdout: res.stdout ?? "" };
}

// 入力はマスクしない。伏せて守れるのは「今この画面を覗いている人」だけで、代わりに
// 打ち間違いを目視できなくなる。誤った値は CI のライセンス認証まで露見せず、追跡が遠い。
// このウィンドウの内容は親プロセス（Claude）へ渡らないので、伏せる利得はさらに薄い。
function ask(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.on("SIGINT", () => {
      rl.close();
      finish("cancelled", "Ctrl+C で中断されました");
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// 対話できない環境（stdin がパイプ・リダイレクト）で起動されると、readline が即 EOF を返して
// 全項目が空になる。それを「ユーザーが中断した」と報告すると、起動方法の誤りが中断に化ける。
if (!process.stdin.isTTY) {
  finish("error", "対話入力ができません（stdin が TTY ではない）。独立したコンソールで起動してください");
}

console.log("Unity ライセンスの secret を登録します（GitHub Actions の test ジョブが使います）");
console.log("入力した値はこのウィンドウの外へ出ません。Claude 側には登録した secret 名だけが渡ります。");
console.log("");

const auth = gh(["auth", "status"]);
if (!auth.ok) finish("error", `gh が使えません: ${auth.message}`);

const repo = gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
if (!repo.ok) finish("error", `対象リポジトリを特定できません: ${repo.message}`);
const nameWithOwner = repo.stdout.trim();
console.log(`対象リポジトリ: ${nameWithOwner}`);
console.log("");

const email = await ask("Unity アカウントのメールアドレス: ");
if (!email) finish("cancelled", "メールアドレスが空でした");

const password = await ask("パスワード: ");
if (!password) finish("cancelled", "パスワードが空でした");

const serial = await ask("シリアル（不要なら Enter）: ");

const targets = [
  ["UNITY_EMAIL", email],
  ["UNITY_PASSWORD", password],
];
if (serial) targets.push(["UNITY_SERIAL", serial]);

console.log("");
const set = [];
for (const [name, value] of targets) {
  // 値は stdin。argv に載せない。
  const res = gh(["secret", "set", name, "--repo", nameWithOwner, "--app", "actions"], value);
  if (!res.ok) finish("error", `${name} の登録に失敗しました: ${res.message}`, set);
  set.push(name);
  console.log(`  登録: ${name}`);
}

// 裏取り。gh secret list は名前と更新日時だけを返す（値は返らない）。
const list = gh(["secret", "list", "--repo", nameWithOwner, "--app", "actions"]);
if (list.ok) {
  const missing = set.filter((n) => !list.stdout.includes(n));
  if (missing.length) finish("error", `登録後の確認で見つかりませんでした: ${missing.join(", ")}`, set);
}

finish("ok", `${set.length} 件を登録しました`, set);
