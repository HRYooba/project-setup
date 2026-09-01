using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;

namespace UnityCodingStandards.Analyzers
{
    /// <summary>
    /// 非同期メソッドの署名を検査する（UCS0006 CancellationToken 必須 / UCS0007 既定値禁止 / UCS0008 Task 禁止）。
    /// </summary>
    [DiagnosticAnalyzer(LanguageNames.CSharp)]
    public sealed class AsyncSignatureAnalyzer : DiagnosticAnalyzer
    {
        /// <inheritdoc />
        public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics { get; } =
            ImmutableArray.Create(
                Rules.AsyncNeedsCancellationToken,
                Rules.CancellationTokenNoDefault,
                Rules.TaskReturnForbidden);

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
            if (!TypeClassification.IsAsyncReturnType(method.ReturnType)) return;

            var location = method.Locations.FirstOrDefault(l => l.IsInSource);
            if (location == null) return;

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
