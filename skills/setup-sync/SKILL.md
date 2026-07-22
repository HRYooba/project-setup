---
name: setup-sync
description: >
  project-setup のテンプレート更新に、対象リポジトリを追随させるセットアップコマンド。
  SessionStart hook（setup-sync-check.mjs）が「テンプレ更新あり」を通知したとき、
  またはユーザーが「setup-sync」「テンプレ同期」「テンプレを最新に追随」などと依頼したときに使う。
  記録版と現行プラグイン版を比較し、更新があれば保存フラグで apply.mjs を再適用し、
  commit → push → 同期 PR を作成する（merge はしない）。重複 PR 防止・試行上限は
  実行スクリプト側でコード担保される。
version: 1.0.0
user-invocable: true
argument-hint: "[対象ディレクトリ（省略時はカレント）]"
---

# テンプレート同期のセットアップ

project-setup のテンプレート更新に対象リポジトリを追随させる。実行の中核は
`sync-run.mjs` にあり、重複 PR 防止・試行上限・merge 禁止を**コードで担保**する。
この SKILL は「起動して結果を報告する」薄い入口に徹する（判断や手作業を挟まない）。

## 前提

- 対象が git リポジトリで、`origin` が GitHub にあること
- `gh` CLI が認証済み（PR 作成に必要。未認証なら重複チェックはスキップされ push/PR で失敗する）

## 手順

### Step 1: 対象の確認

- 引数があればそのディレクトリ、なければカレントを対象とする
- まず `--dry-run` で同期計画（対象スキル・保存フラグ・ブランチ・試行回数）を確認し、本文で報告する:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/setup-sync/sync-run.mjs" {target} --dry-run
```

- 「同期不要」「同期対象外」と出たら、その旨を伝えて終了する（PR は作らない）

### Step 2: 同期実行

`--dry-run` で対象が確認できたら、本実行する:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/setup-sync/sync-run.mjs" {target}
```

このスクリプトが順に行う（すべてコード内で完結。途中の判断を LLM に委ねない）:

1. **重複防止** — 同期ブランチ `chore/setup-sync-v<version>` の open PR、またはタイトルに
   `setup-sync` を含む open PR があれば、何もせず終了する
2. **試行上限** — 同一版につき最大 2 回（`SETUP_SYNC_MAX_ATTEMPTS` で変更可）。副作用に入る前に
   試行回数を +1 保存するため、途中失敗も 1 回として数える。上限到達なら起動せず終了する
3. 作業ブランチ作成 → 保存フラグで `apply.mjs` を再適用 → `git add -A`
4. 差分がゼロなら空コミットを作らず終了する（防御。通常は状態ファイルの版更新で差分が出る）
5. `chore:` コミット → push → `gh pr create` で PR 作成。**merge はしない**（不可逆操作は人間のゲートに残す）。
   PR 本文には apply.mjs の警告を全文転記する

### Step 3: 結果報告

`sync-run.mjs` の標準出力（同期計画・PR URL・警告・スキップ理由）をそのまま伝える。
PR が作られた場合は「merge はしていないので、内容を確認してからマージしてください」と添える。

## 注意

- **merge は決してしない**。PR を作るところで止まる。マージ可否はレビューして人間が判断する
- 試行上限に達した版は自動同期されない。原因（apply 失敗・push 権限・gh 未認証など）を解消し、
  必要なら `~/.claude/plugins/data/project-setup/sync-attempts.json` の該当キーを削除して再試行する
- 発火方向はアップグレードのみ（現行版 > 記録版）。ダウングレードや版一致では何もしない
