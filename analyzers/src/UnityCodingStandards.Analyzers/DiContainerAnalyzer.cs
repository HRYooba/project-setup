using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace UnityCodingStandards.Analyzers
{
    /// <summary>DI コンテナの探索による自己注入を検出する（UCS0015）。</summary>
    /// <remarks>
    /// 見るのは <c>LifetimeScope.Find(...)</c> のような**探索**の呼び出しだけ。「Composition Root の
    /// 外か」で判定しない — Composition Root の置き場はレイヤード構成のときだけ決まっていて、
    /// base 構成では規約が場所を定めていないため、場所を条件にすると配備先によって誤検知になる。
    /// 探索そのものは Composition Root の中でも不要（そこはコンテナを直接持っている）。
    /// </remarks>
    [DiagnosticAnalyzer(LanguageNames.CSharp)]
    public sealed class DiContainerAnalyzer : DiagnosticAnalyzer
    {
        /// <inheritdoc />
        public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics { get; } =
            ImmutableArray.Create(Rules.DiContainerLookupForbidden);

        /// <inheritdoc />
        public override void Initialize(AnalysisContext context)
        {
            context.EnableConcurrentExecution();
            context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
            context.RegisterSyntaxNodeAction(AnalyzeInvocation, SyntaxKind.InvocationExpression);
        }

        private static void AnalyzeInvocation(SyntaxNodeAnalysisContext context)
        {
            if (!AnalysisScope.IsAnalyzableFile(context.Node.SyntaxTree)) return;

            var invocation = (InvocationExpressionSyntax)context.Node;
            if (invocation.Expression is not MemberAccessExpressionSyntax member) return;

            // 探索の入口だけを見る。Find / FindObjectOfType 等は名前だけでは広すぎるので、
            // 受け手が LifetimeScope 系であることを型で確かめる。
            var methodName = member.Name.Identifier.ValueText;
            if (methodName is not ("Find" or "FindObjectOfType" or "FindFirstObjectByType" or "FindAnyObjectByType")) return;

            var receiver = context.SemanticModel.GetTypeInfo(member.Expression, context.CancellationToken).Type
                ?? context.SemanticModel.GetSymbolInfo(member.Expression, context.CancellationToken).Symbol as ITypeSymbol;

            if (!IsLifetimeScope(receiver) && !IsLifetimeScopeTypeArgument(context, invocation)) return;

            context.ReportDiagnostic(Diagnostic.Create(
                Rules.DiContainerLookupForbidden,
                invocation.GetLocation(),
                $"{member.Expression}.{methodName}(...)"));
        }

        private static bool IsLifetimeScope(ITypeSymbol? type)
        {
            for (var current = type; current != null; current = current.BaseType)
            {
                if (current.Name.EndsWith("LifetimeScope", System.StringComparison.Ordinal)) return true;
            }

            return false;
        }

        // FindFirstObjectByType<AppLifetimeScope>() のように型引数側へ現れる形。
        private static bool IsLifetimeScopeTypeArgument(SyntaxNodeAnalysisContext context, InvocationExpressionSyntax invocation)
        {
            if (context.SemanticModel.GetSymbolInfo(invocation, context.CancellationToken).Symbol is not IMethodSymbol method) return false;

            foreach (var argument in method.TypeArguments)
            {
                if (IsLifetimeScope(argument)) return true;
            }

            return false;
        }
    }
}
