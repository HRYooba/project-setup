---
name: setup-github
description: >
  現在のプロジェクトに GitHub 開発フロー一式を導入するセットアップコマンド。
  ユーザーが「setup-github」「GitHub運用ルールを導入」「ブランチ保護を入れて」
  「Git運用セットアップ」などと依頼したときに使用する。対象リポジトリに
  ブランチ保護（.githooks/pre-push + SessionStart 自動有効化。既定 ON・質問で外せる）、
  PR 前レビュー運用（/simplify のソフト指示 + 感応な変更を含む PR でだけ /security-review を
  促す nudge）、git-conventions ルール、create-issue skill を撒く。ブランチ保護の有無と、
  PR 自動レビュー3機能（Copilot 自動アサイン / watch-pr / resolve-pr）と AGENTS.md 自動生成
  （Copilot code review にプロジェクト規約を教える）の導入有無は、実行時に AskUserQuestion で確認する。
version: 1.12.0
user-invocable: true
argument-hint: "[導入先ディレクトリ（省略時はカレント）]"
---

# GitHub 開発フローのセットアップ

このコマンドは、対象プロジェクトに次を**冪等に**インストールする（再実行安全）:

## base（常時。ただしブランチ保護は質問で外せる）

1. **ブランチ保護（既定 ON・質問で外せる）** — `.githooks/pre-push` が保護ブランチ（default branch + develop）への直 push を拒否。保護ブランチは実行時に検出するため repo ごとの設定は不要。Claude Code 利用者は SessionStart hook で `core.hooksPath` が自動設定され、手動 push を含む全ツールの push に効く。質問で「入れない」を選ぶと `--no-pre-push` で導入をスキップし、**配備済みなら pre-push を削除**する（撒く git hook が他に無ければ `core.hooksPath` の自動設定 hook と即時設定も解除する）
2. **PR 前レビュー gate（休眠・ファイルのみ配布）** — `.claude/hooks/pr-code-review-gate.mjs` は配るが settings.json には**登録しない**（既存配備先は再実行で登録解除）。最新の Claude Code で `/code-review` が原則ユーザー手打ち専用になり、Claude が自走で満たせる自動門番として成立しなくなったため、レビュー運用は `/simplify`（CLAUDE.md ソフト指示）と `/security-review`（下記 4 の感応 nudge）へ移行した。gate 本体には「手打ちレビューを取りこぼして deny を連発するループ（`typedRe` が最新版の `<command-message>` 前置きに負けて手打ち `/code-review` を認識できず、間の commit で HEAD が動くため『レビュー後 HEAD 動く→再レビュー』に見える）」バグがあったが**修正済み**（タグ全体で捕捉）。再有効化したい場合は PreToolUse へ手動登録する（`CR_GATE_DISABLE=1` で無効化可）。レビュー対象フォルダ設定 `.claude/hooks/review-config.json`（`reviewTargets` / `reviewExcludes`、`lib/reviewable-files.mjs` が読む。除外デフォルトは `.claude/` `.github/` `.githooks/`）は **pr-copilot の Copilot 自動アサインの対象判定に引き続き使う**
3. **effort 明示の差し戻し nudge（休眠）** — `.claude/hooks/code-review-effort-nudge.mjs` も配るが登録しない（既存配備先は再実行で登録解除）。Claude 発の `/code-review` 起動（Skill / SlashCommand）を対象にした hook で、`/code-review` が手打ち専用になった今は発火しようがないため
4. **セキュリティレビュー nudge（常時有効）** — `.claude/hooks/security-review-nudge.mjs`（PostToolUse・matcher Bash・`if: Bash(gh pr create *)`）。`gh pr create` 成功後、PR の変更が「セキュリティ感応」なら `/security-review` の実行を additionalContext で促す（**非ブロック**）。gate/nudge の休眠とは逆に settings.json へ**登録して発火させる**のが目的。感応判定は `lib/security-signals.mjs`（balanced: 依存マニフェストの変更 / 認証・秘密情報に関わるパス・名 / 追加行のキーワード〈暗号・外部コマンド実行・SQL 組立・デシリアライズ・XSS/DOM 注入・TLS/CORS/CSRF〉の OR）。走査は base...HEAD で、ツール設定系（`.claude/` `.github/` `.githooks/`）は除外する（この hook 自身の変更で自己発火しないため）。今回の PR 作業で既に `/security-review` 済みなら促さない。誤検知・見逃しは前提の nudge なので、不要と判断すればスキップ可。無効化は `SECURITY_NUDGE_DISABLE=1`
5. **git-conventions ルール** — skill 同梱の `templates/base/rules/git-conventions.md` を `.claude/rules/` へコピー。ただしプロジェクト側で内容がカスタマイズされている（同梱版と異なる）場合は上書きせず警告する
6. **create-issue skill** — skill 同梱の `templates/base/skills/create-issue/` を `.claude/skills/` へコピー
7. **CLAUDE.md** — ブランチ規約（作業ブランチ経由の PR 必須）と「PR 作成前に `/simplify` を 1 回（再利用・簡素化・効率の整理）」を**ソフト指示**として追記（gate 休眠のため強制はしない）。セキュリティレビューは**無条件では書かない**（上記 security-review-nudge が感応 PR でだけ促すため）。旧テンプレの code-review 必須行は `/simplify` 行へ再実行時に完全一致置換で移行し、旧の無条件セキュリティレビュー行（soft/ブロック両版）は削除する（手編集された行は触らず警告）
8. **テンプレート自動追随** — `.claude/setup-sync-state.json` に「適用時の project-setup プラグイン版」と「有効フラグ一式」を記録し（setup-github / setup-unity が同じファイルへ各自のキーでマージ。相手のキーは消さない）、`.claude/hooks/setup-sync-check.mjs`（SessionStart hook）が現行版と比較する。現行版のほうが新しければ additionalContext で「`isolation: worktree` のバックグラウンドサブエージェントを起動し、保存フラグで apply.mjs を無人適用 → commit → push → PR 作成（**merge はしない**・warnings を PR 本文へ全文転記）」を促す。差が無ければ即 exit（毎セッションの税を最小化）。発火はアップグレード方向のみ（複数マシンで版がずれても古い版が新しい同期を巻き戻さない）。重複PR防止（`gh pr list`）と試行回数ガード（同一版 最大2回）は起動されたサブエージェント側が担う。無効化は `SETUP_SYNC_DISABLE=1`。**この単一 hook が setup-unity のドリフトも検知する**（setup-unity は状態ファイルへ自分のキーを書くだけで settings.json には触れない。auto-sync には setup-github の導入が前提）

