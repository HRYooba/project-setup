# テスト実装ガイド（どう書くか）

`test-designing-guide.md` で「何を検証するか」を決めた後、NUnit テストコードに落とすための規約。
既存テストの実パターンに合わせる（新方式と既存が食い違う場合は本ガイドを正とする）。

---

## 1. 配置・命名・namespace

| 項目 | 規約 |
|:-----|:-----|
| ファイル配置 | `Assets/App/Scripts/Tests/EditMode/<Context>/<ClassName>Test.cs` |
| テストクラス名 | テスト対象名 + `Test`（**単数形**。`Tests` にしない）。ファイル名と一致 |
| namespace | `<Project>.Tests.<Context>`（例: `<Project>.Tests.Auth`。`<Project>` は既存テスト・asmdef 名で確認） |
| テストメソッド名（unit） | `MethodName_Condition_ExpectedResult`（対象がメソッドなのでメソッド名を含む）|
| パラメータ化の `Condition` | 個別引数の列挙でなく**同値区分名**を書く |

> 自動テストは EditMode unit のみ（`test-designing-guide.md` §2）。統合 / 視覚検証の命名規約（メソッド名なし）は使わない。

---

## 2. NUnit + UniTask の実行規約

### 非同期 SUT の駆動（プロジェクト標準）
UniTask を返す SUT は **`[Test] public void` + `.GetAwaiter().GetResult()`** で同期駆動する（stub は同期完了するため）。

```csharp
[Test]
public void ExecuteAsync_WhenSuccess_ReturnsUserProfile()
{
    var result = _useCase.ExecuteAsync("a@example.com", "password", CancellationToken.None)
        .GetAwaiter().GetResult();

    Assert.IsTrue(result.IsSuccess);
    Assert.AreEqual("user01", result.Value.UserId);
}
```

- `CancellationToken` は実引数に `CancellationToken.None` か、キャンセル検証時は `CancellationTokenSource` を渡す（`rules/coding-standards.md`: `ct = default` を避ける方針はプロダクト側。テストは明示的に `.None` を渡す）。
- `async Task` メソッド形式も可（ポーリングループ等、実際に await が要る場合）。ただし `async void` は禁止。
- `[UnityTest]` + `UniTask.ToCoroutine` は実フレーム経過が要る場合のみ。EditMode の純ロジックでは使わない。
- Coroutine（`IEnumerator` / `StartCoroutine`）は `[UnityTest]` を除き禁止（`rules/coding-standards.md`）。

### キャンセル検証
```csharp
using var cts = new CancellationTokenSource();
cts.Cancel();
Assert.Throws<OperationCanceledException>(
    () => _sut.ExecuteAsync(cts.Token).GetAwaiter().GetResult());
```

### Result 型のアサート
失敗しうる操作が Result 型（`OperationResult` 等）を返すプロジェクトでは:
- 成功: `Assert.IsTrue(result.IsSuccess)` → `result.Value`
- 失敗: `Assert.IsFalse(result.IsSuccess)` → `result.ErrorCode` が期待 enum と一致
- 開発者向け診断文言（`ErrorMessage` 等）は**値を assert しない**（存在確認に留める）

### 期待された警告 / エラーログ
失敗パスで `Debug.LogWarning` / `LogError` が出るテストは、`LogAssert` で抑止する:
```csharp
LogAssert.ignoreFailingMessages = true;
try { /* 実行 + assert */ }
finally { LogAssert.ignoreFailingMessages = false; }
```

---

## 3. テストダブルは共有定義を使う（private nested 禁止）

スタブ（Stub / Spy / Fake）は **`Tests/EditMode/TestDoubles/<Context>/` の共有定義**を使う（`rules/testing.md`）。
同一 interface のスタブを各テストファイルに private nested で重複定義しない。

**新しい interface のスタブが要るとき**は、まず該当 context の `<Context>TestDoubles.cs` に追加し、無ければ新規作成する。

### spy パターン（順序・呼び出しの観測）
共有スタブに **opt-in の `CallLog`** と結果上書きフィールドを持たせ、テスト側で必要なときだけ有効化する:

