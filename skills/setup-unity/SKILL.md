---
name: setup-unity
description: >
  現在の Unity プロジェクトに開発規約一式（rules / test-unity / lint-unity / サブエージェント）を
  導入するセットアップコマンド。ユーザーが「Unityセットアップ」「setup-unity」「Unity規約を導入」
  「このプロジェクトにUnity開発ルールを入れて」などと依頼したときに使用する。
  カレントのリポジトリの .claude/ に rules（unity-cli / folder-structure / hierarchy /
  asset-naming / coding-standards / testing）、skills（test-unity / lint-unity / unity-parallel）、
  agents（unity-tester / unity-linter / unity-worker）を撒く。Unity 操作は Unity CLI に固定で、
  Unity CLI 本体と com.unity.pipeline が未導入なら入れる。
  レイヤードアーキテクチャ規約（architecture / class-catalog）の導入有無は、
  実行時に AskUserQuestion で確認する。
version: 2.1.0
user-invocable: true
argument-hint: "[導入先ディレクトリ（省略時はカレント）]"
---

# Unity 開発規約のセットアップ

このコマンドは、対象 Unity プロジェクトに次を**冪等に**インストールする（再実行安全）:

1. **rules** — `unity-cli.md`（Unity 操作の絶対ルール。方針・失敗判定・コマンドの発見手順・Safe Mode 復旧）/ `folder-structure.md` / `hierarchy.md` / `asset-naming.md` / `coding-standards.md` / `testing.md`
2. **test-unity** — 変更差分のテスト責任判定・設計・実装・重複整理・実行（skill + `unity-tester` agent + 設計/実装ガイド）
3. **lint-unity** — アセット・シーン・Prefab のルール準拠チェック（skill + `unity-linter` agent + チェックリスト）
4. **unity-parallel** — git worktree で複数の `unity-worker` を並列に動かしつつ、1 つしかない検証レーン（Unity Editor が開いているフォルダ）を順番待ちで貸し出す（skill + `lane.mjs`（貸し出し管理）+ `guard.mjs`（PreToolUse hook）+ `unity-worker` agent + `references/protocol.md`）。**この skill は自身の frontmatter で hook を登録する** — 呼び出したセッションでだけ有効になり、`settings.json` には触れない
5. **Unity CLI 本体と `com.unity.pipeline`**（未導入のとき）— Unity 操作の前提。CLI は winget / brew、Pipeline は `unity pipeline install`
6. **（architecture モード。質問で「入れる」を選んだ場合）** — レイヤードアーキテクチャ規約（`architecture.md` / `class-catalog.md`）+ レイヤー前提版の folder-structure / coding-standards / testing / テスト設計ガイドへの差し替え（lint チェックリストは base に統合済み。層依存チェック項目は「architecture 導入時のみ」として base 側に載る）

## 前提（満たされていないと skills が動かない）

- 対象が Unity プロジェクトである（`ProjectSettings/ProjectVersion.txt` が存在する）
- **Unity CLI**（`unity --version`）。未導入なら**このコマンドが入れる**（Step 2.6）
- **live Editor 操作には `com.unity.pipeline` と Unity 6.0 LTS 以降が必要**。
  Pipeline は**このコマンドが入れる**（Step 2.7）。要るのは Unity アカウントへのサインインだけで、
  未サインインなら `unity auth login` の実行を頼む（ブラウザが開く対話フローなので代打しない）。
  6.0 未満でも `unity test` / `unity build` / `unity projects verify` は動くので、test-unity は完走し、
  lint-unity は Editor 不要カテゴリだけ実行する縮退動作になる
- `com.unity.ai.assistant` を入れているなら **2.13 以降**（それ未満は CLI と競合する）
- Node.js が利用可能
- 規約はアプリ本体を **`Assets/App/`** 配下に置く前提（UniTask / R3 / VContainer スタックを想定）

## 手順

### Step 1: 導入先の確認とセットアップ質問

- 引数があればそのディレクトリ、なければカレントを導入先とする
- `ProjectSettings/ProjectVersion.txt` の存在で Unity プロジェクトであることを確認する
- 質問の準備として以下を調べる（**1 レスポンスにまとめて実行する**）:

