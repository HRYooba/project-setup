<!-- agents-md: include -->

# コーディング規約

## 命名規則

| 対象 | 規則 | 例 |
|:-----|:-----|:---|
| 名前空間 | `<Project>.<Context>` | `<Project>.Auth` |
| クラス・メソッド・プロパティ | `PascalCase` | `PlayerController` |
| 定数 | `PascalCase` | `MaxHealth` |
| ローカル変数・引数 | `camelCase` | `playerName` |
| privateフィールド | `_` + `camelCase` | `_player` |
| SerializeField | `[SerializeField] private` + `_camelCase` | `_targetObject` |
| 抽象基底クラス | 末尾に `Base` を付与 | `PresenterBase` |
| テストクラス | テスト対象名 + `Test`（単数形。`Tests` にしない）。ファイル名と一致させる | `LoginUseCaseTest` |

定数は専用のクラス（共通ユーティリティ名前空間下、または該当 Bounded Context 直下）で管理すること

### 名前空間構造

- 機能（Bounded Context）別に分割する。
- C# 名前空間規約「クラス名と包含 namespace を同名にしない」(Microsoft Framework Design Guidelines) に従う。
- cross-context 依存は `using` directive で明示する。

## 非同期処理 (Async / UniTask)

- **Coroutine禁止**: `[UnityTest]` を除き、`StartCoroutine` / `IEnumerator` を使用しない。すべて UniTask に置き換える
- 非同期処理は可能な限り `UniTask` を使用する。戻り値は `Task` / `Task<T>` でなく `UniTask` / `UniTask<T>` を使う
- **メソッド名**: 末尾に `Async` を付与する
- **CancellationToken**: public / private を問わず、非同期メソッドには必ず `CancellationToken` を引数に取ること (`CancellationToken ct = default`は避ける)
- **`UniTaskVoid` を `await` しない**: fire-and-forget は `.Forget()` で明示する

## Reactive Programming (R3)

以下の命名・管理ルールに従います：

| 対象 | 規則 |
|:-----|:-----|
| Observable | 末尾に `Observable` を付与 |
| Subject | 末尾に `Subject` を付与。privateのみ使用可能。 |
| ReactiveProperty | `_` + `camelCase` 。privateのみ使用可能。 |
| IReadOnlyReactiveProperty | `PascalCase` |

### Observable の公開
- 既存の Observable ソースがある場合は直接公開する（Subject で中継しない）
- Subject は自身がイベントの発生源となる場合のみ使用

### Dispose管理
- `CompositeDisposable` を `_disposables` という名前で使用
- `AddTo()` で管理
- MonoBehaviourの場合は `AddTo(this)` を使用してライフサイクルに合わせて破棄 (ライフサイクルによっては`this`以外のオブジェクトを指定することも可)

## 依存性注入 (DI)

### 基本方針

- 非 `MonoBehaviour` クラスはコンストラクタインジェクションを使用する
- `MonoBehaviour` クラスは `Construct` メソッドインジェクションを使用する
- フィールドインジェクションは禁止する

### 非 MonoBehaviour のルール

- 依存はコンストラクタ引数で受け取る
- 依存差し替えを前提とした setter/public field を注入目的で公開しない

### MonoBehaviour のルール

- 注入メソッド名は `Construct` に統一する
- 注入処理は `Construct` 以外のメソッドに分散しない

### DI コンテナを Composition Root の外へ持ち出さない

Presenter / View / Service が `LifetimeScope` や `IObjectResolver` を探索して自己注入しない。
DI コンテナの知識を Composition Root（DI 登録・配線を行う場所）の外へ漏らさない。

| やってはいけないこと | 置き換え先 |
|:---|:---|
| `LifetimeScope.Find(...).Container.InjectGameObject(...)` を呼ぶ | Composition Root で生成経路を DI 管理下に置く |
| MonoBehaviour が scene 名や scope 構成を前提に依存解決する | Factory / prefab handler を Composition Root で登録する |
| 未注入を実行時に自己修復する | 「生成時に注入済み」を前提にして未注入は構成ミスとして扱う |

