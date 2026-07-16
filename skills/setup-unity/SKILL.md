---
name: setup-unity
description: >
  現在の Unity プロジェクトに開発規約一式（rules / test-unity / lint-unity / サブエージェント）を
  導入するセットアップコマンド。ユーザーが「Unityセットアップ」「setup-unity」「Unity規約を導入」
  「このプロジェクトにUnity開発ルールを入れて」などと依頼したときに使用する。
  カレントのリポジトリの .claude/ に rules（unity-mcp / folder-structure / hierarchy /
  asset-naming / coding-standards / testing）、skills（test-unity / lint-unity）、
  agents（unity-tester / unity-linter）を撒く。レイヤードアーキテクチャ規約
  （architecture / class-catalog）の導入有無と MCP バインディングは、
  実行時に AskUserQuestion で確認する。
version: 1.5.0
user-invocable: true
argument-hint: "[導入先ディレクトリ（省略時はカレント）]"
---

# Unity 開発規約のセットアップ

このコマンドは、対象 Unity プロジェクトに次を**冪等に**インストールする（再実行安全）:

1. **rules** — `unity-mcp.md`（Unity 操作の絶対ルール + バインディング表の常時節を合成）/ `folder-structure.md` / `hierarchy.md` / `asset-naming.md` / `coding-standards.md` / `testing.md`
2. **test-unity** — 変更差分のテスト責任判定・設計・実装・重複整理・実行（skill + `unity-tester` agent + 設計/実装ガイド）
3. **lint-unity** — アセット・シーン・Prefab のルール準拠チェック（skill + `unity-linter` agent + チェックリスト）
4. **（architecture モード。質問で「入れる」を選んだ場合）** — レイヤードアーキテクチャ規約（`architecture.md` / `class-catalog.md`）+ レイヤー前提版の folder-structure / coding-standards / testing / テスト設計ガイドへの差し替え（lint チェックリストは base に統合済み。層依存チェック項目は「architecture 導入時のみ」として base 側に載る）

## 前提（満たされていないと skills が動かない）

- 対象が Unity プロジェクトである（`ProjectSettings/ProjectVersion.txt` が存在する）
- **Unity 向け MCP が接続済み**で、その実装のバインディング表が `bindings/` にある
  （test-unity / lint-unity は各 skill 同梱の `references/unity-mcp-tools.md`（表の全文コピー）経由で MCP ツールを使う。対応実装は `bindings/` にある表がすべて。各表が対象実装・見分け方・未対応の操作を自己記述する）
- Node.js が利用可能
- 規約はアプリ本体を **`Assets/App/`** 配下に置く前提（UniTask / R3 / VContainer スタックを想定）

## 手順

### Step 1: 導入先の確認とセットアップ質問

- 引数があればそのディレクトリ、なければカレントを導入先とする
- `ProjectSettings/ProjectVersion.txt` の存在で Unity プロジェクトであることを確認する
- 質問の準備として以下を調べる:
  - **Unity MCP 実装の自動特定**: 接続中のツール一覧（`mcp__<server>__*` プレフィックス）や対象の `.mcp.json` を、各 `bindings/*.md` の「この実装の見分け方」節と突き合わせて特定する（実装名と見分け方は SKILL.md に直書きしない。新実装への対応が表の追加だけで完結するように保つ）
  - **再実行時の現在値**: `.claude/rules/architecture.md` の有無（architecture モード導入済みか）、配備済み `.claude/rules/unity-mcp.md` 先頭の `<!-- binding: <name> -->` マーカー（旧配置 `.claude/rules/unity-mcp-tools.md` しか無い場合はそちらのマーカー）
  - `Assets/App/` の有無
- **セットアップ質問**: 下表の項目を **AskUserQuestion 1 回にまとめて必ず確認**する。ユーザーからオプションフラグは受け取らない（依頼文に書かれていても、再実行でも質問は省略しない）。回答から Claude が apply.mjs のフラグを組み立てる。**再実行時は現在値を「現在のまま維持」として推奨選択肢の先頭に置く**。質問の直前に、調べた現状（MCP 特定結果・現在値・Assets/App の有無）を本文テキストで提示する

| 項目 | 質問内容 | 選択肢 |
|:---|:---|:---|
| アーキテクチャ規約 | レイヤードアーキテクチャ規約（architecture / class-catalog + レイヤー前提の各規約差し替え）を入れるか | 入れる / 入れない。導入済みリポジトリで「入れない」が選ばれた場合は、巻き戻しに `.claude/rules/architecture.md` / `class-catalog.md` の手動削除が必要な旨を伝えて意思を再確認する（apply.mjs は導入済みなら自動継承するため） |
| MCP バインディング | どの Unity MCP 実装のバインディング表を使うか。自動特定の結果を推奨選択肢にする | `bindings/` にある表を列挙（表内に「未対応」の操作がある実装は、その影響（例: テスト実行未対応 → test-unity 不可）を選択肢の説明に書く）/ 対応表が無い実装（`bindings/<name>.md` の**追加**が必要な旨を案内。既存の表は書き換えず、先頭行に `<!-- binding: <name> -->`、既存表と同じ操作名一式を定義する） |
| Assets/App（無い場合のみ） | 規約は `Assets/App/` 前提。無いまま続行するか（新規プロジェクトならこれから作ればよい。既存の別ルート構成なら導入後に規約か構成のどちらかを合わせる必要がある） | 続行 / 中止 |

