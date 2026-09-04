using System;
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

            // 呼び出しの形は 2 つある。修飾あり（LifetimeScope.Find(...)）と、
            // MonoBehaviour 内から修飾なしで撃つ形（FindFirstObjectByType<T>()）。
            // 後者は MemberAccess にならないので、名前だけを取り出して両方を受ける。
            var (methodName, receiver) = invocation.Expression switch
            {
                MemberAccessExpressionSyntax member => (member.Name.Identifier.ValueText, member.Expression),
                SimpleNameSyntax simple => (simple.Identifier.ValueText, null),
                _ => (null, null),
            };

            if (methodName is not ("Find" or "FindObjectOfType" or "FindFirstObjectByType" or "FindAnyObjectByType")) return;
            if (context.SemanticModel.GetSymbolInfo(invocation, context.CancellationToken).Symbol is not IMethodSymbol method) return;

            // **受け手か呼び出し先が LifetimeScope 系であることを要求する。**
            // 型引数だけを見ると repository.Find<AppLifetimeScope>() のような
            // 無関係な汎用 Find<T> を巻き込む（誤検知は規約への信頼を壊す）。
            if (!IsLifetimeScopeLookup(context, method, receiver)) return;

            var shown = receiver == null ? $"{methodName}(...)" : $"{receiver}.{methodName}(...)";
            context.ReportDiagnostic(Diagnostic.Create(Rules.DiContainerLookupForbidden, invocation.GetLocation(), shown));
        }

        private static bool IsLifetimeScopeLookup(
            SyntaxNodeAnalysisContext context,
            IMethodSymbol method,
            ExpressionSyntax? receiver)
        {
            // LifetimeScope.Find(...) — 受け手が LifetimeScope 系
            if (receiver != null)
            {
                var receiverType = context.SemanticModel.GetTypeInfo(receiver, context.CancellationToken).Type
                    ?? context.SemanticModel.GetSymbolInfo(receiver, context.CancellationToken).Symbol as ITypeSymbol;
                if (IsLifetimeScope(receiverType)) return true;
            }

            // 宣言側が LifetimeScope 系（自前の static ヘルパー等）
            if (IsLifetimeScope(method.ContainingType)) return true;

            // Unity の探索 API に LifetimeScope を型引数で渡す形。
            // 宣言型が UnityEngine.Object 系のものだけを認め、任意の Find<T> は認めない。
            if (IsUnityObjectLookup(method))
            {
                foreach (var argument in method.TypeArguments)
                {
                    if (IsLifetimeScope(argument)) return true;
                }
            }

            return false;
        }

        private static bool IsLifetimeScope(ITypeSymbol? type)
        {
            for (var current = type; current != null; current = current.BaseType)
            {
                if (current.Name.EndsWith("LifetimeScope", StringComparison.Ordinal)) return true;
            }

            return false;
        }

        // UnityEngine.Object の静的探索 API か。名前空間で確かめる（名前だけでは広すぎる）。
        private static bool IsUnityObjectLookup(IMethodSymbol method)
        {
            for (var current = method.ContainingType; current != null; current = current.BaseType)
            {
                if (current.Name == "Object" && current.ContainingNamespace?.ToDisplayString() == "UnityEngine") return true;
            }

            return false;
        }
    }
}
