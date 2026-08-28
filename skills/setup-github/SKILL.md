---
name: setup-github
description: >
  現在のプロジェクトに GitHub 開発フロー一式を導入するセットアップコマンド。
  ユーザーが「setup-github」「GitHub運用ルールを導入」「ブランチ保護を入れて」
  「Git運用セットアップ」などと依頼したときに使用する。対象リポジトリに
  ブランチ保護（.githooks/pre-push + SessionStart 自動有効化。既定 ON・質問で外せる）、
  PR 前レビュー運用（/code-review + /security-review のソフト指示）、git-conventions ルール、
  create-issue skill を撒く。ブランチ保護の有無と、PR 自動レビュー3機能（Copilot 自動アサイン /
  watch-pr / resolve-pr）と AGENTS.md 自動生成（Copilot code review にプロジェクト規約を教える）の
  導入有無は、実行時に AskUserQuestion で確認する。
version: 1.18.0
user-invocable: true
argument-hint: "[導入先ディレクトリ（省略時はカレント）]"
---

# GitHub 開発フローのセットアップ

このコマンドは、対象プロジェクトに次を**冪等に**インストールする（再実行安全）:

## base（常時。ただしブランチ保護は質問で外せる）

1. **ブランチ保護（既定 ON・質問で外せる）** — `.githooks/pre-push` が保護ブランチ（default branch + develop）への直 push を拒否。保護ブランチは実行時に検出するため repo ごとの設定は不要。Claude Code 利用者は SessionStart hook で `core.hooksPath` が自動設定され、手動 push を含む全ツールの push に効く。質問で「入れない」を選ぶと `--no-pre-push` で導入をスキップし、**配備済みなら pre-push を削除**する（撒く git hook が他に無ければ `core.hooksPath` の自動設定 hook と即時設定も解除する）
2. **レビュー対象フォルダ設定（残置）** — `.claude/hooks/review-config.json`（`reviewTargets` / `reviewExcludes`）と `.claude/hooks/lib/reviewable-files.mjs` は配布を続ける。**pr-copilot の Copilot 自動アサインの対象判定**に使う唯一のソース（除外デフォルトは `.claude/` `.github/` `.githooks/`。明示指定が無い限り再実行で温存）
3. **code-review 用 hook の撤去** — `pr-code-review-gate.mjs`（PR 作成 gate）と `code-review-effort-nudge.mjs`（effort 差し戻し nudge）は**配らない**。hook で PR 作成を機械的に堰き止める形は取らず、レビュー運用は CLAUDE.md のソフト指示に置く。配備先に残っていれば**再実行時に実体を削除**し、settings.json の登録も解除する
4. **git-conventions ルール** — skill 同梱の `templates/base/rules/git-conventions.md` を `.claude/rules/` へコピー。ただし**既存があり内容が異なる場合は書かず「要マージ」として報告**し、Claude が現物とテンプレを読んで統合する（Step 2.6）。上書きするとプロジェクト固有のブランチ戦略が消え、スキップするとテンプレ更新が永久に届かないため、どちらも採らない
5. **create-issue skill** — skill 同梱の `templates/base/skills/create-issue/` を `.claude/skills/` へコピー
5-b. **`.github/` テンプレート（seed）** — `templates/base/.github/` の `pull_request_template.md`（小文字・単一ファイル）と `ISSUE_TEMPLATE/{bug_report,feature_request,task}.yml` を配置。**既にファイルがある場合は一切触らない**（PR / Issue テンプレはリポジトリ所有の成果物で、独自に育てているリポがあるため）。更新したいときはプロジェクト側で同梱版から手動で取り込む
6. **CLAUDE.md** — ブランチ規約（作業ブランチ経由の PR 必須）と PR 前レビュー運用を**ソフト指示**として配る（強制はしない）。レビュー（`/code-review` / `/security-review`）は条件付きで各 1 回。**発火条件の文面は `templates/claude-md.md` が正本**でありここには写さない（写すとテンプレ更新で黙ってズレる）。**ファイルが無ければ書き、節の行が揃っていれば触らず、揃っていなければ「要マージ」として報告**する（Step 2.6 で Claude が統合。文面の移行リストは保守しない）
7. **テンプレート更新の検知** — `.claude/sync-setup-state.json` に「適用時の project-setup プラグイン版」と「有効フラグ一式」を記録し（setup-github / setup-unity が同じファイルへ各自のキーでマージ。相手のキーは消さない）、`.claude/hooks/sync-setup-check.mjs`（SessionStart hook）が現行版と比較する。現行版のほうが新しければ **`systemMessage`（ユーザーの画面に出る）と `additionalContext`（Claude が読む）の両方**で知らせて終わる（差が無ければ即 exit・毎セッションの税を最小化）。同期そのものは **メインセッションの Claude が `/project-setup:sync-setup` を実行して**行う（裏で別プロセスの Claude には走らせない。進行も .md 統合の判断も会話に出るのが正しい）。SessionStart はブロックできない仕様なので、強制はせず見えるようにする方に倒している。**重複PR防止・試行回数ガード（同一版 最大2回）・merge 禁止・作業ツリー分離は sync-run.mjs がコード担保する**（origin の default から使い捨て sparse worktree を切ってその中だけで作業・PR は作るが merge はしない・apply の warnings を PR 本文へ全文転記・古い版の同期 PR は新しい PR 作成後に close して常に 1 本に保つ）。発火はアップグレード方向のみ（複数マシンで版がずれても古い版が新しい同期を巻き戻さない）。無効化は `SYNC_SETUP_DISABLE=1`。**この単一 hook が setup-unity のドリフトも検知する**（setup-unity は状態ファイルへ自分のキーを書くだけで settings.json には触れない。検知には setup-github の導入が前提）

