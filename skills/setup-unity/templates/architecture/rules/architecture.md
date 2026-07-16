<!-- agents-md: include -->

# アーキテクチャ構成

Unity の実用向けレイヤードアーキテクチャ。依存方向は外→内の一方向。

## レイヤー定義

| 層 | 責務 |
|:---|:-----|
| **Presentation** | 画面・入力・演出。UI（Model / View / Presenter）と Gameplay（UI 以外のランタイム制御）から成る |
| **Application** | アプリケーション固有のビジネスルール。port（interface）を介して外部依存を扱い、ユースケースの目的を達成する。UI・外部サービス具象に依存しない |
| **Domain** | 業務概念そのものの性質（enum・値オブジェクト・純粋なビジネスルール）。下記「Domain 配置の判定基準」を満たすもののみを置く |
| **Infrastructure** | Application / Domain の port の具象実装。業務ルールは持たない |
| **Composition** | DI 登録・初期化順序・エントリーポイント（Composition Root）。全層参照可、配線目的のみ。SettingsAsset → Options 変換もこの層 |
| **Shared** | ビジネス意味を持たない技術的ユーティリティ（全層から参照可）。ログ出力等の暗黙の副作用を持たない |

## Domain 配置の判定基準

「その規則が、**特定のユースケース・画面・外部契約から独立に、業務概念そのものの性質として
成り立つか**」で判定する。Yes なら Domain、No なら Application。

- Application に置くもの（Domain ではない）: コマンドの入力検証（文字数制限等、サーバー API 契約のミラー）、
  サーバー仕様が意味論を所有する判定ロジック、UI 挙動のポリシー（未読集計等）、演出のポリシー

## 依存ルール

| 層 | 参照してよい層 |
|:---|:---------------|
| Shared | なし |
| Domain | Shared |
| Application | Domain, Shared |
| Presentation | Application, Shared（Domain enum を UI 分岐で直接扱う明確な理由がある場合に限り Domain も可） |
| Infrastructure | Application, Domain, Shared |
| Composition | 全層 |

- 禁止の代表例: `Application → Infrastructure 具象`、`Presentation → Infrastructure 具象`、
  `Presentation → Domain の値オブジェクト`（enum 例外を除く）、`Domain → 他の全層`
- Presentation は外部 SDK（ネットワーク / アバター等のサードパーティ）を直接参照してよい
- asmdef の references はこの表に従う。

## Interface の配置基準（依存性逆転）

Interface は使用する側の層に配置する。

- port（外部サービス・永続化の契約）は Application に置く（`I*Service` / `I*Store`）
- Repository Interface（ドメインオブジェクトの永続化契約）は Domain に置く

## MonoBehaviour 制約

MonoBehaviour の継承は **Presentation / Shared / Composition のみ許可**。
Domain / Application / Infrastructure では使用しない。
Unity API（UnityEngine, UniTask, R3 等）はどの層でも使用可。

## 層間のデータ受け渡し

- Presentation → Application 間のメソッド引数・戻り値には、プリミティブ型・UnityEngine の値型
  （`Vector3`, `Quaternion` 等）・DTO を使用する
- MonoBehaviour / Component 参照（`Collider`, `Transform`, `GameObject` 等）を直接 Application 層に渡さない
- Application の **DTO**（純データ運搬型）には `Texture2D` `Sprite` `GameObject` `AudioClip` `Material` などの
  concrete Unity asset 参照を保持しない。必要な場合は asset key / ID を渡し、実際のロードは asset service に分離する
- 例外: **Lease / Handle 型**（Dispose によるライフサイクル管理を伴う asset 保持型）は asset 参照を保持してよい
