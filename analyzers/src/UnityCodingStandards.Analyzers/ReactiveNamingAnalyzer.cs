using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;

namespace UnityCodingStandards.Analyzers
{
    /// <summary>
    /// R3 の Observable / Subject / ReactiveProperty の命名・公開範囲を検査する（UCS0001〜UCS0005）。
    /// </summary>
    [DiagnosticAnalyzer(LanguageNames.CSharp)]
    public sealed class ReactiveNamingAnalyzer : DiagnosticAnalyzer
    {
        /// <inheritdoc />
        public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics { get; } =
            ImmutableArray.Create(
                Rules.ObservableSuffix,
                Rules.SubjectSuffix,
                Rules.SubjectMustBePrivate,
                Rules.ReactivePropertyNaming,
                Rules.ReadOnlyReactivePropertyNaming);

        /// <inheritdoc />
        public override void Initialize(AnalysisContext context)
        {
            context.EnableConcurrentExecution();
            context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
            context.RegisterSymbolAction(AnalyzeField, SymbolKind.Field);
            context.RegisterSymbolAction(AnalyzeProperty, SymbolKind.Property);
            context.RegisterSymbolAction(AnalyzeMethod, SymbolKind.Method);
        }

        private static void AnalyzeField(SymbolAnalysisContext context)
        {
            var field = (IFieldSymbol)context.Symbol;
            if (field.IsImplicitlyDeclared) return;
            if (!AnalysisScope.IsAnalyzableSymbol(field)) return;

            Check(context, field, field.Type, field.DeclaredAccessibility, "フィールド");
        }

        private static void AnalyzeProperty(SymbolAnalysisContext context)
        {
            var property = (IPropertySymbol)context.Symbol;
            if (property.IsImplicitlyDeclared) return;
            if (!AnalysisScope.IsAnalyzableSymbol(property)) return;
            if (AnalysisScope.SignatureIsFixedByBase(property)) return;

            Check(context, property, property.Type, property.DeclaredAccessibility, "プロパティ");
        }

        private static void AnalyzeMethod(SymbolAnalysisContext context)
        {
            var method = (IMethodSymbol)context.Symbol;
            if (method.MethodKind != MethodKind.Ordinary) return;
            if (!AnalysisScope.IsAnalyzableSymbol(method)) return;
            if (AnalysisScope.SignatureIsFixedByBase(method)) return;

            // メソッドは「Observable を返すなら Observable サフィックス」だけを見る。
            // Subject / ReactiveProperty を返すメソッドは公開範囲の規約側（フィールド）で捕まる。
            if (TypeClassification.ClassifyReactive(method.ReturnType) != ReactiveKind.Observable) return;
            if (NameConventions.HasSuffix(method.Name, "Observable")) return;

            Report(context, Rules.ObservableSuffix, method, "メソッド");
        }

        private static void Check(
            SymbolAnalysisContext context,
            ISymbol symbol,
            ITypeSymbol type,
            Accessibility accessibility,
            string memberLabel)
        {
            switch (TypeClassification.ClassifyReactive(type))
            {
                case ReactiveKind.Observable:
                    if (!NameConventions.HasSuffix(symbol.Name, "Observable"))
                    {
                        Report(context, Rules.ObservableSuffix, symbol, memberLabel);
                    }

                    break;

                case ReactiveKind.Subject:
                    if (!NameConventions.HasSuffix(symbol.Name, "Subject"))
                    {
                        Report(context, Rules.SubjectSuffix, symbol, memberLabel);
                    }

                    if (accessibility != Accessibility.Private)
                    {
                        Report(context, Rules.SubjectMustBePrivate, symbol, memberLabel);
                    }

                    break;

                case ReactiveKind.ReactiveProperty:
                    if (accessibility != Accessibility.Private ||
                        !NameConventions.IsUnderscoreCamelCase(symbol.Name))
                    {
                        Report(context, Rules.ReactivePropertyNaming, symbol, memberLabel);
                    }

                    break;

                case ReactiveKind.ReadOnlyReactiveProperty:
                    if (!NameConventions.IsPascalCase(symbol.Name))
                    {
                        Report(context, Rules.ReadOnlyReactivePropertyNaming, symbol, memberLabel);
                    }

                    break;

                case ReactiveKind.None:
                default:
                    break;
            }
        }

        private static void Report(
            SymbolAnalysisContext context,
            DiagnosticDescriptor descriptor,
            ISymbol symbol,
            string memberLabel)
        {
            foreach (var location in symbol.Locations)
            {
                if (!location.IsInSource) continue;
                context.ReportDiagnostic(Diagnostic.Create(descriptor, location, memberLabel, symbol.Name));
                return;
            }
        }
    }
}
