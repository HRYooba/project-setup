using System;

namespace UnityCodingStandards.Analyzers
{
    /// <summary>識別子の形（PascalCase / _camelCase）の判定。</summary>
    internal static class NameConventions
    {
        /// <summary>'_' + camelCase か。private フィールドの規約。</summary>
        internal static bool IsUnderscoreCamelCase(string name) =>
            name.Length >= 2 && name[0] == '_' && char.IsLower(name[1]);

        /// <summary>PascalCase か。</summary>
        internal static bool IsPascalCase(string name) =>
            name.Length >= 1 && char.IsUpper(name[0]);

        /// <summary>末尾一致（サフィックス規約）。</summary>
        internal static bool HasSuffix(string name, string suffix) =>
            name.EndsWith(suffix, StringComparison.Ordinal);
    }
}
