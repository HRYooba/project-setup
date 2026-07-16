<!-- agents-md: include -->

# クラス種別カタログ

各層に置くクラス種別の命名・責務・作成基準・lifecycle 契約を定義する。
新しいクラスを作るときは、まず該当する種別をこのカタログから選び、その行の規約に従うこと。
**どの種別にも当てはまらない新概念**を作る場合は、本カタログに種別を追記してから実装する
（無名の種別を増やさない）。

層の原則・依存方向は `rules/architecture.md` を参照。

## Application

| 種別 | 命名 | 責務 | 作成基準・契約 |
|:-----|:-----|:-----|:---------------|
| UseCase | 動詞 + 名詞 + `UseCase`、公開エントリは原則 `ExecuteAsync` 1 つ | 単一のアプリケーションコマンド（検証・実行・結果解釈） | 下記「UseCase 作成基準」を満たす場合のみ作成。**他の UseCase を呼ばない** |
| Orchestrator | `*Orchestrator` | 複数 UseCase の逐次実行・分岐・補償（rollback） | 下記「Orchestrator 規約」参照 |
| State | `*State` + `IReadOnly*State` | runtime current value の保持・公開 | Presentation へは `IReadOnly*State` のみ DI 登録する。`_isDisposed` ガード必須 |
| Store | `I*Store` | 永続化の load / save port | current value を保持しない（保持は State）。永続化結果と State の整合は UseCase / Orchestrator が担う |
| Service | `I*Service` | 外部サービスへの port | 1 interface 1 責務。責務が混ざったら分割する |
| Synchronizer | `*Synchronizer` | Service ↔ State の同期配線 | 下記「Synchronizer」参照 |
| ErrorCode | `*ErrorCode` | context ごとの失敗分岐 enum | **`None = 0` を必ず持つ**（成功時の `OperationResult.ErrorCode` は `default(TError)` = 0 値になるため、0 を実エラーに割り当てると成功結果が実エラー値を保持してしまう）。`None` を `Failure` に渡さない。共通メンバー名は `NetworkError` / `ServerError` / `InvalidResponse` / `Unknown` に統一 |
| DTO | 名詞（`Dto` サフィックスを**付けない**。Infrastructure の backend ミラー DTO と区別するため） | 層間データ運搬 | `readonly struct` または `record`。mutable にしない。Unity asset 参照を持たない。コンストラクタで null → `string.Empty` 正規化 |
| Lease / Handle | `*Lease` / `*Handle` | ライフサイクル管理付き asset 保持。**Lease** = 共有リソースの貸与（Dispose で「返却」し参照カウント等で元リソースは生存しうる）、**Handle** = 個別に確保した実体への参照（Dispose で対象そのものを解放） | DTO の asset 禁止規定の**明示的例外**。`IDisposable` 必須、Dispose 契約を doc に明記 |
| Options | `*Options` | 起動時確定の immutable 設定値 | `SettingsAsset.ToOptions()` で生成。値域 clamp は Options 側に置く（SettingsAsset と二重実装しない） |

### UseCase 作成基準

以下の**いずれか**を満たす操作のみ UseCase にする:

1. 複数依存（Service / Store / State）の協調が必要
2. バリデーション + 外部操作の組み合わせ
3. 失敗処理・結果解釈・共有状態更新を伴う

読み取り専用のフェッチ（catalog 取得等）は Presenter → Service 直接呼び出しを正とし、
パススルー UseCase を作らない。mutable State の隠蔽だけが目的の書き込み転送 facade は
許容するが、新設時は本当に必要か再考する。

### Orchestrator 規約

「UseCase 同士は呼べない」制約を保ったまま複合フローを実現する唯一の合成点。

1. 依存方向は **Orchestrator → UseCase の一方向のみ**。UseCase は Orchestrator を知らない。
   Orchestrator 同士も呼ばない。呼び出しグラフは
   「Presentation → Orchestrator → UseCase → Service」の深さ固定 DAG に保つ
2. 持つのは**逐次実行・分岐・補償（rollback）・トランザクション境界のみ**。
   ビジネス検証・結果解釈は各 UseCase 内に置く
3. **作成基準**: 2 つ以上の UseCase の合成、または補償フローを持つ場合のみ。
   1 UseCase しか呼ばないなら作らない
4. Presentation は UseCase / Orchestrator のどちらも呼んでよい（合成が要るときだけ Orchestrator）

### エラー契約

- 失敗しうる操作は `OperationResult`（エラー型をジェネリクスで型付けしたもの）を返す。
  例外は「呼び出し側にバグがある」場合（引数契約違反等）のみ
- port（Service / Store）のエラー契約も OperationResult 返しに統一する（例外伝播契約を作らない）
- **UI 表示文言は Presentation の責務**。Application / Infrastructure は ErrorCode を返し、
  `ErrorMessage` はログ・診断用の開発者向け文言（英語）に限定する
- context 境界をまたぐエラーは受け側 context の ErrorCode へ変換してから返す
  （他 context の enum をそのまま漏らさない）
