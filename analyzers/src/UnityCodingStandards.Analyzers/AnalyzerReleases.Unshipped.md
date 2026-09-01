; Unshipped analyzer release
; https://github.com/dotnet/roslyn-analyzers/blob/main/src/Microsoft.CodeAnalysis.Analyzers/ReleaseTrackingAnalyzers.Help.md

### New Rules

Rule ID | Category | Severity | Notes
--------|----------|----------|-------
UCS0001 | Naming | Warning | Observable を公開するメンバーは Observable サフィックスを付ける
UCS0002 | Naming | Warning | Subject は Subject サフィックスを付ける
UCS0003 | Naming | Warning | Subject は private のみ
UCS0004 | Naming | Warning | ReactiveProperty は private かつ _camelCase
UCS0005 | Naming | Warning | IReadOnlyReactiveProperty は PascalCase
UCS0006 | Async | Warning | 非同期メソッドは CancellationToken を引数に取る
UCS0007 | Async | Warning | CancellationToken 引数に既定値を付けない
UCS0008 | Async | Warning | 戻り値に Task 系を使わない（UniTask 系にする）
UCS0009 | Async | Warning | Coroutine を使わない
UCS0010 | Naming | Warning | 抽象基底クラスは Base サフィックスを付ける
