using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Text;
using NUnit.Framework;

namespace UnityCodingStandards.Analyzers.Tests
{
    /// <summary>Analyzer を 1 ファイルのソースに対して走らせ、診断 ID を取り出す。</summary>
    /// <remarks>
    /// Roslyn の <see cref="CSharpCompilation" /> を直接組む。Workspace 層を挟まないので
    /// 追加パッケージが要らず、SyntaxTree のパスも指定できる
    /// （解析対象の判定が <c>SyntaxTree.FilePath</c> を見るため、これが要る）。
    /// スタブは Assets/App/ の外に置く。外部ライブラリの実体はそこに無いので、
    /// スタブ自身が診断されるとテストの期待値が本題からずれる。
    /// </remarks>
    internal static class AnalyzerRun
    {
        // DocumentationMode.None で解析するのは、**Unity のコンパイルがこの設定**だから。
        // Diagnose にすると doc コメントが構造化トリビアになり、実機と挙動が変わる。
        private const DocumentationMode UnityDocumentationMode = DocumentationMode.None;

        internal static async Task<string[]> IdsAsync(
            DiagnosticAnalyzer analyzer,
            string source,
            string filePath = "")
        {
            // スタブは別ファイルとして渡す。連結すると using が namespace の後ろに来て
            // コンパイルできない。ファイルを分ければテスト側のソースは素直に書ける。
            var compilation = CSharpCompilation.Create(
                "TestProject",
                new[]
                {
                    Parse(TestSources.Stubs, "/packages/R3/Stubs.cs"),
                    Parse(source, filePath),
                },
                RuntimeReferences,
                new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

            AssertCompiles(compilation);

            var diagnostics = await compilation
                .WithAnalyzers(ImmutableArray.Create(analyzer))
                .GetAnalyzerDiagnosticsAsync();

            return diagnostics
                .Select(d => d.Id)
                .OrderBy(id => id, StringComparer.Ordinal)
                .ToArray();
        }

        private static SyntaxTree Parse(string source, string filePath) =>
            CSharpSyntaxTree.ParseText(
                SourceText.From(source),
                new CSharpParseOptions(LanguageVersion.Latest, UnityDocumentationMode),
                filePath);

        // テストソースがコンパイルできていないと、診断が出ないことを「違反なし」と読み違える。
        // 0 件を根拠に使うテストがあるので、ここで先に落とす。
        private static void AssertCompiles(CSharpCompilation compilation)
        {
            var errors = compilation.GetDiagnostics()
                .Where(d => d.Severity == DiagnosticSeverity.Error)
                .ToArray();

            if (errors.Length == 0) return;

            Assert.Fail(
                "テストソースがコンパイルできていない:" + Environment.NewLine +
                string.Join(Environment.NewLine, errors.Select(e => e.ToString())));
        }

        // 解析対象コードが参照する BCL。このテストプロセスが読み込んでいる実行時アセンブリを
        // そのまま使う。解析対象は BCL と TestSources のスタブしか使わないので、これで足りる。
        private static readonly IReadOnlyList<MetadataReference> RuntimeReferences =
            ((string?)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") ?? string.Empty)
            .Split(Path.PathSeparator)
            .Where(path => path.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
            .GroupBy(Path.GetFileName)
            .Select(group => group.First())
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .ToArray();
    }
}
