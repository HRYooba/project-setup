using Microsoft.CodeAnalysis;

namespace UnityCodingStandards.Analyzers
{
    /// <summary>
    /// 診断 ID と Descriptor の唯一の定義箇所。各 Analyzer はここを参照する。
    /// </summary>
    /// <remarks>
    /// ID は #pragma warning disable や配備先が置く .globalconfig から名指しされる公開契約。
    /// 既存 ID の意味を変えず、廃止したルールの ID は再利用しない
    /// （配備先の抑制設定が黙って別ルールに効いてしまう）。
    /// </remarks>
    internal static class Rules
    {
        private const string CategoryNaming = "Naming";
        private const string CategoryAsync = "Async";

        // 既定 severity は Warning 固定。Error にすると Unity が Safe Mode へ落ち、
        // 命名違反だけで Editor が作業不能になる。PR の gate は severity ではなく CI が担う
        // （コンパイルログの 'warning UCS' を拾って job を落とす）。
        private const DiagnosticSeverity Default = DiagnosticSeverity.Warning;

        internal static readonly DiagnosticDescriptor ObservableSuffix = new DiagnosticDescriptor(
            "UCS0001",
            "Observable を公開するメンバーは Observable サフィックスを付ける",
            "{0} '{1}' は Observable 型なので、名前の末尾を 'Observable' にする",
            CategoryNaming, Default, true,
            "coding-standards.md「Reactive Programming (R3)」: Observable は末尾に Observable を付与する。");

        internal static readonly DiagnosticDescriptor SubjectSuffix = new DiagnosticDescriptor(
            "UCS0002",
            "Subject は Subject サフィックスを付ける",
            "{0} '{1}' は Subject 型なので、名前の末尾を 'Subject' にする",
            CategoryNaming, Default, true,
            "coding-standards.md「Reactive Programming (R3)」: Subject は末尾に Subject を付与する。");

        internal static readonly DiagnosticDescriptor SubjectMustBePrivate = new DiagnosticDescriptor(
            "UCS0003",
            "Subject は private のみ",
            "{0} '{1}' は Subject 型なので private にする（公開するなら Observable として公開する）",
            CategoryNaming, Default, true,
            "coding-standards.md「Reactive Programming (R3)」: Subject は private のみ使用可能。");

        internal static readonly DiagnosticDescriptor ReactivePropertyNaming = new DiagnosticDescriptor(
            "UCS0004",
            "ReactiveProperty は private かつ _camelCase",
            "{0} '{1}' は ReactiveProperty 型なので private かつ '_camelCase' にする",
            CategoryNaming, Default, true,
            "coding-standards.md「Reactive Programming (R3)」: ReactiveProperty は '_' + camelCase、private のみ使用可能。");

        internal static readonly DiagnosticDescriptor ReadOnlyReactivePropertyNaming = new DiagnosticDescriptor(
            "UCS0005",
            "IReadOnlyReactiveProperty は PascalCase",
            "{0} '{1}' は IReadOnlyReactiveProperty 型なので PascalCase にする",
            CategoryNaming, Default, true,
            "coding-standards.md「Reactive Programming (R3)」: IReadOnlyReactiveProperty は PascalCase。");

        internal static readonly DiagnosticDescriptor AsyncNeedsCancellationToken = new DiagnosticDescriptor(
            "UCS0006",
            "非同期メソッドは CancellationToken を引数に取る",
            "非同期メソッド '{0}' は CancellationToken を引数に取る",
            CategoryAsync, Default, true,
            "coding-standards.md「非同期処理 (Async / UniTask)」: public / private を問わず非同期メソッドは CancellationToken を引数に取る。");

        internal static readonly DiagnosticDescriptor CancellationTokenNoDefault = new DiagnosticDescriptor(
            "UCS0007",
            "CancellationToken 引数に既定値を付けない",
            "'{0}' の CancellationToken 引数 '{1}' に既定値を付けない",
            CategoryAsync, Default, true,
            "coding-standards.md「非同期処理 (Async / UniTask)」: 'CancellationToken ct = default' は避ける（渡し忘れが黙って通る）。");

        internal static readonly DiagnosticDescriptor TaskReturnForbidden = new DiagnosticDescriptor(
            "UCS0008",
            "戻り値に Task / Task<T> を使わない",
            "メソッド '{0}' の戻り値は Task 系ではなく UniTask 系にする",
            CategoryAsync, Default, true,
            "coding-standards.md「非同期処理 (Async / UniTask)」: 戻り値は Task / Task<T> でなく UniTask / UniTask<T> を使う。");

        internal static readonly DiagnosticDescriptor CoroutineForbidden = new DiagnosticDescriptor(
            "UCS0009",
            "Coroutine を使わない",
            "{0} は Coroutine を使っている。UniTask に置き換える（[UnityTest] のみ例外）",
            CategoryAsync, Default, true,
            "coding-standards.md「非同期処理 (Async / UniTask)」: [UnityTest] を除き StartCoroutine / IEnumerator を使用しない。");

        internal static readonly DiagnosticDescriptor AbstractClassBaseSuffix = new DiagnosticDescriptor(
            "UCS0010",
            "抽象基底クラスは Base サフィックスを付ける",
            "抽象クラス '{0}' は名前の末尾を 'Base' にする",
            CategoryNaming, Default, true,
            "coding-standards.md「命名規則」: 抽象基底クラスは末尾に Base を付与する。");
    }
}
