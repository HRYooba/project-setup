---
name: lint-unity
description: >
  このスキルは、ユーザーが「lint実行」「アセットチェック」「シーン検証」「Prefab検証」「ルールチェック」
  「命名規則チェック」「/lint-unity」と依頼した場合に使用される。
  Unityアセット・シーン・Prefabのルール準拠チェック（lint）を実行する。
  シーン名、Prefabパス、`--scene`、`--prefabs`、`--assets` をサポート。
version: 2.2.0
context: fork
agent: unity-linter
---

# Unity Asset & Scene Lint

**引数**: $ARGUMENTS

チェック項目の定義は `references/checklist.md` が正。このファイルは実行フローのみを定義する。

Unity 操作の方針・失敗判定・コマンドの発見手順は `.claude/rules/unity-cli.md` が正。

## Editor が要るチェックと要らないチェック

`references/checklist.md` の各カテゴリには **Editor 依存** の区分がある。

- **Editor 不要**（[E] / [H] / ファイル名で判定できる [A] の一部）は `Glob` / `Read` だけで完結する
- **Editor 必須**（[B] [C] [D] [F] [G] [I] [J]）は live Editor が要る

**Editor に到達できないときは、Editor 不要のカテゴリだけ実行して完走する。**
「Editor が無いので lint できません」で終わらせない（何も報告しないより、半分報告するほうが役に立つ）。
レポートには実行できなかったカテゴリを**未検査として明示**する。

## 呼び出しパターン

| パターン | 実行カテゴリ |
|---|---|
| `--scene <名前>` | B, C, D, G, I, J |
| `--prefabs` | A, C, F, G, J |
| `--assets <パス>` | A, E, J |
| `--all` | A〜J 全て |
| `.prefab` ファイルパス | A, C, F, G, J |
| 引数なし | 未コミット変更から自動検出 |

プロジェクト整合性（`unity projects verify`）はこの skill では見ない。
`.github/workflows/unity-ci.yml` の verify ジョブが担う（同じ検査を 2 箇所で走らせない）。

**除外:** `Assets/ThirdParty/`（E1のみ例外）、`Assets/Plugins/`、`Library/`、`Packages/`

## ターン実行計画

| Turn | ステップ | 並列呼び出し内容 |
|:-----|:---------|:----------------|
| 1 | Step 1 | 到達性判定 + git diff x3（並列） |
| 2 | Step 2 グループ1 | Editor 依存カテゴリの初回データ取得（並列） |
| 3 | Step 2 グループ2 | グループ1依存の追加データ取得（並列） |
| 4 | Step 3 | レポート出力 |

---

### Step 1: 準備と対象決定 [Turn 1]

引数をパースし、スコープと実行カテゴリを決定する。

default branch は `git symbolic-ref --short refs/remotes/origin/HEAD` で検出する
（失敗時は `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`。以下 `<default>` と表記）。

以下を並列で呼び出す:
```
Bash: unity pipeline list --format json
Bash: git symbolic-ref --short refs/remotes/origin/HEAD && git diff --name-only origin/<default>...HEAD -- '*.unity' '*.prefab' '*.asset' '*.mat' '*.anim' '*.controller' '*.shadergraph' '*.shader' '*.hlsl' '*.vfx' '*.renderTexture' '*.playable' '*.asmdef' '*.png' '*.jpg' '*.tga' '*.exr' '*.wav' '*.mp3' '*.ogg'
Bash: git diff --name-only HEAD -- (同上)
Bash: git ls-files --others --exclude-standard -- (同上)
```

- `unity pipeline list` の結果で **Editor 到達性**を決める（`rules/unity-cli.md`「前提の確認」の表）。
  **exit code で判断しない** — 到達不可でも exit 0 / `success: true` を返す。
  `data.instances[].pipelineServer.isReachable` を見る。到達不可なら Editor 依存カテゴリを未検査に落とす。
  Safe Mode（`data.summary.instancesInSafeMode > 0`）なら、**lint より先にコンパイルエラーの解消が要る**旨を
  レポート冒頭に書く（`rules/unity-cli.md`「Safe Mode」）

git 3 件を合算・重複除去。引数なし時は拡張子でカテゴリ自動選択:

| 拡張子 | カテゴリ |
|---|---|
| `.unity` | B, C, D, G, I, J |
| `.prefab` | A, C, F, G, J |
| `.mat` | A, E, J |
| `.asset`/`.anim`/`.controller`/`.shadergraph`/`.shader`/`.hlsl`/`.vfx`/`.renderTexture`/`.playable` | A, E |
| `.png`/`.jpg`/`.tga`/`.exr` | A, E |
| `.wav`/`.mp3`/`.ogg` | A, E |
| `.asmdef` | H |

変更アセットが無ければ「対象なし」と報告して終わる。

### Step 2: Editor 依存チェック [Turn 2-3]

Editor に到達できない場合はこの Step を飛ばす。

**必要なコマンドは推測せず発見する**（`rules/unity-cli.md`「コマンドは表で覚えず発見する」）。
発見は**カタログ 1 本**で足りる。カテゴリごとに `--query` を撃ち分けない（同じカタログを何度も引くだけ）:

```
Bash: unity command --format json
```

発見できた範囲で、下表の情報を取得する。**発見できなかった項目は未検査として報告する**
（代わりにシリアライズファイルを直読みして判定しない — `.unity` / `.prefab` の YAML から
参照の生死を判断するのは誤判定の温床）。

**グループ1: 初回データ取得**（1 レスポンスにまとめる）

| カテゴリ | 必要な情報 |
|---|---|
| [A] Asset Naming | アセット一覧（種別と Texture/Sprite 判別） |
| [B] Hierarchy | 対象シーンの階層 |
| [D] Scene Config | Camera / Light / EventSystem の有無 |
| [E] Folder | アセットのパス一覧（`Glob` でも可） |
| [F] Prefab | Prefab の階層と情報 |
| [H] asmdef | `Glob` + `Read`（Editor 不要） |
| [I] Canvas | Canvas の一覧とコンポーネント |
| [J] Material | Renderer の一覧 |

**グループ2: 追加データ取得**

| カテゴリ | 必要な情報 |
|---|---|
| [C] SerializeField | グループ1の GameObject のコンポーネント詳細 |
| [G] Component | グループ1の GameObject のコンポーネント詳細 |
| [J] Material | グループ1の Renderer から Material の詳細 |

**注意事項:**
- [A] Texture/Sprite は `textureType` で判別。SE/BGM はフォルダ名推測（不明は INFO）
- [G] Missing（参照破損）= ERROR、未設定（None）= WARNING
- [H] 参照グラフ構築。循環・欠損 GUID 検出
- [J] `InternalErrorShader` = 壊れたシェーダー

チェック項目・severity は `references/checklist.md` に従う。

### Step 3: レポート出力 [Turn 4]

**重複抑制:** 同一問題は具体的なカテゴリ側のみ報告する。

```markdown
## Unity Lint レポート

### 概要
- **対象範囲**: {対象}
- **Editor 到達性**: {到達 / 未到達（理由）/ Safe Mode}
- **検出件数**: N（ERROR: X, WARNING: Y, INFO: Z）
- **未検査カテゴリ**: {ID 一覧と理由（Editor 未到達 / コマンド未発見）。無ければ「なし」}

### 検出結果
#### [{ID}] {カテゴリ名}
| severity | オブジェクト/アセット | 内容 | ルール |
|----------|-------------|-------|------|

### 総評
_(総評)_
```

**未検査カテゴリを空欄にしない。** 「検出 0 件」と「見ていない」を混同させると、レポートが
green の根拠として誤用される。
