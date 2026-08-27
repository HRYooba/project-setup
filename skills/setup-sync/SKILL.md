---
name: setup-sync
description: >
  project-setup のテンプレート更新に、対象リポジトリを追随させるセットアップコマンド。
  SessionStart hook がテンプレ更新を検知したとき、およびユーザーが「setup-sync」
  「テンプレ同期」「テンプレを最新に追随」などと依頼したときに使う。
  記録版と現行プラグイン版を比較し、更新があれば使い捨て worktree の中で保存フラグから
  apply.mjs を再適用し、要マージの Markdown を統合してから commit → push → 同期 PR を
  作成する（merge はしない）。重複 PR 防止・試行上限・作業ツリー分離はコード担保。
version: 1.3.0
user-invocable: true
argument-hint: "[対象ディレクトリ（省略時はカレント）]"
---

# テンプレート同期のセットアップ

project-setup のテンプレート更新に対象リポジトリを追随させる。実行の中核は
`sync-run.mjs` にあり、重複 PR 防止・試行上限・merge 禁止・作業ツリー分離を**コードで担保**する。

**このスキルはユーザーのセッションで走る。** 裏で別プロセスの Claude には走らせない。
進行も判断も会話に出るのが正しい状態で、要マージ .md の統合で矛盾が出たらその場で聞ける。

実行は `--phase=apply` → **要マージの Markdown を統合** → `--phase=publish` の 3 段。
`apply.mjs` は `rules/*.md` と `CLAUDE.md` を書かず「要マージ」として報告するだけなので、
commit まで一息に走らせると .md の更新が反映されないまま PR が出る。Claude の判断を要するのは
この統合工程だけで、それ以外（ガード・worktree・commit・PR）はすべてコード側で完結する。

## 前提

- 対象が git リポジトリで、`origin` が GitHub にあること
- `gh` CLI が認証済み（PR 作成に必要。未認証なら重複チェックはスキップされ push/PR で失敗する）

## 手順

### Step 1: 対象の確認

- 引数があればそのディレクトリ、なければカレントを対象とする。**常にリポジトリのルート**を渡す
- まず `--dry-run` で同期計画（対象スキル・保存フラグ・ブランチ・試行回数）を確認し、本文で報告する:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/setup-sync/sync-run.mjs" {target} --dry-run
```

- 「同期不要」「同期対象外」と出たら、その旨を伝えて終了する（PR は作らない）

### Step 2: apply フェーズ

`--dry-run` で対象が確認できたら、apply フェーズを実行する:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/setup-sync/sync-run.mjs" {target} --phase=apply
```

このフェーズが行うこと（すべてコード内で完結。途中の判断を LLM に委ねない）:

1. **重複防止** — 同期ブランチ `chore/setup-sync-v<version>` の open PR があれば、何もせず終了する
2. **試行上限** — 同一版につき最大 2 回（`SETUP_SYNC_MAX_ATTEMPTS` で変更可）。副作用に入る前に
   試行回数を +1 保存するため、途中失敗も 1 回として数える。上限到達なら起動せず終了する
3. `origin` を fetch し、**default ブランチから使い捨て worktree を切る**（sparse-checkout で
   `.claude` / `.github` / `.githooks` とルート直下だけ展開）→ その中で同期ブランチを作成
4. 保存フラグで `apply.mjs` を再適用 → 出力（要マージ一覧を含む）を流す
5. 同期計画・警告・worktree パスをフェーズ間ファイルへ保存して停止する（**commit はしない**）

**以降の編集はすべて worktree の中で行う。** 対象リポジトリの作業ツリーとブランチには触れない
（ユーザーが編集中でも衝突しない。`git add -A` が無関係な変更を巻き込むことも構造的に起こらない）。

途中で終了した（「同期不要」「既に同期 PR が存在」「試行上限」）場合は、その旨を伝えて終了する。

### Step 2.5: 要マージの Markdown を統合する

apply フェーズの出力に「要マージ」節があれば、`${CLAUDE_PLUGIN_ROOT}/skills/md-merge-contract.md`
を Read し、そこに書かれた手順と判断基準に従って各ファイルを統合する。**この工程を飛ばすと
テンプレの .md 更新が届かないまま PR が出る。**「要マージ」節が無ければ何もしない。

対象は **worktree 側のパス**（apply の出力に載っている）。対象リポジトリの作業ツリーを編集しない。

テンプレと現物が正面から矛盾したら、両者を並べてユーザーに確認する。聞けない状況でだけ契約書の
「矛盾したときの扱い」に従い、テンプレ側を採って
`~/.claude/plugins/data/project-setup/sync-notes.md` へ矛盾の中身を書き残す。publish が
それを PR 本文の「要確認」節へ転記して消すので、判断は PR レビューへ引き継がれる。

### Step 2.6: publish フェーズ

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/setup-sync/sync-run.mjs" {target} --phase=publish
```

worktree の中で `git add -A` → 差分ゼロなら終了 → `chore:` コミット → push → `gh pr create` →
古い版の同期 PR を close → **worktree を撤去**。**merge はしない**（不可逆操作は人間のゲートに残す）。
PR 本文には apply の警告と、あれば Step 2.5 の矛盾メモを全文転記する。

### Step 3: 結果報告

両フェーズの標準出力（同期計画・統合したファイル・PR URL・警告・スキップ理由）をそのまま伝える。
Step 2.5 で統合したファイルがあれば、何を採り何を残したかも添える。
PR が作られた場合は「merge はしていないので、内容を確認してからマージしてください」と添える。

## 注意

- **merge は決してしない**。PR を作るところで止まる。マージ可否はレビューして人間が判断する
- 試行上限に達した版は同期されない。原因（apply 失敗・push 権限・gh 未認証など）を解消し、
  必要なら `~/.claude/plugins/data/project-setup/sync-attempts.json` の該当キーを削除して再試行する
- 発火方向はアップグレードのみ（現行版 > 記録版）。ダウングレードや版一致では何もしない
- **フェーズを飛ばさない**。`--phase` 無しの実行はエラーになる（apply と publish の間の統合工程を
  スキップさせないため）。publish は apply が残した同期計画
  （`~/.claude/plugins/data/project-setup/sync-plan.json`）が無いとエラー終了する
- apply フェーズで中断した場合、worktree と同期計画が残る。やり直すときは `--phase=apply` から
  実行し直す（同じ場所の worktree を作り直す。試行回数は 1 消費されている点に注意）
- 同期 PR はリポジトリごとに常に 1 本・最新版だけに保つ。新しい版の PR を作った後、
  `chore/setup-sync-v*` の古い open PR は close する（reopen できる可逆操作。ブランチは残る）
- Unity のような巨大リポジトリを全チェックアウトすると Windows の MAX_PATH（260 字）に当たる。
  worktree を sparse-checkout で切っているのはそのため。展開範囲を広げるときはここを思い出す