## pr-copilot モード（質問で「PR 自動レビューを入れる」を選んだ場合）

8. **Copilot 自動アサイン** — `gh pr create` 直後、コード変更を含む PR に Copilot レビュアーを自動で付ける（PostToolUse hook）。watch-pr の起動指示はこの hook の additionalContext が唯一のトリガー（CLAUDE.md には書かない。無条件の起動指示は hook の「コード変更を含む PR のみ」ガードを迂回し、レビューが来ない PR への空監視を生むため）。Copilot 依頼に失敗した PR には watch-pr を起動させない
9. **watch-pr** — PR レビューをポーリング監視し、指摘を検出したら resolve-pr を自動起動（skill）。監視前に requested_reviewers へ Copilot が居るかを確認し、居なければ監視せず終了する（CLAUDE.md 手編集等で誤起動されても 30 分の空監視をしない多層防御）。1 PR につき 1 回のみ
10. **resolve-pr** — レビューコメントの取得・修正・commit/push・リプライ・スレッド Resolve を一括実行（skill + `review-responder` agent）
11. **AGENTS.md 自動生成** — `.claude/rules/*.md` のうち先頭 5 行以内に「agents-md: include」マーカー（HTML コメント）を持つファイルを、固定文（言語: 日本語（対話・出力）、英語（思考・推論）／コードレビューの対象はスクリプトのみ）とともに連結し、ルートの `AGENTS.md` を生成する。Copilot code review はルートの AGENTS.md を自動で読むため、これが Copilot にプロジェクト規約を教える経路になる。同期は `.githooks/pre-commit` がコミットごとに再生成 → 差分があれば stage（rules 更新と AGENTS.md の乖離が構造的に起きない）。手書きの AGENTS.md（生成ヘッダー無し）は上書きせず警告。マーカー付き rules が無い場合は固定文だけの AGENTS.md になる（setup-unity 等が後からマーカー付き rules を撒けば、次のコミットで自動的に取り込まれる）
12. **AGENTS.md 乖離の CI ガード** — `.github/workflows/agents-md-sync.yml`。PR と保護ブランチへの push の両方で AGENTS.md を再生成して差分が出ないか検証する（`git add -N` で未追跡の生成物も検出）。ローカルの pre-commit は `--no-verify` / GitHub Web UI 編集 / hooksPath 未設定の clone / node 不在（fail-open）で素通りするため、その経路のドリフト（PR を経ない保護ブランチ直 push も含む）を検出する最後の砦

## 前提

- base: 対象が git リポジトリであること（git repo でなくてもファイル配置は行うが、hooksPath 設定はスキップされる）
- pr-copilot モード: `gh` CLI が認証済み（`gh auth status`）かつ、そのリポジトリで GitHub Copilot code review が有効

