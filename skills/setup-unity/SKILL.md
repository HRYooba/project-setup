---
name: setup-unity
description: >
  現在の Unity プロジェクトに開発規約一式を導入するセットアップコマンド。ユーザーが
  「Unityセットアップ」「setup-unity」「Unity規約を導入」「このプロジェクトにUnity開発ルールを入れて」
  などと依頼したときに使用する。`.claude/` へ rules（folder-structure / hierarchy /
  asset-naming / coding-standards）、CLAUDE.md（Unity 操作の方針と、コンパイル確認 / テスト / lint を
  回すタイミング）、skills（lint-unity / unity-parallel）、agents（unity-linter / unity-worker）を
  撒き、プロジェクト本体へ Roslyn analyzer と整合性検査の GitHub Actions を置く。
  公式 unity プラグイン（unity-cli を含む skills / commands / agents）も上流から引いて
  `.claude/` へ直接置く（プラグインとしては入れないので個人マシンのキャッシュに実体が残らず、
  配る sha は marketplace の pin に従う）。
  Unity 操作は Unity CLI に固定。CLI 本体と com.unity.pipeline が未導入なら入れる。アプリ本体の置き場（既定 `Assets/App/`）、
  レイヤードアーキテクチャ規約（architecture / class-catalog）の導入有無、レビュー対象を
  そこへ絞るかを実行時に AskUserQuestion で確認する。
version: 3.14.0
argument-hint: "[導入先ディレクトリ（省略時はカレント）]"
---

# Unity 開発規約のセットアップ

このコマンドは、対象 Unity プロジェクトに次を**冪等に**インストールする（再実行安全）:

1. **rules** — `folder-structure.md` / `hierarchy.md` / `asset-naming.md` / `coding-standards.md`（**規約の機械チェック**・命名・非同期・Reactive・DI・ドキュメントコメント・エラーハンドリング）
2. **CLAUDE.md** — Unity 操作の方針（CLI 経由 / シリアライズファイルを手編集しない）、`.cs` 変更後のコンパイル確認と `UCS` の読み方、テスト・lint を PR 前に回すタイミング。**Unity CLI の rules は配らない**（使い方は下記 8 が配る `unity-cli` skill が持つ）
3. **lint-unity** — アセット・シーン・Prefab のルール準拠チェック（skill + `unity-linter` agent + チェックリスト）
4. **unity-parallel** — git worktree で複数の `unity-worker` を並列に動かしつつ、1 つしかない検証レーン（Unity Editor が開いているフォルダ）を順番待ちで貸し出す（skill + `lane.mjs`（貸し出し管理）+ `guard.mjs`（PreToolUse hook）+ `unity-worker` agent + `references/protocol.md`）。**この skill は自身の frontmatter で hook を登録する** — 呼び出したセッションでだけ有効になり、`settings.json` には触れない
5. **Unity CLI 本体と `com.unity.pipeline`**（未導入のとき）— Unity 操作の前提。CLI は winget / brew、Pipeline は `unity pipeline install`
6. **（architecture モード。質問で「入れる」を選んだ場合）** — レイヤードアーキテクチャ規約（`architecture.md` / `class-catalog.md`）+ レイヤー前提版の folder-structure / coding-standards への差し替え（lint チェックリストは base に統合済み。層依存チェック項目は「architecture 導入時のみ」として base 側に載る）
7. **Roslyn analyzer** — `coding-standards.md` のうち**機械で判定できる規約**をコンパイル時に止める。`Assets/Analyzers/`（DLL + `.meta` + README）を**`.claude/` ではなく Unity プロジェクト本体へ**置く（判断が要る規約と、プロジェクト名を知らないと当てられない名前空間の規約は持たない）。**設定ファイル（`.ruleset` / `.globalconfig`）は配らない** — 全規則 Warning 固定（Error にすると Unity が Safe Mode へ落ちる）。**CI は診断を見ない**ので、違反は Editor のコンソールで読んで直す
8. **公式 unity プラグイン** — Unity 公式プラグイン（[`Unity-Technologies/unity-agent-plugin`](https://github.com/Unity-Technologies/unity-agent-plugin)）を上流から引き、`skills/` `commands/` `agents/` を `{target}/.claude/` 配下へ**直接置く**（各エントリの `references/` `resources/` `scripts/` ごと）。**プラグインとしては入れない**
   - **キャッシュを経由しない経路が他に無い。** `claude plugin install` は scope を問わず実体を `~/.claude/plugins/cache/` へコピーし、そこから読む。リポジトリ内に marketplace を置いて相対パスで入れても同じ。個人マシンへ実体を残さず、リポジトリの現物をそのまま読ませるには直置きしかない
   - **どの sha を配るかは、このマシンに登録済みの marketplace が unity に対して pin した値に従う**（`~/.claude/plugins/marketplaces/*/.claude-plugin/marketplace.json`）。pin が読めなければ上流 HEAD。**下記 9 の検知と同じ値を見る必要がある** — HEAD を配ると pin とズレている間ずっと drift 扱いになり、同期 PR が出続ける
   - **project-setup 側にコピーを持たない。** テンプレートへ写すと Unity 側の更新が手作業でしか届かなくなる。配った sha と各種名を `sync-setup-state.json` の `unityPlugin` に記録する
   - 入れ直すのは**記録の sha と pin が食い違うとき**だけ。`git` が無い・clone が失敗する環境では見送って続行し、記録は消さない
   - **上流の更新はこの sha の食い違いで検知される**（ドリフト検知 hook が同じ値を読む）。marketplace を 1 つも登録していないマシンでは pin が読めず、配置は HEAD で動くが**更新の検知が働かない** — その旨を警告する
   - **上流から消えたものは配備先からも消す。** 対象は記録に載っているものだけ（`lint-unity` / `unity-parallel` / `unity-linter` / `unity-worker` は別経路の配布物なので触らない）
   - **自前の配布物と同名なら上流を配らず報告する。** 黙って潰すと `unity-worker` などが別物へ差し替わる
   - **直置きで再現できない構成要素（`hooks/` `.mcp.json`）と、扱いを決めていない要素は配らず警告する。** hook は `${CLAUDE_PLUGIN_ROOT}` の解決と settings.json への登録が要る。黙って無視すると、上流が構成要素を足した更新が「入ったつもりで入っていない」状態のまま誰にも気づかれない
   - **`unity-cli` も上流版をそのまま配る。** `unity skill install` で CLI 埋め込み版を入れる経路は**持たない** — 実測（CLI `1.0.0-beta.9`）で埋め込み版の CHANGELOG は `beta.8` 止まり、上流は `beta.9` まで載せていて references も 1 本多く、**上流の方が新しかった**。加えて CLI 経由だと「同期を回した人のマシンの CLI 版」が配布物になり、中身がマシンごとに揺れる
   - **再配布なので `LICENSE.md` も置く**（`.claude/skills/UNITY-AGENT-PLUGIN-LICENSE.md`）。Unity Companion License（Unity 依存プロジェクトでの利用が条件）
9. **プラグインとして入っている同名 skill を伏せる** — `{target}/.claude/settings.json` の `skillOverrides` へ `"unity:<name>": "off"` を入れる（上記 8 で配った skill ぶん）
   - **潰し合わない。** プラグインをマーケットプレース経由で user スコープに入れているマシンでは、`unity:<name>` へ名前空間化された同じ skill が `.claude/skills/` 側と並んで両方モデルへ提示される。どちらを引くかは決まっていない
   - 伏せる名前は**配った skill から導出する**ので、上流の増減に自動で追随する。上流から消えたものの `off` は取り下げる（値が `"off"` のものだけ）
   - **配備先の settings.json に置く**ので、効くのは Unity 案件だけ
   - **既に値があるなら上書きしない。** `"on"` を明示した配備先は重複を承知の意思表示とみなす
10. **プロジェクト整合性の GitHub Actions** — `.github/workflows/unity-ci.yml`、`.github/actions/setup-unity-cli/`、`.github/scripts/unity-verify.mjs`。`unity projects verify --strict` だけをラッパー経由で走らせる（Editor もライセンスも secret も要らず 10 秒で返る。ラッパーを噛ませる理由は下記「CI について」）。**テストとコンパイル確認は CI でやらない** — Editor を起こすジョブは 1 回 10 分以上かかり PR ゲートに使えないため、ローカルへ移した。CI に残す理由は git の checkout 側にあり、追跡外の実体を持つ `.meta` のような「clone した人の手元で初めて壊れる」欠陥はここでしか出ない

## 前提（満たされていないと skills が動かない）

- 対象が Unity プロジェクトである（`ProjectSettings/ProjectVersion.txt` が存在する）
- **Unity CLI**（`unity --version`）。未導入なら**このコマンドが入れる**（Step 2.6）
- **live Editor 操作には `com.unity.pipeline` と Unity 6.0 LTS 以降が必要**。
  Pipeline は**このコマンドが入れる**（Step 2.7）。要るのは Unity アカウントへのサインインだけで、
  未サインインなら `unity auth login` の実行を頼む（ブラウザが開く対話フローなので代打しない）。
  6.0 未満でも `unity test` / `unity build` / `unity projects verify` は動くので、テスト実行は完走し、
  lint-unity は Editor 不要カテゴリだけ実行する縮退動作になる
- `com.unity.ai.assistant` を入れているなら **2.13 以降**（それ未満は CLI と競合する）
- Node.js が利用可能
- 規約はアプリ本体を 1 つのフォルダ配下に置く前提（UniTask / R3 / VContainer スタックを想定）。置き場は `--app-root` で選べ、既定は **`Assets/App/`**。この値が folder-structure / lint-unity / analyzer の適用範囲すべての正本になる

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
    （規約の配備自体は CLI 無しでもできる。CLI が無いとテスト実行 / lint-unity が動かないだけ）
  - **Pipeline 未導入 / 到達不可** → `unity auth login` → `unity pipeline install` を案内する。
    Safe Mode（`data.summary.instancesInSafeMode > 0`）なら、それはコンパイルエラーであって
    導入の問題ではない旨を伝える
  - **Editor 版が 6.0 未満** → live Editor 操作が使えないため、lint-unity が Editor 不要カテゴリだけの
    縮退動作になることを伝える（テスト実行は `unity test` で完走する）
  - **再実行時の現在値**: `.claude/rules/architecture.md` の有無（architecture モード導入済みか）
  - **再実行時の現在値**: `Assets/Analyzers/analyzable-root.txt` の値（＝前回の `--app-root`。無ければ既定の `Assets/App/`）
  - そのフォルダの有無。無ければ `Assets/` 直下を見て、アプリ本体らしいフォルダの候補を挙げる
  - `.claude/hooks/review-config.json` の有無と `reviewTargets` の現在値（無い＝setup-github 未実行）

- **セットアップ質問**: 下表の項目を **AskUserQuestion 1 回にまとめて必ず確認**する。ユーザーからオプションフラグは受け取らない（依頼文に書かれていても、再実行でも質問は省略しない）。回答から Claude が apply.mjs のフラグを組み立てる。**再実行時は現在値を「現在のまま維持」として推奨選択肢の先頭に置く**。質問の直前に、上で調べた現状（CLI の版数・Editor 到達性・Editor 版・現在値・アプリ本体の置き場とその有無）を本文テキストで提示する

| 項目 | 質問内容 | 選択肢 |
|:---|:---|:---|
| アーキテクチャ規約 | レイヤードアーキテクチャ規約（architecture / class-catalog + レイヤー前提の各規約差し替え）を入れるか | 入れる / 入れない。導入済みリポジトリで「入れない」が選ばれた場合は、巻き戻しに `.claude/rules/architecture.md` / `class-catalog.md` の手動削除が必要な旨を伝えて意思を再確認する（apply.mjs は導入済みなら自動継承するため） |
| アプリ本体の置き場 | 規約（folder-structure / lint-unity / analyzer）をどのフォルダへ当てるか。既定は `Assets/App/`。**`Assets/` 配下でなければならない**（Unity がコンパイルへ載せるのは `Assets/` と `Packages/` だけで、規約が対象にするのは前者）。既存プロジェクトなら `Assets/` 直下を見て候補を挙げる。再実行時は現在値を推奨選択肢の先頭に置く | `Assets/App/`（既定）/ 検出した候補フォルダ / 自由入力 |
| 置き場が存在しない場合のみ | 選んだフォルダがまだ無いが続行するか（新規プロジェクトならこれから作ればよい） | 続行 / 中止 |
| レビュー対象フォルダ | レビュー対象を上で選んだ置き場に絞るか。**Copilot 自動アサインと `/code-review` / `/security-review` の両方に効く**（外部アセットの一括導入 PR にレビューが付かなくなる）。`review-config.json` が無い場合は setup-github 未実行なので、この質問は出さず、先に setup-github を走らせる必要がある旨を伝える | 絞る（推奨）/ 絞らない |

- 回答 → フラグ変換: アーキテクチャ「入れる」= `--architecture`。置き場が既定以外なら `--app-root=<パス>`（既定 `Assets/App/` のままなら渡さない）。レビュー対象「絞る」= `--review-target` / 「絞らない」= `--no-review-target`（どちらも `review-config.json` の `reviewTargets` を書き換える。質問を出さなかった＝config が無い場合はどちらも渡さない）。analyzer と CI は常時配布なのでフラグは無い

### Step 2: インストール実行

以下を実行する（`{target}` は導入先。省略時はカレント）:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/setup-unity/apply.mjs" {target} [--architecture] [--app-root=<パス>] [--review-target | --no-review-target]
```

apply.mjs が次を行う:
- `templates/base/` を `{target}/.claude/`（`rules/` `skills/` `agents/`）へ再帰コピー
- このスキルが配らないファイル（`OBSOLETE_PATHS`。旧 unity-mcp 一式と、skill をやめた
  `skills/test-unity/` 一式・`agents/unity-tester.md`・旧 `references/test-*-guide.md`・旧 `rules/testing.md` / `rules/dev-flow.md`）が配備先にあれば**取り除く**。
  空になったディレクトリも畳む。残すと現行の rules と手順が二重になり、常時コンテキストに並ぶため
  （プロジェクト固有の追記があった場合は配備先の git 履歴から復元できる）
- 廃止したフラグ（`--mcp <値>` / `--analyzer` / `--analyzer-severity=...`）を渡されても
  **エラーにせず注意を出して無視**する
  （`sync-setup-state.json` に記録が残っている配備先があり、テンプレ同期がそのまま渡してくるため。次の適用で state から消える）
- `--architecture` 時は `templates/architecture/` を上から上書きコピー
  （architecture / class-catalog の追加 + folder-structure / coding-standards のレイヤー版差し替え。lint checklist は base に統合済みなので差し替えない）
- **architecture 導入済みの検知**: `.claude/rules/architecture.md` が既にあれば、`--architecture` 指定なしでも architecture モードを自動継承する（レイヤー版規約が base 版に巻き戻るのを防止）
- `templates/project/` を `{target}/`（**`.claude/` ではなくプロジェクト直下**）へ**常時**コピーする。
  中身は `Assets/Analyzers/`（analyzer の DLL / `.meta` / README）と `.github/`（整合性検査の
  workflow と Unity CLI 導入の composite action）。Unity は `Assets/` 配下にあり `RoslynAnalyzer`
  ラベルの付いた DLL だけを C# コンパイラへ渡すので、置き場所と `.meta` が動作条件そのものになる。
  どれもビルド成果物・配布物なので上書きする（**設定ファイルは配らない**ので、配備先が育てる
  ファイルがここに無い ＝ マージ判定が要らない）
- `.claude/rules/*.md` と `.claude/CLAUDE.md` は**書かない**（初回配置と、内容が同じときを除く）。差分があれば現物を維持したまま「要マージ」として報告する。CLAUDE.md は節を配るので全文一致では判定できず、**節の非空行がすべて配備先にあれば反映済み**とみなす（判定基準がテンプレ本体から導出されるので、別途マーカーを維持しなくてよい）
- `.github/workflows/unity-ci.yml` も**書かない**（初回配置と、内容が同じときを除く）。差分があれば現物を維持して「要マージ」として報告する。CI の走らせ方は配備先の事情（LFS を引くか・トリガー・runner）を抱えるため、黙って巻き戻さない。`.github/` の他の配布物（`scripts/unity-verify.mjs` / `actions/setup-unity-cli/action.yml`）と `Assets/Analyzers/**` は無条件に上書きする
- 公式 unity プラグインを上流から clone（marketplace が pin した sha へ checkout）し、`skills/` `commands/` `agents/` の全件と `LICENSE.md` を `{target}/.claude/` 配下へ配置する（上記 8）
- `{target}/.claude/settings.json` の `skillOverrides` へ、配った skill 名ぶんの `"unity:<name>": "off"` をマージする（他キーは温存。既に値があれば触らない。settings.json が不正な JSON なら見送って続行する）
- `{target}/.claude/sync-setup-state.json`（テンプレート自動追随の状態ファイル）へ `setup-unity` キー（適用時の skill 版 = この SKILL.md の `version:`、有効フラグ = `--architecture`、`unityPlugin` = 配った sha と各種名）をマージ記録する（setup-github のキーは温存）。**settings.json へ書くのは `skillOverrides` だけで、hook は配らない**（上記 9）。ドリフト検知の hook（SessionStart の `sync-setup-check.mjs` と UserPromptSubmit の `sync-setup-prompt.mjs`）は setup-github が配り、この状態ファイルの全キーを見る。したがって Unity プロジェクトの auto-sync には setup-github の導入も必要

### Step 2.5: 要マージのファイルを統合する

apply.mjs の出力に「要マージ」節があれば、`${CLAUDE_PLUGIN_ROOT}/skills/merge-contract.md`
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
入れないと lint-unity が Editor 不要カテゴリだけの縮退動作になり、テストは live Editor へ
走らせられず `unity test` が自分で Editor を起こす形だけになる（Editor を開いていると
exit 6 で断られるので閉じる必要がある）。

```bash
unity pipeline install --project-path {target} --format json
```

- **冪等**。導入済みなら「変更なし」を返すので、条件を取り違えても壊れない
- 終了コードで分岐する:
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
  - **Safe Mode** → 導入の問題ではない。コンパイルエラーを解消する（手順は `unity-cli` skill）
  - **Editor 版が 6.0 未満** → live Editor 操作は使えない。lint-unity は Editor 不要カテゴリのみの縮退動作になる
- **公式 unity プラグインの状態**を伝える（出力の `公式 unity プラグイン:` 行と `プラグイン版の同名 skill（skillOverrides）:` 行）。見送られていたら理由（`git` が無い / clone 失敗）と、解消後の再実行で入る旨を添える
- **警告行が出ていたら必ず伝える**（`直置きでは再現できない構成要素` / `扱いを決めていない要素` / `setup-unity 自前のものと同名`）。いずれも上流の構成が変わった合図で、setup-unity 側の対応が要る
- アーキテクチャ規約の後付けは、再実行してセットアップ質問で選び直せばよい
- **analyzer について**は、次を伝える:
  - 反映には **Unity Editor 側の再コンパイル**が要る（Editor を開いているならフォーカスを戻す）
  - **効いていることを一度確かめる**。選んだ置き場の配下に規約違反（例: `Base` の付かない
    `abstract class`）を一時的に書き、Console に `UCS` 診断が出るのを見てから消す。
    ラベルや配置が崩れていると **診断が 1 件も出ない**＝「違反ゼロ」と見分けが付かないため、
    最初の 1 回だけは陽性を確認する価値がある
  - **severity は Warning 固定で、Error には上げない**。Unity は C# のコンパイルエラーで Safe Mode に
    入るため、命名違反 1 件で Editor が作業不能になる。違反は Editor のコンソールで見て直す
  - 正当な例外は `#pragma warning disable UCS0006` のように範囲を絞って抑制し、理由をコメントに書く
    （配布する `rules/coding-standards.md`「規約の機械チェック」に同じことが書いてある）
- **CI について**は、次を伝える:
  - 見るのは `unity projects verify --strict` だけ。**Editor を起こさないのでライセンスも
    secret も要らない**（Personal のプロジェクトでも動く）
  - **ローカルで撃つ verify と結果が変わる**。ローカルは作業ツリー、CI は追跡されている
    ものだけを見る。空ディレクトリの `.meta` や `.gitignore` された実体はローカルで緑になり
    CI で赤くなる。**CI 側が正しい**
  - **必須チェックに入れてよい**。常に走り skip されないので、パスフィルタ由来の
    「永久に未完了」が起きない（登録するのはリポジトリ側の設定で、このスキルは触らない）
  - **Apple のバンドル形式フォルダの中身は誤検知になる**。Unity は `.xcframework` /
    `.bundle` などをフォルダごと 1 プラグインとして取り込み、`.meta` はフォルダ自身にしか
    付かない。CLI はこれを知らず中の全ファイルを META_MISSING と報告する（実測: AVProVideo
    1 つで 45 件）。CLI 側に除外オプションが無いため `.github/scripts/unity-verify.mjs` が
    JSON を読んで抑止する。落とすのは `.meta` の 2 種類だけで、`CONFLICT_MARKERS` などは
    バンドルの中でも通す
  - **抑止リストは配らない。** 何がバンドル形式かは配備先の `Assets/` が持つ事実で、
    こちらは確かめられない。憶測で配ると、その中の本物の `.meta` 欠落を全配備先で黙って
    隠す。抑止するのは `.github/unity-verify.config.json` に配備先が書いたものだけ
    （テンプレに含まれないファイルなので同期に踏まれない。workflow 本体を書き換えても戻る）
  - **導線はログにある。** 誤検知で落ちたとき、ラッパーが候補の拡張子・確認のしかた・
    貼るだけの JSON を出す。だから配備先はこの SKILL.md を読まなくても直せる — 逆に、
    ここへ手順を書き写すとログ側が正本のまま写しが腐る。**この項を細則で埋めない**
- **テストはローカルで回す。** 回す順序は
  `CLAUDE.md`（レビューの指摘を反映した後）。到達できる Editor があればそれに走らせ、
  無ければ `unity test` が自分で Editor を起こす
- coding-standards / architecture / class-catalog の先頭にある `<!-- agents-md: include -->` は、
  setup-github（--pr-copilot）の AGENTS.md 自動生成が「Copilot code review に教える規約」として
  取り込むための目印。setup-github 未導入なら不活性なだけで無害（導入後の次のコミットで自動反映される）

## 注意

- `skills/` `agents/` は**上書きコピー**される。導入先で手編集していた場合は上書きされる点を伝える。`rules/*.md` だけは上書きせず「要マージ」にして Claude が統合する（Step 2.5）
- `--architecture` から base へ「戻す」機能はない。導入済みなら再実行時に自動で architecture モードが継承される。
  base に戻す場合は `.claude/rules/architecture.md` / `class-catalog.md` を手動削除してから再実行する
- 不明な `--` オプションはエラー終了する（typo で意図しないモードのまま成功しない）。例外は廃止フラグ（`--mcp <値>` / `--analyzer` / `--analyzer-severity=...`。注意を出して無視。上記）
- **Unity 操作のコマンド表を持たない。** Editor が公開するコマンドは Editor 側（`com.unity.pipeline` と
  プロジェクトの `[CliCommand]`）が定義するため、一覧を書くと必ず腐る。CLI 自身の詳細も持たない
  （公式 `unity-cli` skill が正本で、上記 8 が上流版をそのまま配る）
- このスキルは `.claude/settings.json` に触れない。テンプレート自動追随の状態ファイル `.claude/sync-setup-state.json` へは自分のキー（`setup-unity`）だけをマージ記録する（データファイルの更新であり hook 登録ではない）。同期チェック hook 本体（SessionStart / UserPromptSubmit）と settings.json 登録は setup-github が単独で担う（hook の二重管理を作らないため）
- **hook 契約の範囲**: 「settings.json へ恒久登録する hook は配らない」が契約であって、「hook を一切配らない」ではない。`unity-parallel` は自身の SKILL.md frontmatter に PreToolUse hook を持つ。これは **その skill を呼び出したセッションでだけ登録され**、settings.json には現れない。並列作業をしていないセッションの挙動は変わらない
- **`templates/project/` は `.claude/` の外へ出る配置物**（analyzer の DLL と整合性検査の workflow）。
  テンプレ同期の sparse-checkout が `Assets/Analyzers` と `.github` を展開している必要がある
  （`skills/sync-setup/sync-run.mjs`）。配置先を変えるならそちらも合わせる —
  片方だけ変えると同期 PR からその更新だけが静かに落ちる
- **analyzer の配布物はコミット済みの DLL**（`templates/project/Assets/Analyzers/`）。
  ソース（`analyzers/src/`）を変えたら **`npm run build:analyzer` を流してコミットする**。
  流し忘れは `npm test` が `analyzers/dist.json` の sourceHash で検出する。
  規則そのものの正しさは `npm run test:analyzer`（CI の analyzer ジョブ）が見る
- **テンプレート保守（スキル開発者向け）**: `templates/architecture/` の各ファイル（folder-structure / coding-standards）は `templates/base/` の同名ファイルのレイヤー特化版で、architecture モード時に上書き差し替えされる。base 側の規約を変えたら architecture 側にも反映すること（テストの配置・クラス名やアセットのプレフィックスは `rules/folder-structure.md` / `rules/coding-standards.md` / `rules/asset-naming.md` を単一ソースとして参照させ、重複記載を避ける）