- キャンセルは `ct.ThrowIfCancellationRequested()` + 呼び出し側 `catch (OperationCanceledException)` に統一。
  OCE を握りつぶさない（Synchronizer のループ脱出での黙殺のみ許容）。
  catch フィルタは `when (ex is not OperationCanceledException)` 形式に統一

### Synchronizer

Service ↔ State の同期配線専用クラス。次の 2 形態のみ:

| 形態 | lifecycle | 用途 |
|:-----|:----------|:-----|
| push 購読型 | `Start()` + `IDisposable`。`CompositeDisposable` で購読管理、`_isStarted` で多重 Start ガード | Service のイベント / Observable を State へ反映 |
| poll 型 | `RunLoopAsync(CancellationToken)`。lifecycle は ct 任せ。共通基底（`PollingSynchronizerBase`）を継承 | 周期フェッチで State を更新 |

業務ルール（フィルタ・集計ポリシー）を Synchronizer に書かない（State または純関数へ）。

## Domain

| 種別 | 命名 | 責務 | 作成基準・契約 |
|:-----|:-----|:-----|:---------------|
| enum | 名詞 | 業務概念の分類 | |
| 値オブジェクト | 名詞 | 業務概念の不変条件・導出 | |

## Presentation

| 種別 | 命名 | 責務 | 作成基準・契約 |
|:-----|:-----|:-----|:---------------|
| Model | `*Model` | プレゼンテーション状態の ReactiveProperty 保持 + 自身の整合性ロジック（値域制約・導出・状態遷移） | 素通し setter だけの Model にしない。表示判定・フィルタ等の純粋ロジックは Presenter でなく Model へ |
| View | `*View` | UXML 参照・表示反映・入力の受け口 | UIDocument を持つ **MonoBehaviour**。**DI 依存を持たない受動的部品**。Presenter からメソッドを呼ばれ、入力を Observable で公開する |
| Presenter | `*Presenter` | Model / View / UseCase / Service の配線 | plain class + `IStartable`（または `IAsyncStartable`）+ `IDisposable` が原則。MonoBehaviour にするのは SerializeField / Unity イベント関数が必須の場合のみ |
| Manager | `*Manager` | View を持たない非同期ワークフローの進行制御（scene load/unload、dialog 待ち、loading overlay 等） | plain class。Application 呼び出しは境界タイミング（開始・終了・イベント発生時）に限定し、毎フレーム呼び出しは避ける |
| Provider | `*Provider` | Presentation 向けの asset・データ供給と解放管理 | Lease の取得・保持・解放を一元管理する |
| Binder | `*Binder` | UXML 部分木と状態の接続部品（dialog / リスト / スライダー行等） | View の内部部品。View と同じ受動性を保つ |

### Presenter が Service を直接利用してよい範囲

状態購読（`IReadOnly*State`）、読み取り専用フェッチ、ローカル設定（即時・可逆・共有状態なし）、
アセット取得、毎フレームのランタイム制御。
検証・失敗処理・共有状態更新を伴う操作は UseCase / Orchestrator 経由。

## Infrastructure

| 種別 | 命名 | 責務 | 作成基準・契約 |
|:-----|:-----|:-----|:---------------|
| HTTP adapter | `Http*Service` / `Http*Downloader` | backend API port の実装 | レスポンス解釈（deserialize・エラー分類・ページング）は共通基盤経由。各 adapter は path + DTO→モデル変換 + ErrorCode 変換のみ |
| 永続化 adapter | 媒体 prefix + `*Store`（例: `File*Store`） | Store port の実装 | |
| SDK adapter | SDK 名 prefix（例: `Vivox*` / `Fusion*` / `UnityAudio*`） | 外部 SDK の port 実装 | 1 クラス 1 port が原則。複数 port を 1 クラスで実装しない |
| Cache | `*Cache` | runtime cache（LRU 等） | 同形のキャッシュを型別にコピーしない（generic 化する） |
| DTO | `*Dto` | backend 契約のミラー | 公開ファイルで定義する（private nested にしない） |

## Composition / Shared

| 種別 | 命名 | 責務 | 作成基準・契約 |
|:-----|:-----|:-----|:---------------|
| LifetimeScope | `*LifetimeScope` | scope 単位の配線 | 配線のみ。実装ロジック・起動時副作用（外部ツール設定等）を持たない |
| Installer | `*Installer` | 機能単位の DI 登録分割 | LifetimeScope が肥大したら Installer へ分割する |
| SettingsAsset | `*SettingsAsset` | Unity Inspector で編集する ScriptableObject | 必ず `ToOptions()` を持つ。`CreateAssetMenu` のメニュー名・order は既存と衝突させない |
| Preferences | `*Preferences` | ユーザーが UI から変更し永続化する個人設定値 | `Settings` と呼ばない（asset / Options と混同するため） |
| Shared ユーティリティ | — | ビジネス意味を持たない技術部品 | 暗黙の副作用（ログ出力等）を持たない。失敗は戻り値で表現する（`TryParse` 形式等） |