- 回答 → フラグ変換: アーキテクチャ「入れる」= `--architecture` / バインディング = `--mcp <binding>`

### Step 2: インストール実行

以下を実行する（`{target}` は導入先。省略時はカレント）:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/setup-unity/apply.mjs" {target} [--architecture] [--mcp <binding>]
```

apply.mjs が次を行う:
- `templates/base/` を `{target}/.claude/`（`rules/` `skills/` `agents/`）へ再帰コピー
- 選択されたバインディング表（`bindings/<binding>.md`）を二層で配置
  （常時層: 表の core 節を `rules/unity-mcp.md` へ合成 / 遅延層: 表の全文を `skills/test-unity/references/` と
  `skills/lint-unity/references/` の `unity-mcp-tools.md` へコピー。旧配置 `rules/unity-mcp-tools.md` は削除。
  `--mcp` 省略時は導入済みの表を継承、初回は `mcp-for-unity`）
- `--architecture` 時は `templates/architecture/` を上から上書きコピー
  （architecture / class-catalog の追加 + folder-structure / coding-standards / testing / test-designing-guide のレイヤー版差し替え。lint checklist は base に統合済みなので差し替えない）
- **architecture 導入済みの検知**: `.claude/rules/architecture.md` が既にあれば、`--architecture` 指定なしでも architecture モードを自動継承する（レイヤー版規約が base 版に巻き戻るのを防止）
- `{target}/.claude/CLAUDE.md` に開発ワークフロー節（コンパイル確認・`/test-unity`・`/lint-unity` の参照）を追記（`/test-unity` の記載が既にあればスキップ。ファイルが無ければ新規作成）

### Step 3: 結果報告

apply.mjs の出力（配置ファイル一覧・モード）をそのまま伝える。併せて次を案内する:

- 反映には**新しいセッションでの再読み込みが必要**（rules・skill・agent はセッション開始時に読み込まれる）
- Unity 向け MCP が未導入なら test-unity / lint-unity は動かないため、導入を案内する
- 別の Unity MCP 実装への乗り換えもアーキテクチャ規約の後付けも、再実行してセットアップ質問で選び直せばよい
- `rules/testing.md` の「既知失敗テスト」欄は空で配置される。常に失敗する既知テスト（外部アセット欠落等）が
  あるプロジェクトでは、この欄に記録すると test-unity の green/red 判定から除外される
- coding-standards / architecture / class-catalog の先頭にある `<!-- agents-md: include -->` は、
  setup-github（--pr-copilot）の AGENTS.md 自動生成が「Copilot code review に教える規約」として
  取り込むための目印。setup-github 未導入なら不活性なだけで無害（導入後の次のコミットで自動反映される）

## 注意

- テンプレートは**上書きコピー**される。導入先で rules / skills / agents を手編集していた場合は上書きされる点を伝える
- `--architecture` から base へ「戻す」機能はない。導入済みなら再実行時に自動で architecture モードが継承される。
  base に戻す場合は `.claude/rules/architecture.md` / `class-catalog.md` を手動削除してから再実行する
- 不明な `--` オプション・未対応の `--mcp` 値はエラー終了する（typo で意図しないモードのまま成功しない）
- 新しい Unity MCP 実装への対応は `bindings/` への表の**追加**で行う（既存の表は書き換えない）。
  表には「この実装の見分け方」節と、既存表と同じ操作名一式（コンパイル確認 / コンソールエラー取得 /
  テスト実行 / テスト結果取得 / アセット検索 / シーン階層取得 / GameObject 検索 / コンポーネント詳細取得 /
  Prefab 検査 / Material 検査 / 失敗判定 / 禁止事項）を定義する。実装に無い操作も省略せず「未対応」と
  明記する（セットアップ質問が選択肢の説明に反映する）。常時必要な節（失敗判定 / 禁止事項 /
  コンパイル確認 / コンソールエラー取得と、実装固有の前提・書き方）は `<!-- core: start -->` 〜
  `<!-- core: end -->` で囲む（apply.mjs が `rules/unity-mcp.md` へ合成する。無いとエラー終了）
- このスキルは `.claude/settings.json` に触れない（hook 登録なし）
- **テンプレート保守（スキル開発者向け）**: `templates/architecture/` の各ファイル（folder-structure / coding-standards / testing / test-designing-guide）は `templates/base/` の同名ファイルのレイヤー特化版で、architecture モード時に上書き差し替えされる。base 側の規約を変えたら architecture 側にも反映すること（テスト設計ガイドの「テスト責任」「禁止する低品質テスト」一覧やアセットのプレフィックスは、`rules/testing.md` / `rules/asset-naming.md` を単一ソースとして参照させ、重複記載を避ける）
- CLAUDE.md の「## 開発ワークフロー」節は、既存の同見出しがあればその節へマージする（無ければ新設）ため、他ツールが同じ見出しを使っても重複しない。マージ処理 `upsertWorkflowSection` は apply.mjs に内包（外部モジュールに依存せずスキル単体で動く）
