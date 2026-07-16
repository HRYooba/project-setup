---
name: lint-unity
description: >
  このスキルは、ユーザーが「lint実行」「アセットチェック」「シーン検証」「Prefab検証」「ルールチェック」
  「命名規則チェック」「/lint-unity」と依頼した場合に使用される。
  Unityアセット・シーン・Prefabのルール準拠チェック（lint）を実行する。
  シーン名、Prefabパス、`--scene`、`--prefabs`、`--assets` をサポート。
version: 1.0.0
context: fork
agent: unity-linter
---

# Unity Asset & Scene Lint

**引数**: $ARGUMENTS

チェック項目の定義は `references/checklist.md` が正。このファイルは実行フローのみを定義する。

MCP ツールの具体的な呼び出し（ツール名・パラメータ・失敗判定）は
`.claude/skills/lint-unity/references/unity-mcp-tools.md`（この skill 同梱のバインディング表）が正。
以下の手順は操作名（「アセット検索」等）で表を参照する。
表の内容がコンテキストに無ければ Turn 1 で Read する。

## 呼び出しパターン

| パターン | 実行カテゴリ |
|---|---|
| `--scene <名前>` | B, C, D, G, I, J |
| `--prefabs` | A, C, F, G, J |
| `--assets <パス>` | A, E, J |
| `--all` | A〜J 全て |
| `.prefab` ファイルパス | A, C, F, G, J |
| 引数なし | 未コミット変更から自動検出 |

**除外:** `Assets/ThirdParty/`（E1のみ例外）、`Assets/Plugins/`、`Library/`、`Packages/`

## ターン実行計画

| Turn | ステップ | 並列呼び出し内容 |
|:-----|:---------|:----------------|
| 1 | Step 1 | バインディング表 Read + git diff x3（並列） |
| 2 | Step 2 グループ1 | 全カテゴリの初回データ取得（並列） |
| 3 | Step 2 グループ2 | グループ1依存の追加データ取得（並列） |
| 4 | Step 3 | レポート出力 |

---

### Step 1: 準備 [Turn 1]

引数をパースし、スコープと実行カテゴリを決定する。

default branch は `git symbolic-ref --short refs/remotes/origin/HEAD` で検出する
（失敗時は `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`。以下 `<default>` と表記）。

以下を並列で呼び出し、結果を合算・重複除去:
```
Read: .claude/skills/lint-unity/references/unity-mcp-tools.md（バインディング表。コンテキストに読込済みなら省略可）
Bash: git symbolic-ref --short refs/remotes/origin/HEAD && git diff --name-only origin/<default>...HEAD -- '*.unity' '*.prefab' '*.asset' '*.mat' '*.anim' '*.controller' '*.shadergraph' '*.shader' '*.hlsl' '*.vfx' '*.renderTexture' '*.playable' '*.asmdef' '*.png' '*.jpg' '*.tga' '*.exr' '*.wav' '*.mp3' '*.ogg'
Bash: git diff --name-only HEAD -- (同上)
Bash: git ls-files --others --exclude-standard -- (同上)
```

引数なし時は拡張子でカテゴリ自動選択:

| 拡張子 | カテゴリ |
|---|---|
| `.unity` | B, C, D, G, I, J |
| `.prefab` | A, C, F, G, J |
| `.mat` | A, E, J |
| `.asset`/`.anim`/`.controller`/`.shadergraph`/`.shader`/`.hlsl`/`.vfx`/`.renderTexture`/`.playable` | A, E |
| `.png`/`.jpg`/`.tga`/`.exr` | A, E |
| `.wav`/`.mp3`/`.ogg` | A, E |
| `.asmdef` | H |

変更アセットなし → 「lint対象の変更アセットがありません」で停止。

### Step 2: チェック実行 [Turn 2-3]

**グループ1: 初回データ取得**（全て1レスポンスにまとめて呼び出す）

| カテゴリ | 操作（バインディング表） |
|---|---|
| [A] Asset Naming | アセット検索 |
| [B] Hierarchy | シーン階層取得 |
| [D] Scene Config | GameObject 検索（Camera, Light, EventSystem） |
| [E] Folder | アセット検索 |
| [F] Prefab | Prefab 検査 |
| [H] asmdef | `Glob` + `Read`（MCP 不使用） |
| [I] Canvas | GameObject 検索（Canvas） |
| [J] Material | GameObject 検索（Renderer） |

**グループ2: 追加データ取得**

| カテゴリ | 操作（バインディング表） |
|---|---|
| [C] SerializeField | コンポーネント詳細取得（バッチ10件） |
| [G] Component | グループ1の GameObject に対しコンポーネント詳細取得 |
| [J] Material | グループ1の Renderer 結果から Material 検査 |

**注意事項:**
- [A] Texture/Sprite は `textureType` で判別。SE/BGM はフォルダ名推測（不明は INFO）
- [G] Missing（参照破損）= ERROR、未設定（None）= WARNING
- [H] 参照グラフ構築。循環・欠損 GUID 検出
- [J] `InternalErrorShader` = 壊れたシェーダー

チェック項目・severity は `references/checklist.md` に従う。

### Step 3: レポート出力 [Turn 4]

**重複抑制:** 同一問題は具体的なカテゴリ側のみ報告。

```markdown
## Unity Lint レポート

### 概要
- **対象範囲**: {対象}
- **検出件数**: N（ERROR: X, WARNING: Y, INFO: Z）

### 検出結果
#### [{ID}] {カテゴリ名}
| severity | オブジェクト/アセット | 内容 | ルール |
|----------|-------------|-------|------|

### 総評
_(総評)_
```
