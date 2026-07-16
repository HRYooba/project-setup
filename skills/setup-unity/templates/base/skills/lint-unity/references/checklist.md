# Unity Asset & Scene Lint Checklist

`.claude/rules/` の各ルールを凝縮したチェックリスト。Unity のスクリプト以外のアセット・シーン・設定の lint 用。

## [A] Asset Naming (アセット命名)

- A1: **ERROR** — Prefab のファイル名が `PF_` プレフィックスを持っているか
- A2: **ERROR** — Material のファイル名が `MT_` プレフィックスを持っているか
- A3: **ERROR** — Texture のファイル名が `TX_` プレフィックスを持っているか
- A4: **ERROR** — Sprite のファイル名が `SP_` プレフィックスを持っているか
- A5: **ERROR** — AnimationClip のファイル名が `AN_` プレフィックスを持っているか
- A6: **ERROR** — AnimatorController のファイル名が `AC_` プレフィックスを持っているか
- A7: **WARNING** — Shader のファイル名が `SH_` (code) / `SG_` (graph) プレフィックスを持っているか
- A8: **WARNING** — AudioClip のファイル名が `SE_` / `BGM_` プレフィックスを持っているか
- A9: **WARNING** — RenderTexture のファイル名が `RT_` プレフィックスを持っているか
- A10: **WARNING** — VisualEffect (`.vfx`) のファイル名が `VFX_` プレフィックスを持っているか
- A11: **WARNING** — Timeline (`.playable`) のファイル名が `TL_` プレフィックスを持っているか
- A12: **WARNING** — プレフィックス以降の名称が `PascalCase` か
- A13: **INFO** — 複数ある同種アセットに連番サフィックス (`_01`, `_02`) が付いているか

### プレフィックスマッピング

プレフィックスの正典は `rules/asset-naming.md`（種別・プレフィックス・severity の単一ソース）。
下表は lint 実装用に拡張子 → プレフィックスの対応のみを示す（プレフィックスを追加・変更するときは
asset-naming.md を編集し、必要ならこの対応表と上の A 項目を追随させる）。

| 拡張子 / AssetType | プレフィックス |
|---|---|
| `.prefab` | `PF_` |
| `.mat` | `MT_` |
| `.shader` / `.hlsl` | `SH_` |
| `.shadergraph` | `SG_` |
| `.vfx` | `VFX_` |
| `.playable` (Timeline) | `TL_` |
| `.png` / `.jpg` / `.tga` / `.exr` (Texture) | `TX_` |
| `.png` / `.jpg` (Sprite mode) | `SP_` |
| `.anim` | `AN_` |
| `.controller` | `AC_` |
| `.wav` / `.mp3` / `.ogg` (SE) | `SE_` |
| `.wav` / `.mp3` / `.ogg` (BGM) | `BGM_` |
| `.renderTexture` | `RT_` |

## [B] Hierarchy Structure (ヒエラルキー構造)

- B1: **ERROR** — ルートオブジェクトが `[]` で囲まれたコンテナ名か (例: `[System]`, `[World]`)
- B2: **ERROR** — 個別のオブジェクトがルート直下に散乱していないか（コンテナの子として配置されているか）
- B3: **WARNING** — オブジェクト名が `PascalCase` か
- B4: **WARNING** — 同種オブジェクトの連番が `_XX` (2桁) フォーマットか
- B5: **WARNING** — ルートコンテナの数が適切か (目安: 5〜7個以内)
- B6: **INFO** — ヒエラルキーの階層が深すぎないか (目安: 5階層以内)

## [C] SerializeField References (参照整合性)

- C1: **ERROR** — SerializeField に `Missing` (None) の参照がないか（必須と思われるフィールド）
- C2: **ERROR** — Prefab 内の SerializeField に Missing 参照がないか
- C3: **WARNING** — コンポーネントの参照先が同じ Prefab / シーン内に存在するか
- C4: **WARNING** — Missing Script コンポーネントが存在しないか
- C5: **INFO** — 未使用と思われる SerializeField がないか

## [D] Scene Configuration (シーン設定)

- D1: **ERROR** — シーンのルートオブジェクト構成が hierarchy.md のパターンに従っているか
- D2: **WARNING** — シーンに Camera が存在するか（UI のみ・サブシーン等では不要な場合あり）
- D3: **WARNING** — シーンに DirectionalLight (または適切な照明) が存在するか（ライティング分離等では不要な場合あり）
- D4: **WARNING** — EventSystem がシーンに存在するか（UI を含むシーンの場合）
- D5: **WARNING** — EditorBuildSettings にシーンが登録されているか

## [E] Folder Structure (フォルダ構成)

- E1: **ERROR** — `Assets/ThirdParty/` 配下にプロジェクト固有のファイルが混入していないか
- E2: **WARNING** — アセットが適切なフォルダに配置されているか
  - Scenes → `Assets/App/Scenes/`
  - Prefabs → `Assets/App/Prefabs/`
  - Materials → `Assets/App/Materials/`
  - Animations → `Assets/App/Animations/`
- E3: **WARNING** — Scripts フォルダ内にスクリプト以外のファイルが混入していないか
- E4: **INFO** — 空フォルダが残っていないか

## [F] Prefab Integrity (Prefab 整合性)

- F1: **ERROR** — Prefab に Missing Script が含まれていないか
- F2: **ERROR** — Prefab のルートオブジェクト名がプレフィックスなしの `PascalCase` か（ファイル名に `PF_` がつくが、GameObject名には不要）
- F3: **WARNING** — Nested Prefab の参照が壊れていないか
- F4: **WARNING** — Prefab 内の子オブジェクト名が `PascalCase` か
- F5: **INFO** — Prefab の Transform がリセットされているか (position=0, rotation=0, scale=1)

## [G] Component References (コンポーネント参照)

- G1: **ERROR** — AudioSource の AudioClip が Missing（参照破損） / **WARNING** — 未設定（None）
- G2: **ERROR** — Animator の RuntimeAnimatorController が Missing（参照破損） / **WARNING** — 未設定（None）
- G3: **ERROR** — Image / RawImage の Sprite / Texture が Missing（参照破損） / **WARNING** — 未設定（None）
- G4: **WARNING** — Collider / Rigidbody の設定不整合 (MeshCollider non-convex + Rigidbody)

## [H] Assembly Definition (asmdef 整合性)

- H1: **ERROR** — asmdef の参照先が存在しない GUID を指しているか
- H2: **ERROR** — 循環参照がないか
- H3: **WARNING** —（architecture 規約導入時のみ）層の依存ルールに違反する参照がないか（例: Domain → Presentation）
- H4: **INFO** — 不要な参照が残っていないか

## [I] UI Canvas (UI設定)

- I1: **ERROR** — Canvas に GraphicRaycaster が付いていない
- I2: **WARNING** — EventSystem がシーンに重複していないか
- I3: **INFO** — Canvas の Render Mode がプロジェクト方針と合致しているか（方針がルールファイルに明記されるまで INFO）
- I4: **INFO** — CanvasScaler の設定が統一されているか（方針がルールファイルに明記されるまで INFO）
- I5: **INFO** — Raycast Target が不要な要素で有効になっていないか

## [J] Material References (マテリアル参照)

- J1: **ERROR** — Renderer の Material が `Missing` になっていないか
- J2: **ERROR** — Material のシェーダーが `Hidden/InternalErrorShader` (ピンク) になっていないか
- J3: **WARNING** — Material のテクスチャスロットに Missing テクスチャがないか
- J4: **INFO** — 未使用の Material がプロジェクトに残っていないか
