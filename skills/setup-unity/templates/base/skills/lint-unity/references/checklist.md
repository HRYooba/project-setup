# Unity Asset & Scene Lint Checklist

`.claude/rules/` の各ルールを凝縮したチェックリスト。Unity のスクリプト以外のアセット・シーン・設定の lint 用。

## Editor 依存の区分

各カテゴリ見出しに **Editor: 不要 / 必須** を書く。live Editor に到達できないときは
「不要」のカテゴリだけ実行し、「必須」は未検査として報告する（`SKILL.md` Step 1）。

| 区分 | カテゴリ |
|:--|:--|
| Editor 不要 | [E] [H] [K]、および [A] のうち行末に「Editor 必須」と書いていない項目 |
| Editor 必須 | [B] [C] [D] [F] [G] [I] [J]、および [A] のうち行末に「Editor 必須」と書いた項目 |

区分の正本は**各カテゴリ見出しと各項目の行末**。この表はその要約なので、項目を増減したら
見出し側を直す（表だけ直しても効かない）。

## [A] Asset Naming (アセット命名) — Editor: 項目ごと（各項目の行末に記載）

- A1: **ERROR** — Prefab のファイル名が `PF_` プレフィックスを持っているか
- A2: **ERROR** — Material のファイル名が `MT_` プレフィックスを持っているか
- A3: **ERROR** — Texture のファイル名が `TX_` プレフィックスを持っているか（Editor 必須: `textureType` で判別）
- A4: **ERROR** — Sprite のファイル名が `SP_` プレフィックスを持っているか（Editor 必須: `textureType` で判別）
- A5: **ERROR** — AnimationClip のファイル名が `AN_` プレフィックスを持っているか
- A6: **ERROR** — AnimatorController のファイル名が `AC_` プレフィックスを持っているか
- A7: **WARNING** — Shader のファイル名が `SH_` (code) / `SG_` (graph) プレフィックスを持っているか
- A8: **WARNING** — AudioClip のファイル名が `SE_` / `BGM_` プレフィックスを持っているか（フォルダ名からの推測。確度が低ければ INFO に落とす）
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

## [B] Hierarchy Structure (ヒエラルキー構造) — Editor: 必須

- B1: **ERROR** — ルートオブジェクトが `[]` で囲まれたコンテナ名か (例: `[System]`, `[World]`)
- B2: **ERROR** — 個別のオブジェクトがルート直下に散乱していないか（コンテナの子として配置されているか）
- B3: **WARNING** — オブジェクト名が `PascalCase` か
- B4: **WARNING** — 同種オブジェクトの連番が `_XX` (2桁) フォーマットか
- B5: **WARNING** — ルートコンテナの数が適切か (目安: 5〜7個以内)
- B6: **INFO** — ヒエラルキーの階層が深すぎないか (目安: 5階層以内)

## [C] SerializeField References (参照整合性) — Editor: 必須

- C1: **ERROR** — SerializeField に `Missing` (None) の参照がないか（必須と思われるフィールド）
- C2: **ERROR** — Prefab 内の SerializeField に Missing 参照がないか
- C3: **WARNING** — コンポーネントの参照先が同じ Prefab / シーン内に存在するか
- C4: **WARNING** — Missing Script コンポーネントが存在しないか
- C5: **INFO** — 未使用と思われる SerializeField がないか

## [D] Scene Configuration (シーン設定) — Editor: 必須

- D1: **ERROR** — シーンのルートオブジェクト構成が hierarchy.md のパターンに従っているか
- D2: **WARNING** — シーンに Camera が存在するか（UI のみ・サブシーン等では不要な場合あり）
- D3: **WARNING** — シーンに DirectionalLight (または適切な照明) が存在するか（ライティング分離等では不要な場合あり）
- D4: **WARNING** — EventSystem がシーンに存在するか（UI を含むシーンの場合）
- D5: **WARNING** — EditorBuildSettings にシーンが登録されているか

## [E] Folder Structure (フォルダ構成) — Editor: 不要

- E1: **ERROR** — `Assets/ThirdParty/` 配下にプロジェクト固有のファイルが混入していないか
- E2: **WARNING** — アセットが適切なフォルダに配置されているか
  - Scenes → `Assets/App/Scenes/`
  - Prefabs → `Assets/App/Prefabs/`
  - Materials → `Assets/App/Materials/`
  - Animations → `Assets/App/Animations/`
