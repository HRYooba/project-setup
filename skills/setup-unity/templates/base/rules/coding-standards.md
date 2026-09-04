<!-- agents-md: include -->

# コーディング規約

## 規約の機械チェック

この規約の一部は Roslyn analyzer（`Assets/Analyzers/`）が機械で見る。違反は Editor の
コンパイル時に `warning UCS####` として出る。**コンソールを読んで直す。**

- **CI は見ない。** 配布する workflow は Editor を起こさないので、警告を無視したまま
  PR は通る。止めるのは自分
- severity は Warning 固定。Error にすると Unity がコンパイルエラーとして扱い、
  命名違反 1 件で Safe Mode に落ちて Editor が作業不能になる
- 正当な例外は `#pragma warning disable UCS0006` のように範囲を絞って抑制し、
  理由をコメントに書く。ファイル全体やプロジェクト全体で無効化しない

## 命名規則

| 対象 | 規則 | 例 |
|:-----|:-----|:---|
| 名前空間 | `<Project>.<Context>` | `<Project>.Auth` |
| privateフィールド | `_` + `camelCase` | `_player` |
| SerializeField | `[SerializeField] private` + `_camelCase` | `_targetObject` |
| 抽象基底クラス | 末尾に `Base` を付与 | `PresenterBase` |
| テストクラス | テスト対象名 + `Test`（単数形。`Tests` にしない）。ファイル名と一致させる | `LoginUseCaseTest` |
| テスト名前空間 | `<Project>.Tests.<Context>` | `<Project>.Tests.Auth` |
| テストメソッド | `MethodName_Condition_ExpectedResult`（パラメータ化の `Condition` は同値区分名） | `Execute_WhenBlankName_ReturnsEmpty` |

## 非同期処理 (Async / UniTask)

- **Coroutine禁止**: `[UnityTest]` を除き、`StartCoroutine` / `IEnumerator` を使用しない。すべて UniTask に置き換える
- 非同期処理は可能な限り `UniTask` を使用する。戻り値は `Task` / `Task<T>` でなく `UniTask` / `UniTask<T>` を使う
- **メソッド名**: 末尾に `Async` を付与する
- **CancellationToken**: public / private を問わず、非同期メソッドには必ず `CancellationToken` を引数に取ること (`CancellationToken ct = default`は避ける)
- **`UniTaskVoid` を `await` しない**: fire-and-forget は `.Forget()` で明示する

## Reactive Programming (R3)

| 対象 | 命名 | 公開 |
|:-----|:-----|:-----|
| Observable | 末尾に `Observable`。event は `On` + 名詞 + `Observable`（例: `OnClickObservable`） | public 可 |
| IReadOnlyReactiveProperty | プロパティ名を `PascalCase` | public 可 |
| Subject | 末尾に `Subject` | private のみ |
| ReactiveProperty | フィールド名を `_` + `camelCase` | private のみ |

そのまま公開できる Observable を private Subject で中継しない。

**購読と自前の Subject / ReactiveProperty は `AddTo()` で束ねて捨てる。**
束ね先は plain class なら `CompositeDisposable`（`_disposables`）、MonoBehaviour なら `this`
（寿命が違うなら別の対象でよい）。

## 依存性注入 (DI)

| クラス | 注入 |
|:--|:--|
| 非 `MonoBehaviour` | コンストラクタ引数で受け取る |
| `MonoBehaviour` | `Construct` メソッド 1 つに集約する（他のメソッドへ分散しない） |

フィールド / setter / public field を注入の口にしない。

### DI コンテナを Composition Root の外へ持ち出さない

Presenter / View / Service が `LifetimeScope` や `IObjectResolver` を探索して自己注入しない。
DI コンテナの知識を Composition Root（DI 登録・配線を行う場所）の外へ漏らさない。

| やってはいけないこと | 置き換え先 |
|:---|:---|
| `LifetimeScope.Find(...).Container.InjectGameObject(...)` を呼ぶ | Composition Root で生成経路を DI 管理下に置く |
| MonoBehaviour が scene 名や scope 構成を前提に依存解決する | Factory / prefab handler を Composition Root で登録する |
| 未注入を実行時に自己修復する | 「生成時に注入済み」を前提にして未注入は構成ミスとして扱う |

## ドキュメントコメント (XML Summary)

**XML doc は WHY を伝える道具。** 識別子で WHAT が分かる箇所には書かない。
本プロジェクトは NuGet 等で公開する API ではないため、機械的・網羅的な summary 付与は行わない。

| 対象 | 必須/任意 |
|:-----|:----------|
| クラス・インターフェース・enum 型 | **必須**（責務を 1 文で書く） |
| enum メンバー | **必須**（識別子だけでは値の意味・対応関係が読み取れない） |
| それ以外（メソッド / プロパティ / コンストラクタ / param / returns / private） | WHY があるときのみ |

summary は **1〜2 文**。複数の責務を箇条書きするのは責務分割の signal（god class 化していないか）。

以下は書かない。noise が WHY を埋もれさせる。

- **WHAT の冗長記述**: 「`X` を購読し `Y` を呼ぶ」など、code を読めば分かる手順の列挙
- **他クラスの内部挙動の説明**: 本クラスの責務外の補足。読み手は他クラスの実装を信じればよい
- **`<see cref>` 連打**: 1 文に 2 個以上挟むと文が分断され WHY が埋もれる

`<see cref>` は**構造化タグ**（`<param>` / `<returns>` / `<exception>` / `<typeparam>`）では
必須（tooling が機械的に拾う）。`<summary>` / `<remarks>` の自然文中では plain text でよい。

## エラーハンドリング / 初期化失敗の扱い

起動時・初期化時の依存解決失敗は次で切り分ける。

| 区分 | 扱い | 例 |
|:-----|:-----|:---|
| **必須機能**（欠けるとアプリの主目的が成立しない） | fail-fast: 例外を投げて起動を止める | 入力システム、オーディオ基盤、認証基盤 |
| **装飾・補助機能**（欠けても主要フローが成立する） | fail-soft: 警告ログ + デフォルト値で続行 | お知らせ同期、外部リンク集、キャッシュ容量設定 |

どちらに分類したかはコメントでなく構造で表現する: fail-soft のデフォルト値生成・警告ログは
Composition Root の共通登録ヘルパーに集約し、fail-fast は素直に throw する（ヘルパーを介さない）。