## ドキュメントコメント (XML Summary)

### 基本原則

**XML doc は WHY を伝える道具**。識別子で WHAT が分かる箇所には書かない。
本プロジェクトは NuGet 等で公開する API ではないため、機械的・網羅的な summary 付与は行わない。

### 対象別ルール

| 対象 | 必須/任意 |
|:-----|:----------|
| クラス・インターフェース・enum 型 | **必須**（責務・bounded context を 1 文で書く） |
| **enum メンバー** | **必須**（識別子だけでは値の意味・対応関係が読み取りにくいため、各メンバーに短い説明を付ける） |
| public メソッド | WHY がある場合のみ |
| public プロパティ・フィールド | WHY がある場合のみ |
| コンストラクタ | WHY がある場合のみ |
| param / returns / exceptions | WHY がある場合のみ |
| private メンバー | 任意（複雑なロジックの場合のみ） |

### 必ず書くべき WHY

以下に該当する箇所は **必ず** summary または body コメントで明示する:

- **型の責務**: クラス・interface・enum が「何のために存在するか」を 1 文で
- **非自明な不変条件**: 「並び順は X 昇順」「空文字不可」「重複排除済み」など、識別子から読めない契約
- **lifecycle 契約**: `Dispose` 必須、`Construct` を 1 度だけ呼ぶ、特定の順序で呼ぶ等
- **値の制約・意味**: 範囲（0..1 など）、単位（秒/ミリ秒/メートル）、時刻の time zone、包含/排他の境界（含む/含まない）
- **null / 空文字のセマンティクス**: null と空文字の意味の違い、 fallback の挙動
- **副作用・状態遷移**: 観測可能な副作用、 state machine 上の遷移
- **並行性・スレッド契約**: thread-safe / not thread-safe、 呼び出し可能なコンテキスト
- **キャンセル挙動**: `CancellationToken` 受領時の振る舞いが標準的でない場合

### 書かないもの

以下は **書いてはならない**（noise が WHY を埋もれさせる）:

- 識別子の直訳・繰り返し: `<summary>タイトル。</summary>` for `Title` プロパティ
- 型の繰り返し: `<param name="ct">キャンセルトークン</param>`
- コンストラクタの自己参照テンプレ: `<see cref="Foo"/> の新しいインスタンスを生成する。`
- "Gets the X" / "Sets the Y" の機械訳
- **WHAT の冗長記述**: 「`X` を購読し `Y` を呼ぶ」「`A` と `B` を Subscribe する」 など、 code を読めば分かる手順の列挙
- **他クラスの内部挙動説明**: 「各 View が panel close 時に `Blur()` する」 等、 本クラスの責務外の補足。 読み手は他クラスの実装を信じれば良く、 ここで二重に説明しない
- **`<see cref>` 連打**: 1 文に 2 個以上 cref を挟むと文が分断され WHY が埋もれる。 言及対象が多い場合は識別子を plain text で書くか、 説明そのものを削る方向で見直す

### 簡潔性の指針

- **summary は 1 〜 2 文**で型・メンバーの責務を述べる。 複数の責務を箇条書きするのは責務分割の signal (god class 化していないか再考)
- **remarks は WHY のみ**を書く。 「なぜそういう設計にしたか / なぜこの順序か / なぜここで例外を抑える必要があるか」 — code から読み取れない情報のみ。 数行に収まらないなら設計が複雑すぎる signal
- **対象を絞る**: 「Editor / domain reload 跨ぎで IME が OFF のまま残る事故を防ぐため」 のように WHY を 1 つに絞る方が、 複数並列で書くより伝わる

### 本文 summary 内のクラス・メソッド参照