- E3: **WARNING** — Scripts フォルダ内にスクリプト以外のファイルが混入していないか
- E4: **INFO** — 空フォルダが残っていないか

## [F] Prefab Integrity (Prefab 整合性) — Editor: 必須

- F1: **ERROR** — Prefab に Missing Script が含まれていないか
- F2: **ERROR** — Prefab のルートオブジェクト名がプレフィックスなしの `PascalCase` か（ファイル名に `PF_` がつくが、GameObject名には不要）
- F3: **WARNING** — Nested Prefab の参照が壊れていないか
- F4: **WARNING** — Prefab 内の子オブジェクト名が `PascalCase` か
- F5: **INFO** — Prefab の Transform がリセットされているか (position=0, rotation=0, scale=1)

## [G] Component References (コンポーネント参照) — Editor: 必須

- G1: **ERROR** — AudioSource の AudioClip が Missing（参照破損） / **WARNING** — 未設定（None）
- G2: **ERROR** — Animator の RuntimeAnimatorController が Missing（参照破損） / **WARNING** — 未設定（None）
- G3: **ERROR** — Image / RawImage の Sprite / Texture が Missing（参照破損） / **WARNING** — 未設定（None）
- G4: **WARNING** — Collider / Rigidbody の設定不整合 (MeshCollider non-convex + Rigidbody)

## [H] Assembly Definition (asmdef 整合性) — Editor: 不要

- H1: **ERROR** — asmdef の参照先が存在しない GUID を指しているか
- H2: **ERROR** — 循環参照がないか
- H3: **WARNING** —（architecture 規約導入時のみ）層の依存ルールに違反する参照がないか（例: Domain → Presentation）
- H4: **INFO** — 不要な参照が残っていないか

## [I] UI Canvas (UI設定) — Editor: 必須

- I1: **ERROR** — Canvas に GraphicRaycaster が付いていない
- I2: **WARNING** — EventSystem がシーンに重複していないか
- I3: **INFO** — Canvas の Render Mode がプロジェクト方針と合致しているか（方針がルールファイルに明記されるまで INFO）
- I4: **INFO** — CanvasScaler の設定が統一されているか（方針がルールファイルに明記されるまで INFO）
- I5: **INFO** — Raycast Target が不要な要素で有効になっていないか

## [J] Material References (マテリアル参照) — Editor: 必須

- J1: **ERROR** — Renderer の Material が `Missing` になっていないか
- J2: **ERROR** — Material のシェーダーが `Hidden/InternalErrorShader` (ピンク) になっていないか
- J3: **WARNING** — Material のテクスチャスロットに Missing テクスチャがないか
- J4: **INFO** — 未使用の Material がプロジェクトに残っていないか

## [K] Project Integrity (プロジェクト整合性) — Editor: 不要

`unity projects verify --format json` の検出結果をそのまま報告するカテゴリ。
**独自に判定せず、severity も付け直さない**（判定の出所を二重にしない）。

| code | 内容 |
|:--|:--|
| `META_MISSING` | アセットの `.meta` が無い（マージが落とすと Unity が新しい GUID を振り、全参照が静かに切れる） |
| `META_ORPHAN` | 削除されたアセットの `.meta` が残っている |
| `GUID_DUPLICATE` | 2 つのブランチが同じ GUID を導入した |
| `CONFLICT_MARKERS` | `.meta` / `ProjectSettings/*.asset` / `manifest.json` / `packages-lock.json` に未解決の衝突マーカー |
| `MANIFEST_INVALID` | `Packages/manifest.json` が解析できない |
| `EDITOR_VERSION_DRIFT` | `--expect-editor <version>` を渡したときのみ。`ProjectVersion.txt` との不一致 |

- severity は verify の出力（error / warning）に従う。error は exit 6、warning のみなら exit 0
- **検出のみ。修復は Editor のアセットデータベースが要る**ので、この skill は直さない
- `summary.unverifiable > 0` / `PATH_UNVERIFIABLE` があれば、**見ていないサブツリーがある**ことを
  レポートに明示する（exit 0 を「問題なし」と読ませない）
