<!-- binding: unity-mcp-official -->
# Unity MCP バインディング表（公式 Unity MCP）

対象実装: **公式 Unity MCP**（`com.unity.ai.assistant` パッケージ同梱の "Unity MCP Server"）

`rules/unity-mcp.md` の方針で使う論理操作を、この実装の具体的なツール呼び出しへ対応付ける表。
skills / agents は操作名（「コンパイル確認」等）でこの表を参照する。

`<!-- core -->` マーカー内の節は setup-unity が `rules/unity-mcp.md` へ合成する（常時コンテキスト）。
それ以外の操作は各 skill 同梱の `references/unity-mcp-tools.md`（この表の全文コピー）経由で遅延参照される。

## この実装の見分け方

- ツール名が **PascalCase の `Unity_` プレフィックス**（`Unity_RunCommand` / `Unity_ManageScene`
  / `Unity_GetConsoleLogs` 等）。セッション上のツールは `mcp__<server>__Unity_*`（`<server>` は `.mcp.json` の
  サーバー名で任意）
- CoplayDev の MCP for Unity（snake_case の `manage_scene` 等 / `mcp-for-unity`）とは別実装

<!-- core: start -->
## 前提（この実装固有）

- Unity アカウントでのサインインが必要。MCP 同時接続数はアカウントの entitlement（プラン）で制限される
- Project Settings > AI > Unity MCP Server で各ツールの有効/無効を切り替える。この表が参照するツールを
  **有効化** しておくこと。既定で有効なのは `Unity_RunCommand` / `Unity_GetConsoleLogs` / キャプチャ系 /
  アセット生成系のみ（2.14 時点）。この表が使う `Unity_FindProjectAssets` / `Unity_ManageScene` /
  `Unity_ManageGameObject` / `Unity_ManageAsset` は**既定で無効**のため有効化が必要

## 失敗判定

- MCP 接続失敗、または `Unity_RunCommand` のレスポンスで **compilation / execution が失敗**
  （コンパイルエラー・実行例外）→ その操作は失敗として扱う
- 参照するツールが Unity 側で無効化されていて呼べない → 失敗（有効化を促す）

## 禁止事項

- `Unity_CreateScript` / `Unity_ManageScript` / `Unity_ApplyTextEdits` / `Unity_ScriptApplyEdits` は使わない。
  スクリプトの新規作成・編集はファイル操作（Write / Edit）で行い、「コンパイル確認」で反映・確認する

## RunCommand の書き方（この実装の基本操作）

`Unity_RunCommand` の C# は `internal class CommandScript : IRunCommand`（クラス名固定・`internal` 必須）で書く。
オブジェクトを作成・変更・削除する場合は `result.RegisterObjectCreation(obj)` /
`result.RegisterObjectModification(obj)`（変更前に呼ぶ）/ `result.DestroyObject(obj)` を使う
（Undo 登録。`Object.DestroyImmediate` を直接呼ばない）。結果は `result.Log(...)` で返す。

## コンパイル確認

実装ファイルの Write / Edit 後、同一レスポンス内で次を実行する:

```
Unity_RunCommand Code="using UnityEditor; using UnityEditor.Compilation; internal class CommandScript : IRunCommand { public void Execute(ExecutionResult result) { AssetDatabase.Refresh(); CompilationPipeline.RequestScriptCompilation(); result.Log(\"recompile requested\"); } }"
Unity_GetConsoleLogs logTypes="error" maxEntries=50 includeStackTrace=true
```

- 注意: スクリプト再コンパイルはドメインリロードを伴い **非同期**。`RequestScriptCompilation` 直後に
  読むと結果が揃わないことがある。エラーが出ないはずの変更で Console にエラーが残る／`Unity_RunCommand`
  がリロードで途中終了する場合は、少し置いて再度「コンソールエラー取得」で確認する

## コンソールエラー取得

```
Unity_GetConsoleLogs logTypes="error" maxEntries=<件数（既定 20・上限 200）> includeStackTrace=true
```

- `logTypes` はカンマ区切り（`"info,warning,error"`、大文字小文字不問）。`maxEntries` は 200 で切り詰められる
<!-- core: end -->

## 操作（skill 専用・遅延参照）

### テスト実行

- **未対応**（この実装にはテストランナー専用ツールが無い）。`Unity_RunCommand` は同期実行で、
  `TestRunnerApi` は複数フレームにまたぐ非同期コールバックのため、RunCommand 内でテストを起動しても
  結果を同一呼び出しで回収できない
- テスト運用が必要なプロジェクトでは、テストランナー対応の実装（`mcp-for-unity` = CoplayDev の MCP for Unity）へ
  乗り換える（`setup-unity` を再実行し、セットアップ質問でバインディング `mcp-for-unity` を選ぶ）か、
  Unity の Test Runner を手動実行する

### テスト結果取得

- **未対応**（「テスト実行」と同じ理由）

### アセット検索

```
Unity_FindProjectAssets
```

- 確実な代替（下記「読み取り系の一般代替」）: `Unity_RunCommand` で `AssetDatabase.FindAssets(...)`

### シーン階層取得

```
Unity_ManageScene   # 階層取得アクション。パラメータは接続後にツール schema で確認する
```

### GameObject 検索（コンポーネント指定）

```
Unity_ManageGameObject   # コンポーネント指定検索。パラメータはツール schema で確認する
```

### コンポーネント詳細取得

`Unity_ManageGameObject` で対象 GameObject のコンポーネント/プロパティを取得する。
パラメータはツール schema で確認する。

### Prefab 検査

```
Unity_ManageAsset   # Prefab の階層・情報取得。パラメータはツール schema で確認する
```

### Material 検査

```
Unity_ManageAsset   # Material の取得・プロパティ確認。パラメータはツール schema で確認する
```

## 読み取り系の一般代替（Unity_RunCommand）

`Unity_ManageScene` / `Unity_ManageGameObject` / `Unity_ManageAsset` の各アクションのパラメータが
不明・未有効の場合、読み取り（検索・階層取得・コンポーネント/Prefab/Material 検査）は
**`Unity_RunCommand` の C# で確実に代替できる**（書き方は「RunCommand の書き方」節）:

- アセット検索: `AssetDatabase.FindAssets("t:Prefab")` 等
- シーン階層: `UnityEngine.SceneManagement.SceneManager.GetActiveScene().GetRootGameObjects()` を再帰
- GameObject 検索: `Object.FindObjectsByType<T>(FindObjectsSortMode.None)`
- コンポーネント/Prefab/Material: 対象を `AssetDatabase.LoadAssetAtPath` 等でロードしてプロパティを列挙