```bash
unity --version                                   # CLI の導入と版数
unity pipeline list --format json                 # Editor 到達性と Pipeline パッケージ
cat <target>/ProjectSettings/ProjectVersion.txt   # Editor 版（6.0 LTS 以降か）
```

  - **CLI 未導入**（`unity` が見つからない）→ 導入手順を案内し、**導入は必須ではない**旨も添える
    （規約の配備自体は CLI 無しでもできる。CLI が無いと test-unity / lint-unity が動かないだけ）
  - **Pipeline 未導入 / 到達不可** → `unity auth login` → `unity pipeline install` を案内する。
    Safe Mode（`data.summary.instancesInSafeMode > 0`）なら、それはコンパイルエラーであって
    導入の問題ではない旨を伝える
  - **Editor 版が 6.0 未満** → live Editor 操作が使えないため、lint-unity が Editor 不要カテゴリだけの
    縮退動作になることを伝える（test-unity は `unity test` で完走する）
  - **再実行時の現在値**: `.claude/rules/architecture.md` の有無（architecture モード導入済みか）
  - `Assets/App/` の有無

- **セットアップ質問**: 下表の項目を **AskUserQuestion 1 回にまとめて必ず確認**する。ユーザーからオプションフラグは受け取らない（依頼文に書かれていても、再実行でも質問は省略しない）。回答から Claude が apply.mjs のフラグを組み立てる。**再実行時は現在値を「現在のまま維持」として推奨選択肢の先頭に置く**。質問の直前に、上で調べた現状（CLI の版数・Editor 到達性・Editor 版・現在値・Assets/App の有無）を本文テキストで提示する

| 項目 | 質問内容 | 選択肢 |
|:---|:---|:---|
| アーキテクチャ規約 | レイヤードアーキテクチャ規約（architecture / class-catalog + レイヤー前提の各規約差し替え）を入れるか | 入れる / 入れない。導入済みリポジトリで「入れない」が選ばれた場合は、巻き戻しに `.claude/rules/architecture.md` / `class-catalog.md` の手動削除が必要な旨を伝えて意思を再確認する（apply.mjs は導入済みなら自動継承するため） |
| Assets/App（無い場合のみ） | 規約は `Assets/App/` 前提。無いまま続行するか（新規プロジェクトならこれから作ればよい。既存の別ルート構成なら導入後に規約か構成のどちらかを合わせる必要がある） | 続行 / 中止 |

- 回答 → フラグ変換: アーキテクチャ「入れる」= `--architecture`

### Step 2: インストール実行

