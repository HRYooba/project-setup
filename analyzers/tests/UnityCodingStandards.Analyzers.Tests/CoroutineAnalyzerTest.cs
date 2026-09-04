using System.Threading.Tasks;
using NUnit.Framework;

namespace UnityCodingStandards.Analyzers.Tests
{
    /// <summary>Coroutine 禁止の検査（UCS0009）。</summary>
    public sealed class CoroutineAnalyzerTest
    {
        private static Task<string[]> RunAsync(string source) =>
            AnalyzerRun.IdsAsync(new CoroutineAnalyzer(), source);

        [Test]
        public async Task IEnumerator_を返すメソッドを報告する()
        {
            var ids = await RunAsync(@"
/// <summary>test</summary>
public class Target
{
    /// <summary>test</summary>
    public System.Collections.IEnumerator Run() { yield break; }
}
");
            Assert.That(ids, Is.EqualTo(new[] { "UCS0009" }));
        }

        [Test]
        public async Task StartCoroutine_の呼び出しを報告する()
        {
            var ids = await RunAsync(@"
using UnityEngine;

/// <summary>test</summary>
public class Target : MonoBehaviour
{
    /// <summary>test</summary>
    public void Run()
    {
        StartCoroutine(null);
    }
}
");
            Assert.That(ids, Is.EqualTo(new[] { "UCS0009" }));
        }

        [Test]
        public async Task UnityTest_の中は例外として許す()
        {
            var ids = await RunAsync(@"
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>test</summary>
public class Target : MonoBehaviour
{
    /// <summary>test</summary>
    [UnityTest]
    public System.Collections.IEnumerator Run()
    {
        StartCoroutine(null);
        yield break;
    }
}
");
            Assert.That(ids, Is.Empty);
        }

        [Test]
        public async Task GetEnumerator_の実装は報告しない()
        {
            var ids = await RunAsync(@"
using System.Collections;

/// <summary>test</summary>
public class Target : IEnumerable
{
    /// <summary>test</summary>
    public IEnumerator GetEnumerator() { yield break; }
}
");
            Assert.That(ids, Is.Empty);
        }
    }
}
