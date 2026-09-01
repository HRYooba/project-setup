using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;

namespace UnityCodingStandards.Analyzers
{
    /// <summary>抽象基底クラスの命名を検査する（UCS0010）。</summary>
    [DiagnosticAnalyzer(LanguageNames.CSharp)]
    public sealed class TypeNamingAnalyzer : DiagnosticAnalyzer
    {
        /// <inheritdoc />
        public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics { get; } =
            ImmutableArray.Create(Rules.AbstractClassBaseSuffix);

        /// <inheritdoc />
        public override void Initialize(AnalysisContext context)
        {
            context.EnableConcurrentExecution();
            context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
            context.RegisterSymbolAction(AnalyzeType, SymbolKind.NamedType);
        }

        private static void AnalyzeType(SymbolAnalysisContext context)
        {
            var type = (INamedTypeSymbol)context.Symbol;
            if (type.TypeKind != TypeKind.Class) return;
            if (!type.IsAbstract || type.IsStatic) return;
            if (type.IsImplicitlyDeclared) return;
            if (!AnalysisScope.IsAnalyzableSymbol(type)) return;
            if (NameConventions.HasSuffix(type.Name, "Base")) return;

            var location = type.Locations.FirstOrDefault(l => l.IsInSource);
            if (location == null) return;

            context.ReportDiagnostic(Diagnostic.Create(Rules.AbstractClassBaseSuffix, location, type.Name));
        }
    }
}