```csharp
// 共有スタブ側（TestDoubles/<Context>/<Context>TestDoubles.cs 等）
public List<string> CallLog;                       // opt-in。null なら記録しない
public OperationResult<RoomErrorCode> LeaveResult = OperationResult<RoomErrorCode>.Success();
public bool ThrowOceOnLeave;

public UniTask<OperationResult<RoomErrorCode>> LeaveRoomAsync(CancellationToken ct)
{
    if (ThrowOceOnLeave) throw new OperationCanceledException();
    CallLog?.Add("room.leave");
    return UniTask.FromResult(LeaveResult);
}
```

```csharp
// テスト側: 順序を実観測する（test-designing-guide §5 ゲート3）
var callLog = new List<string>();
_voiceService.CallLog = callLog;
_connectionService.CallLog = callLog;
_authService.CallLog = callLog;

_workflow.ExecuteAsync(CancellationToken.None).GetAwaiter().GetResult();

Assert.Less(callLog.IndexOf("room.leave"), callLog.IndexOf("auth.logout"),
    "room leave は auth logout より前である必要がある");
```

- 結果上書きフィールド（`LeaveResult` 等）= **stub**（arrange 関心事、検証に書かない）
- `CallLog` で呼び出し順を観測 = **spy**（検証対象）
- モック / スタブ生成フレームワーク（Moq 等）は使わない

---

## 4. パラメータ化テスト

同値区分が同じで期待結果も同じ複数ケースは `[TestCase]` / `[TestCaseSource]` で 1 メソッドに集約する。

```csharp
[TestCase("")]
[TestCase("   ")]
[TestCase(null)]
public void Set_WithBlankName_NormalizesToEmpty(string input)
{
    var result = _model.SetDisplayName(input);
    Assert.AreEqual(string.Empty, result);
}
```

- 本体に `if` / `switch` を書かない
- **期待値をパラメータ化しない**（期待が分岐するなら別区分 = 別メソッド）
- 3 パラメータ以上で各々多値なら pairwise で組合せを絞る

---

## 5. テンプレート

### plain class
```csharp
using System.Threading;
using Cysharp.Threading.Tasks;
using NUnit.Framework;
using <Project>.Tests.TestDoubles.<Context>;

namespace <Project>.Tests.<Context>
{
    [TestFixture]
    public class <ClassName>Test
    {
        private <ClassName> _sut;

        [SetUp]
        public void SetUp()
        {
            // 依存は共有スタブを new して注入
            _sut = new <ClassName>(/* stubs / states */);
        }

        [TearDown]
        public void TearDown()
        {
            // IDisposable な SUT / 依存は Dispose する
        }
    }
}
```

### 状態保持クラス（IDisposable を持つもの）
`SetUp` で `new`、`TearDown` で `Dispose()`。破棄後ガードや初期値契約を検証する場合は購読側視点で。

### MonoBehaviour（原則テスト対象外。designing-guide §1）
やむを得ず必要な場合のみ `new GameObject().AddComponent<T>()` → `TearDown` で `Object.DestroyImmediate`。
純ロジックが MonoBehaviour に埋まっている場合は、テストをこじ開けるのでなく plain class への分離を先に検討する。

---

## 6. asmdef

テスト asmdef は `Assets/App/Scripts/Tests/EditMode/` 配下にある（`<Project>.Tests.EditMode` 等）。
**まず実ファイルを読み**、対象アセンブリが `references` に含まれるか確認し、不足のみ追加する
（既存の references・設定を雛形で上書きしない）。

標準的な設定: `includePlatforms: ["Editor"]`, `precompiledReferences: ["nunit.framework.dll"]`,
`defineConstraints: ["UNITY_INCLUDE_TESTS"]`, `autoReferenced: false`, `overrideReferences: true`

新しい参照を足すときは、プロジェクトの依存方針（asmdef の参照方向）に反しないか確認する。

---

## 7. プロジェクト固有の注意

- **テスト実行は `/test-unity` 経由**（バインディング表の「テスト実行」直叩き禁止。`rules/testing.md`）。
- 全件実行で常に失敗する既知のテストは `rules/testing.md`「既知失敗テスト」に記録されている。green/red 判定はそれを除外して（またはプロジェクトのテスト assembly に限定して）行う。
- `R3` の `ReactiveProperty` は購読時に現在値を流す。初期値テストは「外部購読される状態の初期契約」に限り許容（`test-designing-guide.md` §8 例外）。
