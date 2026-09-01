namespace UnityCodingStandards.Analyzers.Tests
{
    /// <summary>
    /// テスト対象ソースの前に連結するスタブ。R3 / UniTask / Unity のアセンブリを参照せずに
    /// コンパイルを通すために置く。
    /// </summary>
    /// <remarks>
    /// Analyzer は型を名前で分類する（<see cref="TypeClassification"/>）ため、
    /// 名前さえ合っていればここのスタブで挙動を再現できる。
    /// スタブ自身が診断に引っかからないよう summary を付けてある。
    /// </remarks>
    internal static class TestSources
    {
        internal const string Stubs = @"
namespace R3
{
    /// <summary>stub</summary>
    public class Observable<T> { }

    /// <summary>stub</summary>
    public class Subject<T> : Observable<T> { }

    /// <summary>stub</summary>
    public class ReactiveProperty<T> : Observable<T> { }

    /// <summary>stub</summary>
    public interface IReadOnlyReactiveProperty<T> { }
}

namespace Cysharp.Threading.Tasks
{
    /// <summary>stub</summary>
    public struct UniTask { }

    /// <summary>stub</summary>
    public struct UniTask<T> { }
}

namespace UnityEngine
{
    /// <summary>stub</summary>
    public class MonoBehaviour
    {
        /// <summary>stub</summary>
        public object StartCoroutine(System.Collections.IEnumerator routine) => routine;
    }
}

namespace UnityEngine.TestTools
{
    /// <summary>stub</summary>
    public sealed class UnityTestAttribute : System.Attribute { }
}
";
    }
}
