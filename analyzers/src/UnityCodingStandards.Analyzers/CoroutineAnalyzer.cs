using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace UnityCodingStandards.Analyzers
{
    /// <summary>Coroutine の使用を検出する（UCS0009）。[UnityTest] を付けたメソッドだけが例外。</summary>
    [DiagnosticAnalyzer(LanguageNames.CSharp)]
    public sealed class CoroutineAnalyzer : DiagnosticAnalyzer
    {
        /// <inheritdoc />
        public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics { get; } =
            ImmutableArray.Create(Rules.CoroutineForbidden);

        /// <inheritdoc />
        public override void Initialize(AnalysisContext context)
        {
            context.EnableConcurrentExecution();
            context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
            context.RegisterSymbolAction(AnalyzeMethod, SymbolKind.Method);
            context.RegisterSyntaxNodeAction(AnalyzeInvocation, SyntaxKind.InvocationExpression);
        }

        private static void AnalyzeMethod(SymbolAnalysisContext context)
        {
            var method = (IMethodSymbol)context.Symbol;
            if (method.MethodKind != MethodKind.Ordinary) return;
            if (!AnalysisScope.IsAnalyzableSymbol(method)) return;
            if (AnalysisScope.SignatureIsFixedByBase(method)) return;
            if (AnalysisScope.IsUnityTestMethod(method)) return;
            if (!TypeClassification.IsEnumerator(method.ReturnType)) return;

            var location = method.Locations.FirstOrDefault(l => l.IsInSource);
            if (location == null) return;

            context.ReportDiagnostic(
                Diagnostic.Create(Rules.CoroutineForbidden, location, $"メソッド '{method.Name}'"));
        }

        private static void AnalyzeInvocation(SyntaxNodeAnalysisContext context)
        {
            if (!AnalysisScope.IsAnalyzableFile(context.Node.SyntaxTree)) return;

            var invocation = (InvocationExpressionSyntax)context.Node;
            var name = invocation.Expression switch
            {
                MemberAccessExpressionSyntax member => member.Name.Identifier.ValueText,
                IdentifierNameSyntax identifier => identifier.Identifier.ValueText,
                _ => null,
            };

            if (name is not ("StartCoroutine" or "StopCoroutine" or "StopAllCoroutines")) return;

            var enclosing = AnalysisScope.EnclosingMethod(invocation);
            if (enclosing != null &&
                context.SemanticModel.GetDeclaredSymbol(enclosing) is IMethodSymbol enclosingSymbol &&
                AnalysisScope.IsUnityTestMethod(enclosingSymbol))
            {
                return;
            }

            context.ReportDiagnostic(
                Diagnostic.Create(Rules.CoroutineForbidden, invocation.GetLocation(), $"'{name}' の呼び出し"));
        }
    }
}
