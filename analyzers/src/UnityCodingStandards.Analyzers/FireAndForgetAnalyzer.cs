using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;

namespace UnityCodingStandards.Analyzers
{
    /// <summary>UniTaskVoid の await を検出する（UCS0014）。</summary>
    /// <remarks>
    /// UniTaskVoid は await されない前提の戻り値型で、await すると例外が呼び出し側へ伝わらない
    /// 経路が生まれる。fire-and-forget なら <c>.Forget()</c> で明示し、待つなら UniTask を返す。
    /// </remarks>
    [DiagnosticAnalyzer(LanguageNames.CSharp)]
    public sealed class FireAndForgetAnalyzer : DiagnosticAnalyzer
    {
        /// <inheritdoc />
        public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics { get; } =
            ImmutableArray.Create(Rules.UniTaskVoidNotAwaited);

        /// <inheritdoc />
        public override void Initialize(AnalysisContext context)
        {
            context.EnableConcurrentExecution();
            context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
            context.RegisterSyntaxNodeAction(AnalyzeAwait, SyntaxKind.AwaitExpression);
        }

        private static void AnalyzeAwait(SyntaxNodeAnalysisContext context)
        {
            if (!AnalysisScope.IsAnalyzableFile(context.Node.SyntaxTree)) return;

            var expression = (AwaitExpressionSyntax)context.Node;
            var awaited = context.SemanticModel.GetTypeInfo(expression.Expression, context.CancellationToken).Type;
            if (awaited?.Name != "UniTaskVoid") return;

            context.ReportDiagnostic(Diagnostic.Create(Rules.UniTaskVoidNotAwaited, expression.GetLocation()));
        }
    }
}
