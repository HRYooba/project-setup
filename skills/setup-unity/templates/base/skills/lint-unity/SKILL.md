---
name: lint-unity
description: >
  `Assets/App/` 配下のアセット・シーン・Prefab・マテリアル・asmdef を変更したら、PR を作る前に
  **ユーザーの依頼を待たずに実行する**。Unity のアセット命名・ヒエラルキー・シーン構成・
  Prefab 整合性・フォルダ構成・SerializeField 参照・asmdef 依存・マテリアルが規約に沿っているかを
  検査してレポートする。範囲は `--scene <名前>` / `--prefabs` / `--assets <パス>` / `--all` で絞れる。
version: 3.0.0
paths: Assets/App/**
context: fork
agent: unity-linter
---

# Unity Asset & Scene Lint

**引数**: $ARGUMENTS（無ければ変更から自動検出）

チェック項目と severity は `references/checklist.md` が正。ここは流れだけを定義する。

**対象は `Assets/App/` 配下だけ。** 外部アセットの置き場（`Assets/ThirdParty/`
`Assets/Plugins/` `Packages/`）は数え上げられないので、除外リストは作らない。
プロジェクト整合性（`unity projects verify`）は見ない — CI が担う。

## Step 1: 対象と到達性を決める

並列で呼ぶ（`<default>` は `git symbolic-ref --short refs/remotes/origin/HEAD`。
取れなければ `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`）:

```
Bash: unity pipeline list --format json
Bash: git diff --name-only origin/<default>...HEAD -- 'Assets/App'
Bash: git diff --name-only HEAD -- 'Assets/App'
Bash: git ls-files --others --exclude-standard -- 'Assets/App'
```

- 到達性は `data.instances[].pipelineServer.isReachable` で決める。**exit code で決めない**
  — 到達不可でも exit 0 / `success: true` を返す
- Safe Mode（`data.summary.instancesInSafeMode > 0`）なら、**lint より先にコンパイルエラーの
  解消が要る**旨をレポート冒頭に書く
- git 3 件を合算・重複除去。**下表に無い拡張子は無視する**（`.cs` / `.md` 等）

| 拡張子 | カテゴリ |
|---|---|
| `.unity` | B, C, D, G, I, J |
| `.prefab` | A, C, F, G, J |
| `.mat` | A, E, J |
| `.asset`/`.anim`/`.controller`/`.shadergraph`/`.shader`/`.hlsl`/`.vfx`/`.renderTexture`/`.playable` | A, E |
| `.png`/`.jpg`/`.tga`/`.exr` | A, E |
| `.wav`/`.mp3`/`.ogg` | A, E |
| `.asmdef` | H |

引数で範囲を指定されたとき: `--scene` → B/C/D/G/I/J、`--prefabs` と `.prefab` パス →
A/C/F/G/J、`--assets` → A/E/J、`--all` → 全カテゴリ。

対象が無ければ「対象なし」で終わる。

## Step 2: データを取る

**検査するのは Step 1 で検出したファイルだけ。** `Assets/App/` 全体を毎回走査しない
（差分に無い違反を報告しても、その PR では直せない）。カテゴリごとの対象はこうなる。

| カテゴリ | 見る範囲 |
|:--|:--|
| [A] 命名 / [E] フォルダ | 検出したアセットそのもの |
| [B] 階層 / [D] シーン構成 / [I] Canvas | 検出した `.unity` のシーンだけ |
| [C] SerializeField / [G] コンポーネント / [J] Material | 検出したシーン・Prefab の中のオブジェクトだけ |
| [F] Prefab 整合性 | 検出した `.prefab` だけ |
| [H] asmdef | 循環検出にはグラフ全体が要るので全 asmdef を読む。**報告は検出した asmdef に関わるものだけ** |

全体を見たいときは `--all` を明示的に渡す。

[E] [H] とファイル名で判定できる [A] は `Glob` / `Read` で完結する。残り（[B] [C] [D] [F]
[G] [I] [J]）は live Editor が要るので、到達できないなら飛ばす。

`unity command --format json` を **1 回だけ**引いてカタログを取り、必要な名前をそこから拾う
（カテゴリごとに `--query` を撃ち分けない。同じカタログを何度も引くだけ）。

**発見できなかった項目は未検査として報告する。** 代わりに `.unity` / `.prefab` の YAML を
直読みして判定しない — 参照の生死を YAML から判断するのは誤判定の温床。

GameObject / Renderer の一覧を先に取り、コンポーネント詳細と Material 詳細はその結果を
使って次のレスポンスでまとめて取る。

## Step 3: レポート

同一問題は具体的なカテゴリ側だけで報告する（重複抑制）。

```markdown
## Unity Lint レポート

### 概要
- **対象範囲**: {検出したファイルの一覧（または --all）}
- **Editor 到達性**: {到達 / 未到達（理由）/ Safe Mode}
- **検出件数**: N（ERROR: X, WARNING: Y, INFO: Z）
- **未検査カテゴリ**: {ID と理由（Editor 未到達 / コマンド未発見）。無ければ「なし」}

### 検出結果
#### [{ID}] {カテゴリ名}
| severity | オブジェクト/アセット | 内容 | ルール |
|----------|-------------|-------|------|

### 総評
_(総評)_
```

**未検査カテゴリを空欄にしない。** 「検出 0 件」と「見ていない」を混同させると、
レポートが green の根拠として誤用される。