以下を実行する（`{target}` は導入先。省略時はカレント）:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/setup-unity/apply.mjs" {target} [--architecture]
```

apply.mjs が次を行う:
- `templates/base/` を `{target}/.claude/`（`rules/` `skills/` `agents/`）へ再帰コピー
- このスキルが配らないファイル（`rules/unity-mcp.md` / `rules/unity-mcp-tools.md` /
  `skills/{test-unity,lint-unity}/references/unity-mcp-tools.md`）が配備先にあれば**取り除く**。
  残すと `rules/unity-cli.md` と手順が二重になり、常時コンテキストに並ぶため
  （プロジェクト固有の追記があった場合は配備先の git 履歴から復元できる）
- `--mcp <値>` を渡されても**エラーにせず注意を出して無視**する
  （`sync-setup-state.json` に記録が残っている配備先があり、テンプレ同期がそのまま渡してくるため。次の適用で state から消える）
- `--architecture` 時は `templates/architecture/` を上から上書きコピー
  （architecture / class-catalog の追加 + folder-structure / coding-standards / testing / test-designing-guide のレイヤー版差し替え。lint checklist は base に統合済みなので差し替えない）
- **architecture 導入済みの検知**: `.claude/rules/architecture.md` が既にあれば、`--architecture` 指定なしでも architecture モードを自動継承する（レイヤー版規約が base 版に巻き戻るのを防止）
- `.claude/rules/*.md` と `.claude/CLAUDE.md` は**書かない**（初回配置と、内容が同じときを除く）。差分があれば現物を維持したまま「要マージ」として報告する。CLAUDE.md へ配る節（検証手順は `rules/testing.md` に従う、というポインタ）は `templates/claude-md.md`
- `{target}/.claude/sync-setup-state.json`（テンプレート自動追随の状態ファイル）へ `setup-unity` キー（適用時のプラグイン版と有効フラグ = `--architecture`）をマージ記録する（setup-github のキーは温存）。**このスキルは settings.json に触れず hook も配らない**（従来どおり）。ドリフト検知の SessionStart hook は setup-github が配る単一の `sync-setup-check.mjs` が担い、この状態ファイルの全キーを見る。したがって Unity プロジェクトの auto-sync には setup-github の導入も必要

### Step 2.5: 要マージの Markdown を統合する

apply.mjs の出力に「要マージ」節があれば、`${CLAUDE_PLUGIN_ROOT}/skills/md-merge-contract.md`
を Read し、そこに書かれた手順と判断基準に従って各ファイルを統合する。**この工程を飛ばすと
テンプレ更新がその配備先に届かない。**「要マージ」節が無ければ何もしない。

### Step 2.6: Unity CLI の導入

Step 1 で **CLI 未導入**（`unity --version` が失敗）と分かっていたら、ここで入れる。
プラットフォームで分岐する:

| OS | コマンド |
|:--|:--|
| Windows | `winget install Unity.CLI --accept-package-agreements --accept-source-agreements` |
| macOS | `brew install --cask unity-cli` |
| Linux | Unity 公式の apt / dnf リポジトリ（`unity --version` が通るまでは手順を案内して止める） |

- **入れた直後、このセッションでは `unity` が使えない**（PATH がシェルに反映されていない）。
  よって Step 2.7 は飛ばし、Step 3 で「新しいセッションで `/setup-unity` を再実行すると
  Pipeline まで入る」と伝える。どのみち rules / skill の反映にセッション再読み込みが要る
- インストールが失敗したら、出力をそのまま添えて報告し止める（配備物はそのまま残る）

### Step 2.7: Pipeline パッケージの導入

Step 1 で **Pipeline 未導入**と分かっていて、Editor 版が **6.0 LTS 以降**で、
かつ **CLI が Step 2.6 で入れたものでない**（＝このセッションで `unity` が使える）なら、ここで入れる。
`unity command`（シーン・Prefab・コンポーネント操作、コンパイル確認）がこれを前提にしているため、
入れないと test-unity / lint-unity が縮退動作のままになる。

```bash
unity pipeline install --project-path {target} --format json
```

- **冪等**。導入済みなら「変更なし」を返すので、条件を取り違えても壊れない
- 終了コードで分岐する（`rules/unity-cli.md`「失敗判定」）:
  - **exit 3（認証失敗）** → `unity auth login` はブラウザを開く対話フローなので**代わりに打たない**。
    ユーザーに `! unity auth login` を実行してもらい、済んだら上のコマンドを再実行する
  - **exit 0 以外のその他** → `errors[0].code` を添えて報告し、手順を案内して止める（配備物はそのまま）
- 成功したら **Unity Editor 側の再コンパイルを待つ**必要がある旨を伝える。
  その後 `unity pipeline list --format json` で `hasPipelinePackage` を確認する

**この工程は apply.mjs に入れない。** テンプレ同期は sparse worktree の中で apply.mjs を直接
起動するので、そこで `Packages/manifest.json` を書くと同期 PR に混入する（`Packages/` は
worktree に展開されてすらいない）。Pipeline の導入は人が `/setup-unity` を打った時だけ走らせる。

- **Editor 版が 6.0 未満** / **Safe Mode** / **CLI をこのセッションで入れたばかり** のときは
  この工程を飛ばし、Step 3 で状況に応じた案内をする

### Step 3: 結果報告

apply.mjs の出力（配置ファイル一覧・モード）をそのまま伝える。Step 2.5 で統合したファイルが
あれば、何を採り何を残したかも併せて伝える。加えて次を案内する:

- 反映には**新しいセッションでの再読み込みが必要**（rules・skill・agent はセッション開始時に読み込まれる）
- Step 1 の調査結果に応じて次を案内する（どれも配備物のやり直しは不要）:
  - **CLI を Step 2.6 で入れた** → **新しいセッションで `/setup-unity` を再実行**すると Pipeline まで入る
  - **CLI を入れられなかった** → 出力を添えて手順を案内する
  - **Pipeline を Step 2.7 で入れた** → **Editor 側の再コンパイルを待つ**よう伝える（待たずに `unity command` を叩いても繋がらない）
  - **Pipeline が入れられなかった** → 止まった理由（認証・CLI 未導入・6.0 未満・Safe Mode）と、解消後に `/setup-unity` を再実行すれば入る旨を伝える
  - **Safe Mode** → 導入の問題ではない。`rules/unity-cli.md`「Safe Mode」の手順でコンパイルエラーを解消する
  - **Editor 版が 6.0 未満** → live Editor 操作は使えない。lint-unity は Editor 不要カテゴリのみの縮退動作になる
- 公式の `unity-cli` skill（`unity skill install claude-code`。`--local` でプロジェクトへも入る）は
  CLI の詳細リファレンス。**任意**。setup-unity はこれに依存しない — CLI バイナリに埋め込まれた
  スナップショットなので、配備先ごとに CLI の版が違えば内容も違い、`rules/unity-cli.md` の
  「発見してから呼ぶ」方針とも役割が重ならないため
- アーキテクチャ規約の後付けは、再実行してセットアップ質問で選び直せばよい
- `rules/testing.md` の「テスト実行のスコープ」欄は空（全件実行）で配置される。プロジェクト外の
  常時失敗テストを拾うプロジェクトでは、ここに `unity test --filter` へ渡す値を記録する
  （**人が読む一覧ではなくコマンドへ渡る値**なので、記述と実行の乖離が起きない）
- coding-standards / architecture / class-catalog の先頭にある `<!-- agents-md: include -->` は、
  setup-github（--pr-copilot）の AGENTS.md 自動生成が「Copilot code review に教える規約」として
  取り込むための目印。setup-github 未導入なら不活性なだけで無害（導入後の次のコミットで自動反映される）

## 注意

- `skills/` `agents/` `references/` は**上書きコピー**される。導入先で手編集していた場合は上書きされる点を伝える。`rules/*.md` と `CLAUDE.md` だけは上書きせず「要マージ」にして Claude が統合する（Step 2.5）
- `--architecture` から base へ「戻す」機能はない。導入済みなら再実行時に自動で architecture モードが継承される。
  base に戻す場合は `.claude/rules/architecture.md` / `class-catalog.md` を手動削除してから再実行する
- 不明な `--` オプションはエラー終了する（typo で意図しないモードのまま成功しない）。例外は `--mcp <値>`（注意を出して無視。上記）
- **Unity 操作のコマンド表を持たない。** Editor が公開するコマンドは Editor 側（`com.unity.pipeline` と
  プロジェクトの `[CliCommand]`）が定義するため、一覧を書くと必ず腐る。`rules/unity-cli.md` は
  「`unity command --format json` で発見する」という手順と、失敗判定・禁止事項・Safe Mode 復旧だけを持つ。
  CLI 自身のコマンド（`unity test` / `unity projects verify` / `unity doctor --ci`）はフラグまで書いてよいが、
  正本は `unity <command> --help` である旨を併記する
- このスキルは `.claude/settings.json` に触れない。テンプレート自動追随の状態ファイル `.claude/sync-setup-state.json` へは自分のキー（`setup-unity`）だけをマージ記録する（データファイルの更新であり hook 登録ではない）。SessionStart の同期チェック hook 本体と settings.json 登録は setup-github が単独で担う（hook の二重管理を作らないため）
- **hook 契約の範囲**: 「settings.json へ恒久登録する hook は配らない」が契約であって、「hook を一切配らない」ではない。`unity-parallel` は自身の SKILL.md frontmatter に PreToolUse hook を持つ。これは **その skill を呼び出したセッションでだけ登録され**、settings.json には現れない。並列作業をしていないセッションの挙動は変わらない
- **テンプレート保守（スキル開発者向け）**: `templates/architecture/` の各ファイル（folder-structure / coding-standards / testing / test-designing-guide）は `templates/base/` の同名ファイルのレイヤー特化版で、architecture モード時に上書き差し替えされる。base 側の規約を変えたら architecture 側にも反映すること（テスト設計ガイドの「テスト責任」「禁止する低品質テスト」一覧やアセットのプレフィックスは、`rules/testing.md` / `rules/asset-naming.md` を単一ソースとして参照させ、重複記載を避ける）
- CLAUDE.md へ配る節は `templates/claude-md.md` にある（apply.mjs のコード内定数ではない）。文面を変えるとその節の行が配備先と一致しなくなり、次の適用で「要マージ」として検出される。文面の移行リストを保守する必要はない
