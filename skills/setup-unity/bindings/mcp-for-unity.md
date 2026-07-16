<!-- binding: mcp-for-unity -->
# Unity MCP バインディング表（MCP for Unity）

対象実装: **MCP for Unity**（CoplayDev/unity-mcp、サーバー名 `UnityMCP`）

`rules/unity-mcp.md` の方針で使う論理操作を、この実装の具体的なツール呼び出しへ対応付ける表。
skills / agents は操作名（「コンパイル確認」等）でこの表を参照する。

`<!-- core -->` マーカー内の節は setup-unity が `rules/unity-mcp.md` へ合成する（常時コンテキスト）。
それ以外の操作は各 skill 同梱の `references/unity-mcp-tools.md`（この表の全文コピー）経由で遅延参照される。

## この実装の見分け方

- `.mcp.json` のサーバー名が `UnityMCP`（セッション上のツールは `mcp__UnityMCP__*`）
- ツール名が **snake_case**（`manage_scene` / `read_console` / `run_tests` 等）。
  公式 Unity MCP（PascalCase の `Unity_*` / com.unity.ai.assistant）とは別実装

<!-- core: start -->
## 失敗判定

- MCP 接続失敗、またはレスポンスが `"success": false` → その操作は失敗として扱う

## 禁止事項

- `create_script` は使わない。スクリプトの新規作成・編集はファイル操作（Write / Edit）で行い、「コンパイル確認」で反映・確認する

## コンパイル確認

実装ファイルの Write / Edit 後、同一レスポンス内で:

```
mcp__UnityMCP__refresh_unity mode="force" scope="all" compile="request" wait_for_ready=true
mcp__UnityMCP__read_console action="get" types=["error"] count=50
```

## コンソールエラー取得

```
mcp__UnityMCP__read_console action="get" types=["error"] count=<件数（既定 20）>
```
<!-- core: end -->

## 操作（skill 専用・遅延参照）

### テスト実行

```
mcp__UnityMCP__run_tests mode="EditMode" assembly_names=["<テスト assembly>"] include_failed_tests=true include_details=false
```

### テスト結果取得

```
mcp__UnityMCP__get_test_job job_id=<run_tests の job_id> wait_timeout=60 include_failed_tests=true include_details=true
```

### アセット検索

```
manage_asset action="search" page_size=50
```

### シーン階層取得

```
manage_scene action="get_hierarchy" page_size=50
```

### GameObject 検索（コンポーネント指定）

```
find_gameobjects by_component="<コンポーネント名>"
```

### コンポーネント詳細取得

`find_gameobjects` の結果に対して `include_properties=true`（`page_size=5〜10`）で取得する。
または GameObject の component resource を読む。

### Prefab 検査

```
manage_prefabs action="get_hierarchy"   # 階層
manage_prefabs action="get_info"        # 情報
```

### Material 検査

```
manage_material
```
