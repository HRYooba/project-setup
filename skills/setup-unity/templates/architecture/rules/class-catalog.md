<!-- agents-md: include -->

# クラス種別カタログ

**本カタログは、各層に置かれる代表的なクラス種別の対応表であり、網羅ではない。**
一覧に無いクラスを禁じる趣旨ではないので、当てはまる種別が無ければ新しい概念を作ってよい
（厳密な許可リストではなく、必要なら例外も可）。

一方で、**表に載っている種別を使うなら、その行の規約（命名・責務・作成基準・lifecycle 契約）は守る**。
その規約に従わない使い方をするなら、種別名を借りずに別の名前を付ける
（`*UseCase` を名乗るなら UseCase の契約に従う、という趣旨。名前と契約を食い違わせない）。

層の原則・依存方向は `rules/architecture.md` を参照。

## Application

| 種別 | 命名 | 責務 | 作成基準・契約 |
|:-----|:-----|:-----|:---------------|
| UseCase | 動詞 + 名詞 + `UseCase`、公開エントリは原則 `ExecuteAsync` 1 つ | 単一のアプリケーション操作（検証・実行・結果解釈） | 状態を変える操作は必ず UseCase を通す。読み取りは Presenter から直接でもよく、素通しの読み取り UseCase は作らない（複数 source の組み合わせ・解釈が要るときは作る）。**他の UseCase / Orchestrator を呼ばない** |
| Orchestrator | `*Orchestrator` | 複数 UseCase の逐次実行・分岐・補償（rollback） | 2 つ以上の UseCase の合成か、補償が要るときだけ作る。持つのは順序・分岐・補償のみ（検証・結果解釈は UseCase）。Orchestrator 同士は呼ばない |
| State | `*State` + `IReadOnly*State` | runtime current value の保持・公開 | Presentation へは `IReadOnly*State` のみ DI 登録する |
| Repository | `I*Repository` | 集約ルートの永続化 port | 集約ルートごとに 1 つ。テーブル・Entity ごとに作らない。current value を保持しない（保持は State） |
| Store | `I*Store` | 集約ルート以外（設定値・キャッシュ等）の永続化の load / save port | current value を保持しない（保持は State）。永続化結果と State の整合は UseCase / Orchestrator が担う |
| Service | `I*Service` | 外部サービスへの port | 1 interface 1 責務。責務が混ざったら分割する |
| ErrorCode | `*ErrorCode` | context ごとの失敗分岐 enum | **`None = 0` を必ず持つ**（成功結果のエラー値は既定値 0 になるため、0 を実エラーに割り当てると成功結果が実エラー値を持ってしまう）。失敗結果に `None` を渡さない |
| DTO | 名詞（`Dto` サフィックスを**付けない**。Infrastructure の backend ミラー DTO と区別するため） | 層間データ運搬 | `readonly struct` または `record`。mutable にしない。Unity asset 参照を持たない（必要なら asset key / ID を持つ）。MonoBehaviour / Component 参照を持たない |
| Handle | `*Handle` | ライフサイクル管理付き asset 保持 | DTO の asset 禁止規定の**明示的例外**。`IDisposable` 必須で、Dispose は 1 回だけ。Dispose 後に実体が解放されるか（参照カウント等で生存するか）は型名に出さない。保持する asset を書き換えない・`Destroy` しない |
| Options | `*Options` | 起動時確定の immutable 設定値 | `SettingsAsset.ToOptions()` で生成。値域 clamp は Options 側に置く（SettingsAsset と二重実装しない） |
| Preferences | `*Preferences` | ユーザーが UI から変更し永続化する個人設定値 | `Settings` と呼ばない（asset / Options と混同するため） |

## Presentation

| 種別 | 命名 | 責務 | 作成基準・契約 |
|:-----|:-----|:-----|:---------------|
| Model | `*Model` | プレゼンテーション状態の ReactiveProperty 保持 + 自身の整合性ロジック（値域制約・導出・状態遷移） | 素通し setter だけの Model にしない。表示判定・フィルタ等の純粋ロジックは Presenter でなく Model へ |
| View | `*View` | UXML 参照・表示反映・入力の受け口 | UIDocument を持つ **MonoBehaviour**。**DI 依存を持たない受動的部品**。Presenter からメソッドを呼ばれ、入力を Observable で公開する |
| Presenter | `*Presenter` | Model / View / UseCase / Service の配線 | Service を直接呼んでよいのは読み取りと毎フレームのランタイム制御のみ。plain class + `IStartable`（または `IAsyncStartable`）+ `IDisposable` が原則。MonoBehaviour にするのは SerializeField / Unity イベント関数が必須の場合のみ |
| Manager | `*Manager` | View を持たない非同期ワークフローの進行制御（scene load/unload、dialog 待ち、loading overlay 等） | plain class。Application 呼び出しは境界タイミング（開始・終了・イベント発生時）に限定し、毎フレーム呼び出しは避ける |
| Provider | `*Provider` | Presentation 向けの asset・データ供給と解放管理 | Handle の取得・保持・解放を一元管理する |
| Binder | `*Binder` | UXML 部分木と状態の接続部品（dialog / リスト / スライダー行等） | View の内部部品。View と同じ受動性を保つ |

## Infrastructure

| 種別 | 命名 | 責務 | 作成基準・契約 |
|:-----|:-----|:-----|:---------------|
| Adapter | 技術 prefix + port 名（例: `Http*Service` / `File*Store`） | Repository / Store / Service port の実装 | 1 クラス 1 port。複数 port を 1 クラスで実装しない |
| Cache | `*Cache` | runtime cache（LRU 等） | |
| DTO | `*Dto` | backend 契約のミラー | 公開ファイルで定義する（private nested にしない） |
| Listener | `*Listener` | 外部からの push（SDK イベント・通知）を受けて UseCase を呼ぶ入口 | `Start()` + `IDisposable`。State を直接書かない |
| Poller | `*Poller` | 外部を定期取得して UseCase を呼ぶ入口 | `RunLoopAsync(CancellationToken)`。State を直接書かない。ループ脱出時の OperationCanceledException の黙殺のみ許容 |

## Composition

| 種別 | 命名 | 責務 | 作成基準・契約 |
|:-----|:-----|:-----|:---------------|
| LifetimeScope | `*LifetimeScope` | scope 単位の配線 | 配線のみ。実装ロジック・起動時副作用を持たない |
| Installer | `*Installer` | 機能単位の DI 登録分割 | 複数 scope から使い回す、または差し替える単位のときに分ける。1 つの LifetimeScope からしか呼ばれず差し替えもしないなら分けない |
| EntryPoint | `*EntryPoint` | DI コンテナの lifecycle（`IStartable` / `IAsyncStartable` / `IDisposable`）に載せる起動・停止 adapter | plain class。**業務ロジックを持たず起動・停止のみ**。起動対象（Listener / Poller 等）へ渡す CancellationToken の生成・cancel を担う |
| SettingsAsset | `*SettingsAsset` | Unity Inspector で編集する ScriptableObject | 必ず `ToOptions()` を持つ。`CreateAssetMenu` のメニュー名・order は既存と衝突させない |

## Shared

| 種別 | 命名 | 責務 | 作成基準・契約 |
|:-----|:-----|:-----|:---------------|
| Shared ユーティリティ | — | ビジネス意味を持たない技術部品 | 暗黙の副作用（ログ出力等）を持たない。失敗は戻り値で表現する（`TryParse` 形式等） |
