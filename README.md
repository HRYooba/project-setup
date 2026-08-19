# project-setup

Claude Code 用のプロジェクト初期セットアップ plugin。次の skill を提供する。

| skill | 内容 |
|:------|:-----|
| `setup-github` | GitHub 開発フロー一式を導入する。ブランチ保護（pre-push。既定 ON・質問で外せる）、PR 前レビュー運用（`/simplify` + `/security-review` のソフト指示）、git 運用規約（Git Flow / Conventional Commits）、create-issue skill。任意で Copilot PR 自動レビュー（自動アサイン / watch-pr / resolve-pr）と AGENTS.md 自動生成 |
| `setup-unity` | Unity 開発規約一式を導入する。rules（フォルダ構成 / Hierarchy / アセット命名 / コーディング規約 / テスト）、skills（test-unity / lint-unity / unity-parallel）、agents（unity-tester / unity-linter / unity-worker）。任意でレイヤードアーキテクチャ規約と MCP バインディング |
| `setup-sync` | プラグインのテンプレート更新に、展開済みリポジトリを追随させる。保存フラグで apply.mjs を再適用し、同期 PR を作成する（merge はしない）。SessionStart hook の通知を受けて、または手動で `/setup-sync` を実行する |

どちらも**冪等**（再実行安全）で、導入オプションは実行時に対話で確認する。配置物は対象リポジトリの `.claude/` などにコミットされるため、plugin を持たないチームメイトにもそのまま効く。

## Markdown の更新はエージェントが統合する

`.claude/rules/*.md` と `.claude/CLAUDE.md` は、テンプレートが配ったあとプロジェクト側で育つ散文になる。機械的に上書きすればその追記が消え、機械的にスキップすればテンプレの更新が永久に届かない。どちらも取らず、**apply.mjs はこの 2 種類を書かない**:

- 配備先に無ければそのまま配る（判断の余地がない）
- 内容が同じなら何もしない
- **差分があれば書かずに「要マージ」として報告する** — 現物とテンプレ両方のパスを出力する

統合は skill 手順で Claude が行う。判断基準は `skills/md-merge-contract.md` に単一ソースとして置き、3 つの skill がそれを読む。要点は「テンプレが扱う話題はテンプレ側を正とし、プロジェクト固有の記述は残す。正面から矛盾する場合はユーザーに確認する」。

この委譲によって、旧実装が持っていた「配る文面のコード内定数」と「旧文面からの完全一致移行リスト」（文面を変えるたびに伸びる腐る書き方）が不要になった。`skills/*/templates/claude-md.md` が配る節の単一ソースになる。

## テンプレート自動追随

プラグインのテンプレートを更新すると、展開済みの各プロジェクトへ手作業で「更新を適用して」と個別依頼する運用になりがちだった。これを **「通知」と「実行」を分けて** 追随させる:

- apply.mjs は適用時のプラグイン版と有効フラグを `.claude/setup-sync-state.json` に記録する（setup-github / setup-unity が同じファイルへ各自のキーでマージ）。
- setup-github が配る SessionStart hook `setup-sync-check.mjs` が、セッション開始時にこの記録版と現行プラグイン版を比較する（差が無ければ即終了）。現行版が新しければ **「`/setup-sync` を実行して」と通知するだけ** に徹する（ネットワーク・git は叩かない）。
- 実際の同期は `setup-sync` skill（`sync-run.mjs`）が行う。`--phase=apply`（ガード → ブランチ → apply 再適用）→ **要マージの .md を Claude が統合** → `--phase=publish`（commit → push → PR 作成）の 3 段。**merge はしない**（PR diff で戻し・警告を確認して人間がマージ）。
- 重複 PR 防止（`gh pr list`）・試行上限（同一版 最大2回）・merge 禁止を **コードで担保** する（注入文＝指示頼みにしない）。判断を要するのは .md の統合工程だけで、そこを飛ばせないよう `--phase` は必須。事前確認は `sync-run.mjs --dry-run`。hook の無効化は環境変数 `SETUP_SYNC_DISABLE=1`。

