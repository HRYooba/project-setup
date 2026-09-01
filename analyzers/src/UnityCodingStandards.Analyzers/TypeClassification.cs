using System;
using System.Collections.Generic;
using Microsoft.CodeAnalysis;

namespace UnityCodingStandards.Analyzers
{
    /// <summary>Reactive 系の型分類。命名規則が対象ごとに違うため、宣言型から一意に決める。</summary>
    internal enum ReactiveKind
    {
        /// <summary>Reactive 系ではない。</summary>
        None,

        /// <summary>Observable / IObservable。</summary>
        Observable,

        /// <summary>Subject / ReplaySubject / BehaviorSubject 等。</summary>
        Subject,

        /// <summary>ReactiveProperty / SerializableReactiveProperty / BindableReactiveProperty。</summary>
        ReactiveProperty,

        /// <summary>IReadOnlyReactiveProperty / ReadOnlyReactiveProperty。</summary>
        ReadOnlyReactiveProperty,
    }

    /// <summary>
    /// 型を名前で分類する。R3 / UniRx / UniTask のアセンブリを参照せずに判定するため、
    /// 名前空間ではなく型名だけを見る。
    /// </summary>
    /// <remarks>
    /// analyzer が特定パッケージを参照すると、そのパッケージを入れていない配備先で読み込みに
    /// 失敗する。名前一致は取りこぼしより誤検知の方向に振れるが、誤検知は
    /// <c>#pragma warning disable</c> で逃げられる（取りこぼしは気付けない）。
    /// </remarks>
    internal static class TypeClassification
    {
        private static readonly HashSet<string> ReactivePropertyNames = new HashSet<string>(StringComparer.Ordinal)
        {
            "ReactiveProperty",
            "SerializableReactiveProperty",
            "BindableReactiveProperty",
        };

        private static readonly HashSet<string> ReadOnlyReactivePropertyNames = new HashSet<string>(StringComparer.Ordinal)
        {
            "IReadOnlyReactiveProperty",
            "ReadOnlyReactiveProperty",
        };

        private static readonly HashSet<string> ObservableNames = new HashSet<string>(StringComparer.Ordinal)
        {
            "Observable",
            "IObservable",
        };

        private static readonly HashSet<string> AsyncReturnNames = new HashSet<string>(StringComparer.Ordinal)
        {
            "UniTask",
            "UniTaskVoid",
            "Awaitable",
            "ValueTask",
            "Task",
        };

        private static readonly HashSet<string> TaskReturnNames = new HashSet<string>(StringComparer.Ordinal)
        {
            "Task",
        };

        /// <summary>宣言された型（基底は辿らない）の Reactive 分類。</summary>
        internal static ReactiveKind ClassifyReactive(ITypeSymbol? type)
        {
            if (type == null) return ReactiveKind.None;

            var name = type.Name;
            if (ReactivePropertyNames.Contains(name)) return ReactiveKind.ReactiveProperty;
            if (ReadOnlyReactivePropertyNames.Contains(name)) return ReactiveKind.ReadOnlyReactiveProperty;
            if (ObservableNames.Contains(name)) return ReactiveKind.Observable;
            if (name.EndsWith("Subject", StringComparison.Ordinal)) return ReactiveKind.Subject;
            return ReactiveKind.None;
        }

        /// <summary>非同期メソッドの戻り値型か（UniTask / Awaitable / ValueTask / Task）。</summary>
        internal static bool IsAsyncReturnType(ITypeSymbol? type) =>
            type != null && AsyncReturnNames.Contains(type.Name);

        /// <summary>戻り値が Task / Task&lt;T&gt; か（UniTask へ置き換える対象）。</summary>
        internal static bool IsTaskReturnType(ITypeSymbol? type) =>
            type != null &&
            TaskReturnNames.Contains(type.Name) &&
            type.ContainingNamespace?.ToDisplayString() == "System.Threading.Tasks";

        /// <summary>CancellationToken 型か。</summary>
        internal static bool IsCancellationToken(ITypeSymbol? type) =>
            type != null && type.Name == "CancellationToken";

        /// <summary>IEnumerator / IEnumerator&lt;T&gt; 型か（Coroutine 判定）。</summary>
        internal static bool IsEnumerator(ITypeSymbol? type) =>
            type != null && type.Name == "IEnumerator";
    }
}
