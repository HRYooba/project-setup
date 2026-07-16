# フォルダ構成

アプリ本体のアセット・コードはすべて `Assets/App/` 配下に置く。

`Assets/` 以下の主要な構成は以下の通りです。

## Assets/App/

### Scripts/
- `Shared/`
- `Domain/`
- `Application/`
- `Infrastructure/`
- `Presentation/`
- `Composition/`
- `Tests/EditMode/`  

**フォルダパス はnamespaceと一致させる** (C# 標準慣習)

### Editor/
- Editor 専用コード・設定の集約フォルダ。Editor 専用 asmdef（`includePlatforms: ["Editor"]`、例: `<Project>.Editor`）配下
- `Scripts/`: Editor 専用クラス
- `Settings/`: Editor 専用 ScriptableObject アセット。`Editor/` フォルダ規約により Player Build に物理的に含まれない

### その他
- `Scenes/`: シーンアセット
- `Settings/`: 設定ファイル (ScriptableObject、Runtime からも参照される)
- `UI/`: UI Toolkit アセット（`UXML/` / `USS/` / `Sprites/` / `Fonts/` / `PanelSettings/`）
- `Prefabs/`: Prefab アセット
- `Audio/`: オーディオアセット（SE / BGM）
- `Animations/`: Animation Clip / Animator Controller
- `Textures/`: テクスチャアセット（UI 用スプライトは `UI/Sprites/` に置く）
- `Materials/`: マテリアルアセット
- `Shaders/`: シェーダーアセット
- `Meshes/`: メッシュ・3D モデルアセット（`.fbx` 等のインポート元）
- `VisualEffects/`: VFXアセット
- `RenderTextures/`: RenderTexture

## Assets/ 直下のその他フォルダ

| フォルダ | 用途 | 扱い |
|:---|:---|:---|
| `ThirdParty/` | 外部アセット（サードパーティ製）の集約先 | **変更禁止**。そのままの状態で管理 |
| `Plugins/` | ネイティブ/レガシー形式の外部プラグイン | **変更禁止** |
| `Sandbox/` | 手動確認用ハーネス・実験コード | 本体（`App/`）から参照しない。ビルドに含めない |
| `Settings/` | プロジェクト全体設定（Build Profiles / Render Pipeline 等） | |
| `Resources/` | Unity の Resources ロード対象 | 新規追加は原則避ける（明示ロードは Addressables / 直接参照を優先） |
