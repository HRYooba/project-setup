using System;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace UnityCodingStandards.Analyzers
{
    /// <summary>
    /// 解析対象のコード（アプリ本体）の判定と、
    /// 規約を適用できないメンバー（基底で署名が決まるもの）の判定。
    /// </summary>
    internal static class AnalysisScope
    {
        // coding-standards.md はアプリ本体のコードに向けた規約で、その置き場は
        // folder-structure.md が Assets/App/ 配下と定めている。だから解析対象もそこだけにする。
        //
        // 除外リスト方式を採らない理由: Unity は Packages/ 配下（VRM / UniGLTF / Photon 等）の
        // コードまで同じコンパイルへ載せる。外部コードの置き場は列挙し切れないので、
        // 除外を数え上げる形にすると必ず漏れて、直せない箇所が warning で埋まる。
        private const string AnalyzableRoot = "Assets/App/";

        /// <summary>解析対象のファイルかどうか。Assets/App/ 配下だけ true。</summary>
        internal static bool IsAnalyzableFile(SyntaxTree tree)
        {
            var path = tree.FilePath;
            if (string.IsNullOrEmpty(path)) return true; // パスを持たない入力（テスト等）は解析する

            var normalized = path.Replace('\\', '/');
            return normalized.StartsWith(AnalyzableRoot, StringComparison.OrdinalIgnoreCase)
                || normalized.IndexOf("/" + AnalyzableRoot, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        /// <summary>
        /// 署名を自分で決められないメンバーか。override と interface 実装は基底側の宣言に
        /// 規約を当てるのが正しいので報告しない（直せない箇所を赤くすると lint ごと抑制される）。
        /// </summary>
        internal static bool SignatureIsFixedByBase(IMethodSymbol method)
        {
            if (method.IsOverride) return true;
            if (method.ExplicitInterfaceImplementations.Length > 0) return true;
            return ImplementsInterfaceMember(method);
        }

        /// <summary>プロパティ版。理由は <see cref="SignatureIsFixedByBase(IMethodSymbol)"/> と同じ。</summary>
        internal static bool SignatureIsFixedByBase(IPropertySymbol property)
        {
            if (property.IsOverride) return true;
            if (property.ExplicitInterfaceImplementations.Length > 0) return true;
            return ImplementsInterfaceMember(property);
        }

        private static bool ImplementsInterfaceMember(ISymbol member)
        {
            var containing = member.ContainingType;
            if (containing == null) return false;

            foreach (var iface in containing.AllInterfaces)
            {
                foreach (var ifaceMember in iface.GetMembers())
                {
                    if (ifaceMember.Kind != member.Kind) continue;
                    if (ifaceMember.Name != member.Name) continue;
                    var impl = containing.FindImplementationForInterfaceMember(ifaceMember);
                    if (impl != null && SymbolEqualityComparer.Default.Equals(impl, member)) return true;
                }
            }

            return false;
        }

        /// <summary>宣言位置のファイルから見て解析対象のシンボルか。</summary>
        internal static bool IsAnalyzableSymbol(ISymbol symbol)
        {
            var tree = symbol.Locations.FirstOrDefault(l => l.IsInSource)?.SourceTree;
            return tree == null || IsAnalyzableFile(tree);
        }

        /// <summary>[UnityTest] が付いたメソッドか。Coroutine 禁止の唯一の例外。</summary>
        internal static bool IsUnityTestMethod(IMethodSymbol method) =>
            method.GetAttributes().Any(a => a.AttributeClass?.Name is "UnityTestAttribute" or "UnityTest");

        /// <summary>宣言を囲む最も近いメソッド宣言。メソッド外なら null。</summary>
        internal static MethodDeclarationSyntax? EnclosingMethod(SyntaxNode node)
        {
            for (SyntaxNode? current = node; current != null; current = current.Parent)
            {
                if (current is MethodDeclarationSyntax method) return method;
                if (current is TypeDeclarationSyntax) return null;
            }

            return null;
        }
    }
}