## pr-copilot モード（質問で「PR 自動レビューを入れる」を選んだ場合）

9. **Copilot 自動アサイン** — `gh pr create` 直後、コード変更を含む PR に Copilot レビュアーを自動で付ける（PostToolUse hook）。watch-pr の起動指示はこの hook の additionalContext が唯一のトリガー（CLAUDE.md には書かない。無条件の起動指示は hook の「コード変更を含む PR のみ」ガードを迂回し、レビューが来ない PR への空監視を生むため）。Copilot 依頼に失敗した PR には watch-pr を起動させない
10. **watch-pr** — PR レビューをポーリング監視し、指摘を検出したら resolve-pr を自動起動（skill）。監視前に requested_reviewers へ Copilot が居るかを確認し、居なければ監視せず終了する（CLAUDE.md 手編集等で誤起動されても 30 分の空監視をしない多層防御）。1 PR につき 1 回のみ
11. **resolve-pr** — レビューコメントの取得・修正・commit/push・リプライ・スレッド Resolve を一括実行（skill + `review-responder` agent）
12. **AGENTS.md 自動生成** — `.claude/rules/*.md` のうち先頭 5 行以内に「agents-md: include」マーカー（HTML コメント）を持つファイルを、固定文（言語: 日本語（対話・出力）、英語（思考・推論）／コードレビューの対象はスクリプトのみ）とともに連結し、ルートの `AGENTS.md` を生成する。Copilot code review はルートの AGENTS.md を自動で読むため、これが Copilot にプロジェクト規約を教える経路になる。同期は `.githooks/pre-commit` がコミットごとに再生成 → 差分があれば stage（rules 更新と AGENTS.md の乖離が構造的に起きない）。手書きの AGENTS.md（生成ヘッダー無し）は上書きせず警告。マーカー付き rules が無い場合は固定文だけの AGENTS.md になる（setup-unity 等が後からマーカー付き rules を撒けば、次のコミットで自動的に取り込まれる）
13. **AGENTS.md 乖離の CI ガード** — `.github/workflows/agents-md-sync.yml`。PR と保護ブランチへの push の両方で AGENTS.md を再生成して差分が出ないか検証する（`git add -N` で未追跡の生成物も検出）。ローカルの pre-commit は `--no-verify` / GitHub Web UI 編集 / hooksPath 未設定の clone / node 不在（fail-open）で素通りするため、その経路のドリフト（PR を経ない保護ブランチ直 push も含む）を検出する最後の砦

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
| レビュー対象フォルダ | Copilot 自動アサインの対象フォルダを絞るか（ベンダーコードの一括導入 PR に Copilot レビューを付けないための絞り込み。gate は休眠だが設定は残す）。質問前にリポジトリ構成を見て自作コードのフォルダ候補（例: `src` `shared`、Unity なら `Assets/App`）を挙げる | 候補フォルダ（multiSelect 可）/ 絞らない（全フォルダ対象） | `.claude/hooks/review-config.json` の `reviewTargets` |
| レビュー除外フォルダ | 対象から常に外すフォルダ。デフォルトは `.claude/` `.github/` `.githooks/`（ツール設定系。setup-github の導入 PR を素通しする）。対象フォルダ指定より優先 | デフォルトのまま / 追加除外あり / 除外なし | `.claude/hooks/review-config.json` の `reviewExcludes` |
| ブランチ自動削除 | PR マージ後に head ブランチを GitHub が自動削除するか（リポジトリ設定 `delete_branch_on_merge`）。**実行者が admin（`viewerPermission: ADMIN`）のときのみ質問する**（admin 以外は設定を変更できないため質問せず、現在値を Step 3 で報告するに留める）。ローカルに残る gone ブランチの掃除は git-refresh 等の運用側の役割である旨を判断材料として添える | 有効にする / 無効のまま（再実行時は現在値の維持を推奨選択肢に） | Step 1 で取得済みの `deleteBranchOnMerge` |

