---
name: watch-pr
description: >
  PR の非同期の結果（Copilot レビュー・CI）を Monitor で監視し、結論まで出す。
  引数が PR 番号だけのときは **after-pr-create hook が起動を指示したときだけ**起動する。
  指示が無い PR は Copilot のレビュー対象外（コード変更なし等）なので自発的に起動しない —
  起動すると 30 分の空監視になる。この形は 1 PR につき 1 回のみ。レビューと CI が出揃ってから
  指摘または CI の失敗があれば resolve-pr を起動し、その push で回り直した CI も監視して
  pass / fail / timeout を報告する。watch-pr の外で resolve-pr が push したときは
  `{PR番号} ci` で起動し、回り直した CI だけを監視する。
version: 1.10.0
argument-hint: "[PR番号 or URL] [ci]"
---

# PR のレビュー・CI 監視

**PR指定**: $ARGUMENTS

## 何を待つか

PR 作成後に外から返ってくる非同期の結果は 2 系統ある。**両方が出揃うまで待ってから**
1 度だけ resolve-pr へ渡す。片方で抜けると、残る片方のためにもう一度監視を張ることになる。

| 系統 | 出所 | 完了の判定 |
|:---|:---|:---|
| Copilot のレビュー | `pulls/{pr}/reviews` | 監視開始後のレビューが 1 件でも付いた |
| CI チェック | `gh pr checks` | pending が 1 つも無くなった |

resolve-pr が push すると CI だけが回り直す。**その結果もこのスキルが見て結論を出す**（Step 3）。
CI の結果をユーザーの確認に委ねて終わらない。

## 制約

- **Copilot レビューの監視は 1 PR につき 1 回のみ。** Copilot は 1 PR に 1 回しか自動レビュー
  しないため、2 回目を待っても何も来ない。Step 3 は CI だけを見て、レビューは見ない
- **CI 修正の再試行は 1 回まで。** CI 失敗で resolve-pr を起動するのは、最初の決着とは別に
  1 回だけ。それでも落ちたら失敗内容を報告して止まる（直せない失敗を push で回し続けない）
- 引数が PR 番号だけの起動は after-pr-create hook の指示による。指示が無い PR は
  Copilot レビュー対象外（コード変更なし等）なので自発的に起動しない
- 引数に `ci` が付いた起動は、watch-pr の外で resolve-pr が push した後に使う。
  **Step 3 から始める**（Step 1・2 は通らない）

## 監視スクリプト

監視の 1 回分は、このスキルの base directory 直下の `poll-pr.sh` が行う。Step 2 と Step 3 が共用する。

```
Monitor(
  description: "PR #{pr} {phase} 監視 ({attempt}/5)",
  timeout_ms: 420000,
  command: bash "<このスキルの base directory>/poll-pr.sh" {owner} {repo} {pr} {phase} {start_time} {attempt}
)
```

| 引数 | 値 |
|:---|:---|
| `{phase}` | `review` = レビューと CI の両方を待つ（Step 2）/ `ci` = CI だけを待つ（Step 3） |
| `{start_time}` | Step 1 で記録した時刻。`ci` ではレビューを見ないので、その監視を始めた時刻を入れる |
| `{attempt}` | 監視ごとに `1` から始める |

**Monitor の watch は必ず deadline を持つ。無期限にするオプションは無い。**
`timeout_ms` に達すると watch は kill され、Claude へ「再 arm せよ」という通知が届く。
deadline の上限は **30 分**、**単発 `-p` 実行では 10 分**
（パラメータ名と上限の正本は Monitor ツール自身の説明文。ここへ写さない）。

したがって 30 分を 1 回の watch で張ることはできない。**6 分の watch を最大 5 回つなぐ**:

| 値 | 意味 |
|:---|:---|
| スクリプトの `max_checks=12` | 30 秒 × 12 = **watch 1 回あたり 6 分** |
| `timeout_ms: 420000` | 7 分。スクリプトの 6 分より長いので**通常はスクリプトが自分で終わる**（deadline kill は `gh` が固まったときの保険）。`-p` の上限 10 分より短いので**通常実行と `-p` で同じ値がそのまま使える** |
| スクリプトの `max_attempts=5` | 6 分 × 5 = **1 つの監視の合計 30 分**。**CI が Editor を起動するプロジェクトでは 10〜30 分かかる**ので縮めない |

