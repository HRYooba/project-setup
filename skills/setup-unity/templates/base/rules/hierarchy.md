# Hierarchy ルール

Unity シーンのヒエラルキー構成・GameObject 命名時に従うルール。
シーンや Prefab の作成・編集、GameObject の配置・命名時に適用する。

## オブジェクト命名

- **PascalCase** で統一（例: `PlayerCharacter`, `MainCamera`）
- 同一オブジェクトが複数ある場合は `_` + 2桁連番（例: `Enemy_01`, `Enemy_02`）

## ルートオブジェクト（コンテナ）

- ヒエラルキー最上位には整理用の空オブジェクトを配置
- 名称を `[]` で囲む（`[]` を付けるのは**ルートのみ**。中間コンテナは通常の PascalCase）
- 全オブジェクトは適切なルートオブジェクトの子階層に配置（ルート直下に散乱させない）
- ルートオブジェクト数は 7 個程度を目安に抑える（厳密な上限ではなく、必要なら例外も可）

## 階層構造の例

```
[System]
  Managers/
    AudioManager
[World]
  Environment/
    DirectionalLight
    Floor_01
[UI]
  HudUIDocument
  SystemMenuUIDocument
```
