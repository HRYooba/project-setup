<!-- agents-md: include -->

# アーキテクチャ構成

クリーンアーキテクチャを Unity 向けに 6 層へ割ったもの。一般論と異なる点だけを書く。

## レイヤー定義

| 層 | 責務 |
|:---|:-----|
| **Presentation** | UI と Gameplay（UI 以外のランタイム制御） |
| **Application** | ユースケース層 |
| **Domain** | エンティティ層 |
| **Infrastructure** | インターフェースアダプター層（外部サービス・永続化側） |
| **Composition** | Composition Root |
| **Shared** | ビジネス意味を持たない技術的ユーティリティ |

## 依存ルール

| 層 | 参照してよい層 |
|:---|:---------------|
| Shared | なし |
| Domain | Shared |
| Application | Domain, Shared |
| Presentation | Application, Shared（Domain enum を UI 分岐で直接扱う明確な理由がある場合に限り Domain も可） |
| Infrastructure | Application, Domain, Shared |
| Composition | 全層 |

asmdef の references はこの表に従う。

## MonoBehaviour 制約

MonoBehaviour の継承は **Presentation / Shared / Composition のみ許可**。
Domain / Application / Infrastructure では使用しない。
Unity API（UnityEngine, UniTask, R3 等）はどの層でも使用可。