**再 arm で状態を引き継ぐ必要は無い。** `review` / `checks` は毎回 API から `start_time` 起点で
判定し直すので、`start_time` さえ変えなければ前の watch で検出済みのレビューもそのまま再現される。
watch をまたいで引き継ぐのは `{attempt}` だけ。

### 監視の終了条件

スクリプトは打ち切るとき、次にどうするかを自分で最終行に出す。**残り回数を頭で数えない。**

| スクリプトの最終行 | 対応 |
|:---|:---|
| `CONTINUE` 行（`next_attempt=N` 付き） | **同じ引数のまま `{attempt}` だけ N に差し替えて再 arm する**。`{start_time}` は変えない |
| `RESULT` 行 | 出揃った。その監視を呼んだ Step の決着表へ |
| `TIMEOUT` 行 | 5 回を使い切った。打ち切りとして、その時点の値で決着表へ |

`timeout_ms` の deadline が先に来て、上のどれも出ないまま watch が終わった場合
（Monitor から再 arm を促す通知だけが届く）は `CONTINUE` と同じ扱いにし、
`{attempt}` を 1 つ進めて再 arm する。ただし `{attempt}` が既に `5` なら `TIMEOUT` と同じ扱い。

**1 つの監視で 5 回を超えて再 arm しない。** 延長したくなったら `max_attempts` を上げるのであって、
表の外で追加の watch を張らない。

決着の後に届いた Monitor の終了通知は無視する（その監視はもう終わっている）。

## Step 1: PR 特定 + 現在の状態確認 + 開始時刻記録

1. **PR特定**: `gh pr view --json number,url,headRefName` で自動検出、または引数から抽出
2. **リポジトリ情報取得**: `gh repo view --json owner,name`
3. **両系統の現在値を 1 レスポンスで取る**（Step 2 のポーリングと同じ判定を 1 回だけ先に撃つ）:

   ```bash
   gh api "repos/{owner}/{repo}/pulls/{pr}/reviews" \
     --jq '[.[] | select(.user.login // "" | test("copilot"; "i"))] | length'
   gh pr checks {pr}
   ```

   | 結果 | 対応 |
   |:---|:---|
   | レビューが `> 0` かつ CI に pending が無い | どちらも出揃っている。Monitor を起動せず **Step 2 の決着表へ直行** |
   | どちらかが未確定 | Step 2 の Monitor 監視へ進む |
   | コマンド自体が失敗（権限不足・ネットワーク等） | 「未確定」と同じ扱いで Step 2 へ進む（判定不能を「無し」と決めつけて対応を落とさない） |

   `gh pr checks` は **exit code で読む**（JSON のフィールド名に依存しない）:
   `0` = 全部 pass / `8` = pending あり / それ以外 = 失敗あり。
   ただし **チェックが 1 つも無い PR ではエラー終了する**ので、出力に `no checks` を含むかで
   「失敗」と「そもそも無い」を切り分ける。

   **Copilot 依頼の成否をここで判定しない。** 判定するのは after-pr-create hook で、
   失敗した PR には hook が「起動しないでください」と出す。2 箇所で判定すると、
   ずれたときに届いているレビューを取りこぼす。

   **`requested_reviewers` を使ってはいけない。** User 型しか返さず、Bot 型の Copilot は
   依頼が成立していても常に空配列になる。`pulls/{pr}/reviews` の `user.login` は Bot でも
   `copilot-pull-request-reviewer[bot]` を返すのでこの穴が無い。
4. **開始時刻記録**（Step 2 へ進む場合のみ）: `date -u +%Y-%m-%dT%H:%M:%SZ` → `{start_time}`

---

## Step 2: レビューと CI の監視と決着