| 場所 | `<see cref="..."/>` |
|:---|:---|
| **構造化タグ** (`<param>` / `<returns>` / `<exception>` / `<typeparam>`) で型・メンバーを参照する場合 | **必須**（tooling が cref を機械的に拾うため） |
| **`<summary>` / `<remarks>` の自然文中**で型名に言及する場合 | **plain text で良い**。 cref 連打で文が分断されると WHY が埋もれるため、 可読性を優先 |
| **複雑な依存追跡が要る箇所**（例: 状態遷移 ↔ 別クラスのイベントの対応関係） で IDE で型・メンバーへ jump して理解する価値が高い場合 | cref **推奨**（数を絞れば可読性も維持できる） |

plain text で書いた識別子は IDE rename refactor で拾われないことがある。
ただし本プロジェクトは NuGet 公開 API ではないため、 機械的に全 type 名を cref する必要はない。 読み手が文章として summary を読めることを優先する。

## コード品質

- non-trivialな変更では立ち止まって「もっとエレガントな方法はないか？」と自問すること
- hackyに感じたら、そのまま出さず、よりエレガントな解決策を検討すること
- ただしシンプルで明白な修正にはこのステップをスキップする（over-engineerしない）
- 新しい Service / 実装 / DTO を追加する前に、同じ種別の既存クラスを検索し、
  戻り値型・ライフサイクル・命名を揃える

### 設計アプローチ

**最小変更で済ませない**。「現行の挙動を維持した最小変更」は既存の複雑さを温存し、
パッチの蓄積で密結合が増大する。根本解決のためにクラス設計・依存関係・配置の
変更を躊躇しないこと:

1. **一段抽象化する** — 目の前の問題を設計原則レベルに引き上げる
2. **パターンとして持続可能か判断する** — 同種の問題が増えたとき破綻しないかを基準にする
3. **同じパターンの他の箇所を確認する** — コードベース内の同系統の論点を洗い出す
4. **変更範囲を限定しない** — 根本解決に必要なら、クラスの分割・統合・削除、依存方向の変更、インターフェース再設計を行う

**複雑さを足して解決しない**。問題をクラス・インターフェース・中間層の追加で解決しない。
「シンプル」≠「責務の詰め込み」であることに注意し、以下の 3 点でシンプルにする:

1. **構造がシンプル** — 不要なクラス・インターフェース・中間層がない
2. **依存がシンプル** — 間接層を介さず直接的な依存のみ。依存先が少ない
3. **制御フローがシンプル** — 呼び出しホップが少なく、処理の流れが直線的に追える

| 避ける傾向（複雑化） | 好ましい方向（簡素化） |
|:---|:---|
| 既存構造を維持したまま型・クラスを追加 | 既存構造を正しく作り直す |
| 中間層・ラッパー・アダプターを挟む | 不要な間接層を削除する |
| 責務を分割して小クラスを増やす | 不要な分割を統合する（SRPは維持） |
| 現行の挙動を壊さないパッチ | 挙動ごと設計し直す |

具体的な対処パターン:
- 共通動作は基底クラスに集約し、差分を派生クラスで実装
- 常にセットで注入される Model/Handler は統合
- Spawner/Factory はその操作だけを担い、初期化ロジックは呼び出し側が行う

分割と統合の判定基準: **分割するのは責務（変更理由）が異なるとき。統合するのは
ライフサイクルと注入が常に一致しているとき**。この基準で説明できない分割・統合はしない。

## エラーハンドリング / 初期化失敗の扱い

起動時・初期化時の依存解決失敗の扱いは次の基準で統一する:

| 区分 | 扱い | 例 |
|:-----|:-----|:---|
| **必須機能**（欠けるとアプリの主目的が成立しない） | fail-fast: 例外を投げて起動を止める | 入力システム、オーディオ基盤、認証基盤 |
| **装飾・補助機能**（欠けても主要フローが成立する） | fail-soft: 警告ログ + デフォルト値で続行 | お知らせ同期、外部リンク集、キャッシュ容量設定 |

どちらに分類したかはコメントでなく構造で表現する: fail-soft のデフォルト値生成・警告ログは
Composition Root の共通登録ヘルパーに集約し、fail-fast は素直に throw する（ヘルパーを介さない）。

## その他

- LINQやRxのチェーンは見やすさを重視し、適宜改行を行ってください