既存の展開済みプロジェクトは、一度 setup-github / setup-unity を再実行すれば状態ファイルが生成され、以後の追随対象になる。

## Unity の並列作業（検証レーン）

Unity Editor は 1 つしか無く、開いているフォルダ 1 つしか見ない。さらに Unity MCP の接続先選択は
**クライアント単位のグローバル状態**なので、複数のエージェントが同時に Editor を触ると、ツール呼び出しは
成功を返したまま**別のスナップショットを検証して green を報告する**。エラーにならないので気づけない。

`setup-unity` が配る `unity-parallel` skill は、Editor を「順番に 1 人だけへ貸す排他資源」として扱う。
作業自体は worktree ごとに並列のまま、Editor が必要になったエージェントだけがキューに並ぶ。

- **貸し出し管理は `lane.mjs`**（ロック・phase journal・`checkout --detach`・`cherry-pick` での返却・復旧）。散文の手順書では担保できない（守られなかったことが出力に現れないため）
- **検問は `guard.mjs`**（PreToolUse hook）。トークンを持たないエージェントの Unity MCP 呼び出しと、Unity シリアライズファイルの手編集を止める
- hook は **skill の frontmatter で登録**され、その skill を呼び出したセッションでだけ有効になる。`settings.json` には触れない

**保証しないこと**（`references/protocol.md` に明記）: これは協調的なエージェントの事故を止める仕組みであって、
意図的な回避への防壁ではない。シェル越しの書き込みはヒューリスティック判定で、hook 自体の無効化は防げない。
またレーンの green は**そのスナップショットに対する green**でしかなく、`Library/` を持ち回るため
クリーンな環境でのインポート結果と一致する保証もない。重要な統合点では CI を最終的な権威にする。

## インストール

```
/plugin marketplace add hryooba/project-setup
/plugin install project-setup@hryooba
```

scope は `user`（デフォルト）を推奨。全プロジェクトで skill が使えるようになる。

## 使い方

対象プロジェクトを開いた Claude Code セッションで:

```
/project-setup:setup-github
/project-setup:setup-unity
```

または「GitHub 運用ルールを導入して」「Unity 規約を入れて」のように依頼する。

## 構成

```
skills/
├─ md-merge-contract.md … 要マージ .md の統合手順（3 skill 共通・単一ソース）
├─ setup-github/
│   ├─ SKILL.md
│   ├─ apply.mjs        … インストーラ本体（Node 標準のみ・依存なし）
│   └─ templates/
│       ├─ claude-md.md … CLAUDE.md へ配る節
│       ├─ base/        … 常時導入分（githooks / hooks / rules / create-issue skill）
│       └─ pr-copilot/  … PR 自動レビュー導入時のみ
├─ setup-sync/
│   ├─ SKILL.md
│   └─ sync-run.mjs     … 同期の実行本体（--phase=apply / publish）
└─ setup-unity/
    ├─ SKILL.md
    ├─ apply.mjs
    ├─ bindings/        … Unity MCP サーバー別のバインディング表
    └─ templates/
        ├─ claude-md.md … CLAUDE.md へ配る節
        ├─ base/        … 常時導入分（rules / skills / agents）
        └─ architecture/ … レイヤードアーキテクチャ規約導入時のみ
```

テンプレートは plugin に同梱されたスナップショットであり、この plugin 単体で完結する（外部ファイルを参照しない）。

## テスト

apply.mjs の冪等性・Markdown の要マージ判定（配る / 触らない / 書かずに報告する）・配布廃止 hook の撤去（実体削除 + settings.json 登録解除）、テンプレ自動追随（setup-sync のフェーズ分割・ガード）、検証レーン（門番の拒否判定・差分ゲート・排他・`.meta` の往復）は `tests/` のユニットテストで検証する（Node 標準の test runner のみ・依存なし）:

```
node --test "tests/*.test.mjs"
```

CI（`.github/workflows/test.yml`）が PR ごとに同じテストを実行する。
