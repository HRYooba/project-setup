# アセット命名規則

Unity アセットの作成・リネーム時に従う命名規則。
Material、Shader、Prefab、Texture、Animation、Audio 等の命名に適用する。

アセットファイル名の先頭にプレフィックスを付与する。

| アセット種類 | プレフィックス | 例 |
|:---|:---|:---|
| Material | `MT_` | `MT_PlayerBody` |
| Shader (Code) | `SH_` | `SH_ComputeVisualizer` |
| Shader Graph | `SG_` | `SG_Hologram` |
| VisualEffect Graph | `VFX_` | `VFX_Particle` |
| Timeline | `TL_` | `TL_Opening` |
| Prefab | `PF_` | `PF_EnemyUnit` |
| Texture | `TX_` | `TX_GroundGrass` |
| Sprite | `SP_` | `SP_IconHome` |
| Animation Clip | `AN_` | `AN_Run` |
| Animator Controller | `AC_` | `AC_Player` |
| Audio Clip (SE) | `SE_` | `SE_Click` |
| Audio Clip (BGM) | `BGM_` | `BGM_MainTheme` |
| Render Texture | `RT_` | `RT_CameraOutput` |

複数ある場合はサフィックスで連番（2 桁ゼロ埋め）: `SE_Click_01`, `SE_Click_02`

## プレフィックスを付けない種別

| アセット種類 | 規則 | 例 |
|:---|:---|:---|
| Scene (`.unity`) | プレフィックスなし PascalCase | `Bootstrap`, `MainStage` |
| UXML | 対応する View クラス名と一致 | `LoginView.uxml` |
| USS | 対応する View と同名。複数 View で共有するスタイルは用途名 | `LoginView.uss`, `Common.uss`, `Dialog.uss` |
| ScriptableObject アセット (`.asset`) | 型名ベース（環境別等の区分はサフィックス） | `BackendApiSettings_Development` |
| asmdef | `<プロジェクト名>.<区分>`（レイヤー・モジュール単位） | `<Project>.Application`, `<Project>.Tests.EditMode` |

上記いずれの表にもない種別は **プレフィックスなし PascalCase** を既定とし、
繰り返し作る種別になったら本表へ行を追加する。