監視スクリプトを `{phase}` = `review`、`{attempt}` = `1` で Monitor 起動する。
**初回だけ**「PR #{pr} のレビュー・CI 監視を開始しました」と出力する
（再 arm は同じ監視の続きなので何も出力しない）。

**このステップが終わるのは決着表の対応を済ませた時点**であって、
Monitor の完了通知が届いた時点ではない。通知は監視の途中経過で、決着はこのステップの中にある。

### 決着表

Step 1 で両系統が出揃っていた場合もここへ来る（Monitor を経由しない）。

| review | checks | 対応 |
|:---|:---|:---|
| `detected` | 何でも | resolve-pr を起動し、Step 3 へ |
| `no_comments` | `fail` | resolve-pr を起動し、Step 3 へ |
| `no_comments` | `pass` / `none` | 「レビュー完了・CI 通過、対応不要」と報告して終了 |

`TIMEOUT` で出揃わなかった値が残っているとき:

| 残った値 | 対応 |
|:---|:---|
| `review=none`（レビューが来なかった） | `checks=fail` なら resolve-pr を起動し Step 3 へ。`pending` なら Step 3 の CI 監視へ（push 前の head のまま CI を見続ける）。`pass` / `none` ならレビュー未着と CI の結果を報告して終了 |
| `checks=pending`（`review=detected` / `no_comments`） | 表の上段と同じく resolve-pr が要るなら起動して Step 3 へ。要らないなら Step 3 の CI 監視へ |

#### resolve-pr の起動方法

起動する直前に PR の head を記録する（Step 3 で push の有無を判定するため）:

```bash
gh pr view {pr} --json headRefOid --jq .headRefOid   # → {head_before}
```

```
Skill(skill: "resolve-pr", args: "{pr}")
```

resolve-pr 自身がレビューコメントと失敗した check の両方を集めるので、内容は渡さない。

---

## Step 3: push 後の CI 監視と決着

回り直した CI を監視し、pass / fail / timeout の結論を**自分で**報告する。
CI 修正の再試行回数 `{ci_retry}` は `0` から始める。

1. **監視が要るか判定する**（resolve-pr から戻ったときだけ。`ci` 引数で始めたときと
   Step 2 から resolve-pr を経ずに来たときは 2 へ進む）:

   ```bash
   gh pr view {pr} --json headRefOid --jq .headRefOid   # → {head_after}
   ```

   | 状態 | 対応 |
   |:---|:---|
   | `{head_after}` ≠ `{head_before}` | push された。2 へ |
   | 等しい（push が無かった） | CI は回り直していない。resolve-pr の報告と、push 前の CI の結果をそのまま報告して終了 |

2. **監視する**: 開始時刻を `{start_time}` に取り直し、監視スクリプトを `{phase}` = `ci`、
   `{attempt}` = `1` で Monitor 起動する。再 arm は監視スクリプトの終了条件に従う

3. **決着表**:

   | checks | 対応 |
   |:---|:---|
   | `pass` | 「push 後の CI 通過」と報告して終了 |
   | `fail` かつ `{ci_retry}` = `0` | `{ci_retry}` を `1` にし、head を `{head_before}` に記録してから `Skill(skill: "resolve-pr", args: "{pr} ci")` を起動し、この Step の 1 へ戻る |
   | `fail` かつ `{ci_retry}` = `1` | **止まる。** 失敗した check の一覧（`gh pr checks {pr}`）と、resolve-pr が報告した原因を添えて「CI 修正を 1 回試したが通らなかった」と報告して終了 |
   | `none` | 新しい head で CI が 1 つも走らなかった（ワークフローの paths 絞り込み等）と報告して終了 |
   | `pending`（`TIMEOUT`） | 30 分で結果が出なかった check の一覧（`gh pr checks {pr}`）を添えて timeout として報告して終了 |

   resolve-pr に `ci` を付けるのは、1 回目で返信済みのレビュー指摘へ 2 度目の返信を付けないため。

**報告にユーザーへの確認依頼を含めない。** pass / fail / timeout のどれで終わったかを結論として書く。