- 回答 → フラグ変換: ブランチ保護「入れない」= `--no-pre-push`（「入れる」= フラグを渡さない＝既定 ON） / PR 自動レビュー「入れる」= `--pr-copilot` / フォルダ指定 = `--review-targets=<csv>` / 「絞らない」= `--review-targets=`（空値で明示解除。再実行時に旧値が温存されないように必ず明示する） / 除外の変更 = `--review-excludes=<csv>` / 「除外なし」= `--review-excludes=`（空値で明示解除） / 「デフォルトのまま」= フラグを渡さない（テンプレートのデフォルト or 配備済み値の温存）
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

### Step 3: 結果報告

apply.mjs の出力（配置ファイル・settings.json 登録状態・git 設定状態・警告）をそのまま伝える。
ブランチ自動削除は設定結果（変更した / 現在値のまま / 非 admin のため現在値の報告のみ）を添える。
併せて次を案内する:

- 反映には**新しいセッションでの再読み込みが必要**（hook・skill・agent はセッション開始時に読み込まれる）
- `.claude/` と `.githooks/`（pr-copilot モード時は `AGENTS.md` と `.github/workflows/` も）は repo にコミットしてチームへ配布する（`.githooks/` の hook は exec bit 付きで stage 済み）。コミットは通常どおり作業ブランチ + PR で
- pr-copilot モード時: `AGENTS.md` は自動生成物なので直接編集しない（内容は `.claude/rules/` 側で変える）。Copilot の custom instructions は **PR の base branch から読まれる**ため、AGENTS.md が default branch にマージされて初めてレビューに効く
- チームメイトは clone 後、Claude Code で開いて trust 承認すれば SessionStart hook により pre-push が自動で有効になる

## 注意

- テンプレート由来のファイル（hooks / githooks / skills / agents）は**上書きコピー**される。プロジェクト側で手編集していた場合は上書きされる旨を伝える（例外: `git-conventions.md` はカスタマイズ検知で保護され、レビュー対象/除外は `.claude/hooks/review-config.json` に保存されるため明示指定が無い限り温存される。旧版で lib に直接埋め込まれていた設定は初回再実行時に config へ自動移行する）
- `.claude/settings.json` の hook 登録は、自分が撒いた hook（スクリプト名一致 / hooksPath は完全一致）だけを更新する。ユーザー独自の `core.hooksPath` 設定 hook 等は上書きせず警告してスキップする
- `.claude/settings.json` は**上書きせず追記マージ**（登録済みの hook はテンプレート最新形へ更新、それ以外は変更しない）。JSON パースに失敗した場合は登録をスキップして警告するので、その旨を報告する
- `.claude/CLAUDE.md` はマーカー（`**ブランチ**:` / `**簡素化**:`）が既にあれば追記しない（冪等）。セキュリティレビュー行は追記しない（security-review-nudge が肩代わり）。例外・移行: 旧 code-review 行（`**レビュー**:`）は旧テンプレ文面と完全一致する場合のみ `/simplify` 行へ移行し、旧の無条件セキュリティレビュー行（`**セキュリティレビュー**:` の soft/ブロック両版）は完全一致する場合のみ削除する（いずれも手編集された行は触らず警告する）。旧版が撒いた「## PR レビュー」節（`**レビュー対応**:`）は配布廃止につき、旧テンプレ文面と完全一致するときだけ再実行時に除去する（手編集された節は警告して残す）
- apply.mjs は `.githooks/pre-push` を stage する（exec bit 付与のため）。ユーザーが意図しない stage が混ざらないよう、コミット時に確認する。ブランチ保護を「入れない」で再実行した場合は、配備済み pre-push を削除しその削除を stage する（撒く git hook が他に無ければ `core.hooksPath` の SessionStart hook と即時設定も解除する）
- `.claude/setup-sync-state.json`（テンプレート自動追随の状態ファイル）は **repo にコミットする**（次回比較の基準としてバージョン管理下に残す。`.gitignore` しない）。SessionStart の同期チェック hook は新しいセッションから有効になる。バックフィル（既存の展開済みプロジェクトへ状態ファイルを配る）は、各プロジェクトで setup-github / setup-unity を再実行すれば自動生成される
