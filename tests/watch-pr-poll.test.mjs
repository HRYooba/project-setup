// watch-pr の監視スクリプト（poll-pr.sh）の判定。gh を偽物へ差し替え、最終行を確かめる。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { PLUGIN_ROOT, tempDir } from "./helpers.mjs";
/* global process */

const POLL = join(PLUGIN_ROOT, "skills", "setup-github", "templates", "pr-copilot", "skills", "watch-pr", "poll-pr.sh");

// checks: 呼ばれるたびに 1 つずつ消費する `gh pr checks` の応答列（尽きたら最後を繰り返す）。
// reviews / comments: `gh api` の --jq 結果としてそのまま返す件数。
function fakeGh({ checks, reviews = 0, comments = 0 }) {
  const dir = tempDir("fake-gh-");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const seq = checks.map((c, i) => `${i}) out='${c.out}'; code=${c.code} ;;`).join("\n    ");
  const last = checks.length - 1;
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bash
if [ "$1" = "api" ]; then
  case "$2" in
    */reviews) echo ${reviews} ;;
    *) echo ${comments} ;;
  esac
  exit 0
fi
n=$(cat "${dir.replace(/\\/g, "/")}/n" 2>/dev/null || echo 0)
echo $((n + 1)) > "${dir.replace(/\\/g, "/")}/n"
[ "$n" -gt ${last} ] && n=${last}
case $n in
    ${seq}
esac
echo "$out"
exit $code
`,
    { mode: 0o755 }
  );
  return bin;
}

function poll(bin, phase, attempt = 1) {
  const r = spawnSync("bash", [POLL, "o", "r", "1", phase, "2000-01-01T00:00:00Z", String(attempt)], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, POLL_INTERVAL_SEC: "0" },
  });
  const lines = r.stdout.trim().split(/\r?\n/);
  return { status: r.status, last: lines[lines.length - 1] };
}

const PASS = { out: "ok", code: 0 };
const PENDING = { out: "pending", code: 8 };
const FAIL = { out: "X build", code: 1 };
const NONE = { out: "no checks reported on the 'x' branch", code: 1 };

test("review: レビュー指摘あり + CI 失敗で RESULT", () => {
  const r = poll(fakeGh({ checks: [FAIL], reviews: 1, comments: 2 }), "review");
  assert.equal(r.last, "RESULT|pr=1|phase=review|review=detected|checks=fail");
});

test("review: チェックが無ければ即 none と確定する", () => {
  const r = poll(fakeGh({ checks: [NONE], reviews: 1 }), "review");
  assert.equal(r.last, "RESULT|pr=1|phase=review|review=no_comments|checks=none");
});

test("review: レビュー未着のまま 12 回で CONTINUE、5 回目で TIMEOUT", () => {
  const bin = fakeGh({ checks: [PASS] });
  assert.equal(poll(bin, "review", 1).last, "CONTINUE|pr=1|phase=review|review=none|checks=pass|next_attempt=2");
  assert.equal(poll(bin, "review", 5).last, "TIMEOUT|pr=1|phase=review|review=none|checks=pass");
});

test("ci: レビューを待たずに CI の結果だけで RESULT", () => {
  assert.equal(poll(fakeGh({ checks: [PENDING, PASS] }), "ci").last, "RESULT|pr=1|phase=ci|review=skip|checks=pass");
  assert.equal(poll(fakeGh({ checks: [PENDING, FAIL] }), "ci").last, "RESULT|pr=1|phase=ci|review=skip|checks=fail");
});

test("ci: push 直後のチェックなしは猶予中 pending として待ち、登録された check を拾う", () => {
  const r = poll(fakeGh({ checks: [NONE, NONE, NONE, PENDING, FAIL] }), "ci");
  assert.equal(r.last, "RESULT|pr=1|phase=ci|review=skip|checks=fail");
});

test("ci: 猶予を過ぎてもチェックが無ければ none", () => {
  const r = poll(fakeGh({ checks: [NONE] }), "ci");
  assert.equal(r.last, "RESULT|pr=1|phase=ci|review=skip|checks=none");
});

test("ci: CI が終わらなければ TIMEOUT に pending が残る", () => {
  const r = poll(fakeGh({ checks: [PENDING] }), "ci", 5);
  assert.equal(r.last, "TIMEOUT|pr=1|phase=ci|review=skip|checks=pending");
});

test("不明な phase は exit 2", () => {
  assert.equal(poll(fakeGh({ checks: [PASS] }), "both").status, 2);
});