## 手順

### Step 1: 導入先の確認とセットアップ質問

- 引数があればそのディレクトリ、なければカレントを導入先とする
- `git -C {target} remote get-url origin`（あれば `gh repo view --json nameWithOwner,viewerPermission,deleteBranchOnMerge`）でリポジトリを確認し、想定どおりか報告する。`viewerPermission` が `ADMIN` かどうかで「ブランチ自動削除」の質問を出すかを決める（下表参照）
- **セットアップ質問**: 下表の全項目を **AskUserQuestion 1 回にまとめて必ず確認**する。ユーザーからオプションフラグは受け取らない（依頼文に書かれていても、再実行でも質問は省略しない）。回答から Claude が apply.mjs のフラグを組み立てる。**再実行時は配備済みの現在値を先に調べ、「現在のまま維持」を推奨選択肢として先頭に置く**（回答次第で上書きはされるが、黙って消えることはない）。質問の直前に、調べた現状（リポジトリ・現在値・Copilot 可否）を本文テキストで提示する

| 項目 | 質問内容 | 選択肢 | 現在値の調べ方（再実行時） |
|:---|:---|:---|:---|
| ブランチ保護 | 保護ブランチ（default branch + develop）への直 push を拒否する `.githooks/pre-push` を入れるか。既定は入れる（Git Flow 前提の推奨構成）。「入れない」を選ぶと導入せず、配備済みなら削除する | 入れる（推奨）/ 入れない | `.githooks/pre-push` の有無 |
| PR 自動レビュー | Copilot 自動アサイン / watch-pr / resolve-pr / AGENTS.md 自動生成を入れるか。そのリポジトリで Copilot code review が使えるかを判断材料として添える。※導入済み（`after-pr-create.mjs` がある）なら、フラグ無し再実行でも apply.mjs が自動継承する | 入れる / 入れない | `.claude/hooks/after-pr-create.mjs` の有無 |
| レビュー対象フォルダ | Copilot 自動アサインの対象フォルダを絞るか（ベンダーコードの一括導入 PR に Copilot レビューを付けないための絞り込み）。質問前にリポジトリ構成を見て自作コードのフォルダ候補（例: `src` `shared`、Unity なら `Assets/App`）を挙げる | 候補フォルダ（multiSelect 可）/ 絞らない（全フォルダ対象） | `.claude/hooks/review-config.json` の `reviewTargets` |
| レビュー除外フォルダ | 対象から常に外すフォルダ。デフォルトは `.claude/` `.github/` `.githooks/`（ツール設定系。setup-github の導入 PR を素通しする）。対象フォルダ指定より優先 | デフォルトのまま / 追加除外あり / 除外なし | `.claude/hooks/review-config.json` の `reviewExcludes` |
| ブランチ自動削除 | PR マージ後に head ブランチを GitHub が自動削除するか（リポジトリ設定 `delete_branch_on_merge`）。**実行者が admin（`viewerPermission: ADMIN`）のときのみ質問する**（admin 以外は設定を変更できないため質問せず、現在値を Step 3 で報告するに留める）。ローカルに残る gone ブランチの掃除は git-refresh 等の運用側の役割である旨を判断材料として添える | 有効にする / 無効のまま（再実行時は現在値の維持を推奨選択肢に） | Step 1 で取得済みの `deleteBranchOnMerge` |

- 回答 → フラグ変換: ブランチ保護「入れない」= `--no-pre-push`（「入れる」= フラグを渡さない＝既定 ON） / PR 自動レビュー「入れる」= `--pr-copilot` / フォルダ指定 = `--review-targets=<csv>` / 「絞らない」= `--review-targets=`（空値で明示解除。再実行時に配備済みの値が温存されないよう必ず明示する） / 除外の変更 = `--review-excludes=<csv>` / 「除外なし」= `--review-excludes=`（空値で明示解除） / 「デフォルトのまま」= フラグを渡さない（テンプレートのデフォルト or 配備済み値の温存）
- ブランチ自動削除の回答は apply.mjs のフラグにはしない（GitHub API 設定でありファイル配置ではないため）。Step 2.5 で gh により反映する

