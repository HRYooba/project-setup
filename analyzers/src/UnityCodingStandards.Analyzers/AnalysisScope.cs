using System;
using System.Collections.Concurrent;
using System.IO;
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
        // folder-structure.md が定めている。だから解析対象もそこだけにする。
        //
        // 除外リスト方式を採らない理由: Unity は Packages/ 配下（VRM / UniGLTF / Photon 等）の
        // コードまで同じコンパイルへ載せる。外部コードの置き場は列挙し切れないので、
        // 除外を数え上げる形にすると必ず漏れて、直せない箇所が warning で埋まる。
        internal const string DefaultAnalyzableRoot = "Assets/App/";

        // アプリ本体の置き場は配備先ごとに選べる（setup-unity の --app-root）。その値を
        // analyzer へ渡す経路が **.editorconfig / .globalconfig ではない** のは、
        // **Unity がそれらを C# コンパイラへ渡さない**ため（analyzers/README.md が正本）。
        // 代わりに setup-unity が DLL の隣へ 1 行のマーカーを書き、ここが読む。
        //
        //   <project>/Assets/Analyzers/analyzable-root.txt
        //
        // 無い・読めない場合は既定値へ倒す（規約の既定と同じ Assets/App/）。判定を止めるより、
        // 既定で動いて配備先が気づける方が害が小さい。
        private const string MarkerRelativePath = "Assets/Analyzers/analyzable-root.txt";
        private const string AssetsSegment = "/Assets/";

        // プロジェクトルート → 解析対象ルート のキャッシュ。analyzer はファイルごとに呼ばれるため、
        // キャッシュしないとコンパイル 1 回でマーカーを数千回読むことになる。
        private static readonly ConcurrentDictionary<string, string> RootCache =
            new ConcurrentDictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        /// <summary>解析対象のファイルかどうか。設定された解析対象ルート配下だけ true。</summary>
        internal static bool IsAnalyzableFile(SyntaxTree tree)
        {
            var path = tree.FilePath;
            if (string.IsNullOrEmpty(path)) return true; // パスを持たない入力（テスト等）は解析する

            var normalized = path.Replace('\\', '/');
            var root = ResolveAnalyzableRoot(normalized);
            return normalized.StartsWith(root, StringComparison.OrdinalIgnoreCase)
                || normalized.IndexOf("/" + root, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        /// <summary>
        /// このファイルが属するプロジェクトの解析対象ルートを返す（末尾スラッシュ付き）。
        /// プロジェクトルートは <c>Assets/</c> セグメントの手前と見なす。Unity がコンパイルへ
        /// 載せるコードは必ず <c>Assets/</c> か <c>Packages/</c> の下にあり、規約が対象にするのは
        /// 前者だけなので、この 1 手で足りる（ディレクトリを 1 段ずつ遡らない）。
        /// </summary>
        private static string ResolveAnalyzableRoot(string normalizedPath)
        {
            var projectRoot = ProjectRootOf(normalizedPath);
            if (projectRoot == null) return DefaultAnalyzableRoot;

            return RootCache.GetOrAdd(projectRoot, ReadMarker);
        }

        /// <summary>
        /// 正規化済みパスから <c>Assets/</c> の手前までを返す（末尾スラッシュ付き。相対パスなら空文字）。
        /// <c>Assets/</c> を含まなければ null。
        /// </summary>
        private static string? ProjectRootOf(string normalizedPath)
        {
            if (normalizedPath.StartsWith("Assets/", StringComparison.OrdinalIgnoreCase)) return string.Empty;

            var at = normalizedPath.IndexOf(AssetsSegment, StringComparison.OrdinalIgnoreCase);
            return at >= 0 ? normalizedPath.Substring(0, at + 1) : null;
        }

        /// <summary>マーカーを読む。無い・空・読めないなら既定値。</summary>
        private static string ReadMarker(string projectRoot)
        {
            try
            {
                var marker = projectRoot + MarkerRelativePath;
                if (!File.Exists(marker)) return DefaultAnalyzableRoot;

                foreach (var raw in File.ReadAllLines(marker))
                {
                    var line = raw.Trim();
                    // 生成物である旨をファイル自身へ書けるよう、# 始まりは注釈として読み飛ばす。
                    if (line.Length == 0 || line[0] == '#') continue;
                    return Normalize(line);
                }
            }
            catch (IOException)
            {
                // 読めないだけ。既定へ倒す（analyzer が例外で落ちるとコンパイルごと巻き込む）。
            }
            catch (UnauthorizedAccessException)
            {
            }

            return DefaultAnalyzableRoot;
        }

        /// <summary>区切り・前後スラッシュのゆらぎを吸収し、末尾スラッシュ付きで返す。</summary>
        private static string Normalize(string value)
        {
            var t = value.Replace('\\', '/').Trim('/');
            return t.Length == 0 ? DefaultAnalyzableRoot : t + "/";
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
