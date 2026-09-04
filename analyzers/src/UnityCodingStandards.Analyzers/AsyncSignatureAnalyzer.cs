using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;

namespace UnityCodingStandards.Analyzers
{
    /// <summary>
    /// 非同期メソッドの署名を検査する（UCS0006 CancellationToken 必須 / UCS0007 既定値禁止 /
    /// UCS0008 Task 禁止 / UCS0011 Async サフィックス）。
    /// </summary>
    [DiagnosticAnalyzer(LanguageNames.CSharp)]
    public sealed class AsyncSignatureAnalyzer : DiagnosticAnalyzer
    {
        /// <inheritdoc />
        public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics { get; } =
            ImmutableArray.Create(
                Rules.AsyncNeedsCancellationToken,
                Rules.CancellationTokenNoDefault,
                Rules.TaskReturnForbidden,
                Rules.AsyncMethodSuffix);

        /// <inheritdoc />
        public override void Initialize(AnalysisContext context)
        {
            context.EnableConcurrentExecution();
            context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
            context.RegisterSymbolAction(AnalyzeMethod, SymbolKind.Method);
        }

        private static void AnalyzeMethod(SymbolAnalysisContext context)
        {
            var method = (IMethodSymbol)context.Symbol;
            if (method.MethodKind != MethodKind.Ordinary) return;
            if (!AnalysisScope.IsAnalyzableSymbol(method)) return;
            if (AnalysisScope.SignatureIsFixedByBase(method)) return;
            var location = method.Locations.FirstOrDefault(l => l.IsInSource);
            if (location == null) return;

            // Async サフィックス（UCS0011）は「非同期メソッド」全体に当たる規約。
            // 非同期の戻り値型を持つ形と、戻り値型がホワイトリストに載らない形（async void 等）の
            // 両方を対象にする。呼び出し側が await 忘れに気付けなくなるのはどちらも同じ。
            // 署名の検査（CancellationToken / Task 禁止）は戻り値型を見る規則なので広げない。
            var isAsyncMethod = method.IsAsync || TypeClassification.IsAsyncReturnType(method.ReturnType);
            if (isAsyncMethod && !NameConventions.HasSuffix(method.Name, "Async"))
            {
                context.ReportDiagnostic(Diagnostic.Create(Rules.AsyncMethodSuffix, location, method.Name));
            }

            if (!TypeClassification.IsAsyncReturnType(method.ReturnType)) return;

            if (TypeClassification.IsTaskReturnType(method.ReturnType))
            {
                context.ReportDiagnostic(
                    Diagnostic.Create(Rules.TaskReturnForbidden, location, method.Name));
            }

            var cancellationTokens = method.Parameters
                .Where(p => TypeClassification.IsCancellationToken(p.Type))
                .ToArray();

            if (cancellationTokens.Length == 0)
            {
                context.ReportDiagnostic(
                    Diagnostic.Create(Rules.AsyncNeedsCancellationToken, location, method.Name));
                return;
            }

            foreach (var parameter in cancellationTokens)
            {
                if (!parameter.HasExplicitDefaultValue) continue;

                var parameterLocation = parameter.Locations.FirstOrDefault(l => l.IsInSource) ?? location;
                context.ReportDiagnostic(
                    Diagnostic.Create(Rules.CancellationTokenNoDefault, parameterLocation, method.Name, parameter.Name));
            }
        }
    }
}
