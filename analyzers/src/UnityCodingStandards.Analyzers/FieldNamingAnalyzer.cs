using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;

namespace UnityCodingStandards.Analyzers
{
    /// <summary>
    /// フィールドの命名と可視性を検査する（UCS0012 private は _camelCase / UCS0013 SerializeField は private）。
    /// </summary>
    /// <remarks>
    /// 既製の naming rules（<c>.editorconfig</c> の <c>dotnet_naming_rule</c>）で書ける内容だが、
    /// Unity は <c>.editorconfig</c> を C# コンパイラへ渡さないため、その経路では担保できない。
    /// </remarks>
    [DiagnosticAnalyzer(LanguageNames.CSharp)]
    public sealed class FieldNamingAnalyzer : DiagnosticAnalyzer
    {
        /// <inheritdoc />
        public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics { get; } =
            ImmutableArray.Create(
                Rules.PrivateFieldNaming,
                Rules.SerializeFieldMustBePrivate);

        /// <inheritdoc />
        public override void Initialize(AnalysisContext context)
        {
            context.EnableConcurrentExecution();
            context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
            context.RegisterSymbolAction(AnalyzeField, SymbolKind.Field);
        }

        private static void AnalyzeField(SymbolAnalysisContext context)
        {
            var field = (IFieldSymbol)context.Symbol;
            if (field.IsImplicitlyDeclared) return; // プロパティのバッキングフィールド等
            if (!AnalysisScope.IsAnalyzableSymbol(field)) return;

            // enum メンバーはフィールドとして現れるが、命名規約の対象ではない。
            if (field.ContainingType?.TypeKind == TypeKind.Enum) return;

            // 定数の形は規約が定めていない（coding-standards.md に項目が無い）。
            if (field.IsConst) return;

            var location = field.Locations.FirstOrDefault(l => l.IsInSource);
            if (location == null) return;

            var isSerializeField = HasSerializeFieldAttribute(field);

            // SerializeField は private でなければならない。Inspector から触るための属性であって、
            // 公開面を広げる理由にはならない。
            if (isSerializeField && field.DeclaredAccessibility != Accessibility.Private)
            {
                context.ReportDiagnostic(Diagnostic.Create(
                    Rules.SerializeFieldMustBePrivate,
                    location,
                    field.Name,
                    field.DeclaredAccessibility.ToString().ToLowerInvariant()));
            }

            if (field.DeclaredAccessibility != Accessibility.Private) return;

            // ReactiveProperty は UCS0004 が名前と可視性をまとめて見る。二重に報告しない。
            if (TypeClassification.ClassifyReactive(field.Type) != ReactiveKind.None) return;

            if (NameConventions.IsUnderscoreCamelCase(field.Name)) return;

            context.ReportDiagnostic(Diagnostic.Create(Rules.PrivateFieldNaming, location, field.Name));
        }

        private static bool HasSerializeFieldAttribute(IFieldSymbol field) =>
            field.GetAttributes().Any(a =>
                a.AttributeClass?.Name is "SerializeFieldAttribute" or "SerializeField");
    }
}