### Step 2: インストール実行

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/setup-github/apply.mjs" {target} [--pr-copilot] [--no-pre-push] [--review-targets=src,shared]
```

### Step 2.5: ブランチ自動削除の反映（admin で質問した場合のみ）

回答が現在値（`deleteBranchOnMerge`）と異なるときだけ実行する:

```bash
gh repo edit {nameWithOwner} --delete-branch-on-merge         # 有効にする
gh repo edit {nameWithOwner} --delete-branch-on-merge=false   # 無効へ戻す
```

### Step 2.6: 要マージの Markdown を統合する

apply.mjs の出力に「要マージ」節があれば、`${CLAUDE_PLUGIN_ROOT}/skills/md-merge-contract.md`
を Read し、そこに書かれた手順と判断基準に従って各ファイルを統合する。**この工程を飛ばすと
テンプレ更新がその配備先に届かない。**「要マージ」節が無ければ何もしない。

### Step 3: 結果報告

apply.mjs の出力（配置ファイル・settings.json 登録状態・git 設定状態・警告）をそのまま伝える。
Step 2.6 で統合したファイルがあれば、何を採り何を残したかも併せて伝える。
ブランチ自動削除は設定結果（変更した / 現在値のまま / 非 admin のため現在値の報告のみ）を添える。
併せて次を案内する:

- 反映には**新しいセッションでの再読み込みが必要**（hook・skill・agent はセッション開始時に読み込まれる）
- `.claude/` と `.githooks/`（pr-copilot モード時は `AGENTS.md` と `.github/workflows/` も）は repo にコミットしてチームへ配布する（`.githooks/` の hook は exec bit 付きで stage 済み）。コミットは通常どおり作業ブランチ + PR で
- pr-copilot モード時: `AGENTS.md` は自動生成物なので直接編集しない（内容は `.claude/rules/` 側で変える）。Copilot の custom instructions は **PR の head branch から読まれる**ため、AGENTS.md の変更はマージ前に同じ PR のレビューへ効く
- チームメイトは clone 後、Claude Code で開いて trust 承認すれば SessionStart hook により pre-push が自動で有効になる

## 注意

- テンプレート由来のファイル（hooks / githooks / skills / agents）は**上書きコピー**される。プロジェクト側で手編集していた場合は上書きされる旨を伝える（例外: `rules/*.md` と `CLAUDE.md` は上書きせず「要マージ」にして Claude が統合する。レビュー対象/除外は `.claude/hooks/review-config.json` に保存されるため明示指定が無い限り温存される。lib に直接埋め込まれていた設定は初回再実行時に config へ自動移行する）
- `.claude/settings.json` の hook 登録は、自分が撒いた hook（スクリプト名一致 / hooksPath は完全一致）だけを更新する。ユーザー独自の `core.hooksPath` 設定 hook 等は上書きせず警告してスキップする
- `.claude/settings.json` は**上書きせず追記マージ**（登録済みの hook はテンプレート最新形へ更新、それ以外は変更しない）。JSON パースに失敗した場合は登録をスキップして警告するので、その旨を報告する
- `.claude/CLAUDE.md` は `templates/claude-md.md` の節の全行が揃っていれば触らない（冪等）。揃っていなければ「要マージ」になり、Step 2.6 で Claude が統合する。現行テンプレに無い行は「テンプレから消えた項目」として除去される（除去対象の一覧はここに持たない。テンプレが正本で、差分は統合時に機械的に出る）
- apply.mjs は `.githooks/pre-push` を stage する（exec bit 付与のため）。ユーザーが意図しない stage が混ざらないよう、コミット時に確認する。ブランチ保護を「入れない」で再実行した場合は、配備済み pre-push を削除しその削除を stage する（撒く git hook が他に無ければ `core.hooksPath` の SessionStart hook と即時設定も解除する）
- `.claude/sync-setup-state.json`（テンプレート自動追随の状態ファイル）は **repo にコミットする**（次回比較の基準としてバージョン管理下に残す。`.gitignore` しない）。SessionStart の同期チェック hook は新しいセッションから有効になる。バックフィル（既存の展開済みプロジェクトへ状態ファイルを配る）は、各プロジェクトで setup-github / setup-unity を再実行すれば自動生成される
