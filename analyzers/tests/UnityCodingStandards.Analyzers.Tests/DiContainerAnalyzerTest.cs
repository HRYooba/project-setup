using System.Threading.Tasks;
using NUnit.Framework;

namespace UnityCodingStandards.Analyzers.Tests
{
    /// <summary>DI コンテナ探索の検出（UCS0015）。</summary>
    public sealed class DiContainerAnalyzerTest
    {
        private const string Header = @"
using UnityEngine;
using VContainer.Unity;

/// <summary>test</summary>
public class AppLifetimeScope : LifetimeScope { }

/// <summary>test</summary>
public class Target : MonoBehaviour
{
";

        private const string Footer = @"
}
";

        private static Task<string[]> RunAsync(string body) =>
            AnalyzerRun.IdsAsync(new DiContainerAnalyzer(), Header + body + Footer);

        [Test]
        public async Task LifetimeScope_Find_を報告する()
        {
            var ids = await RunAsync(@"
    /// <summary>test</summary>
    public void Wire() { var scope = LifetimeScope.Find(typeof(AppLifetimeScope)); }
");
            Assert.That(ids, Is.EqualTo(new[] { "UCS0015" }));
        }

        [Test]
        public async Task 型引数側に_LifetimeScope_が現れる形も報告する()
        {
            var ids = await RunAsync(@"
    /// <summary>test</summary>
    public void Wire() { var scope = LifetimeScope.FindFirstObjectByType<AppLifetimeScope>(); }
");
            Assert.That(ids, Is.EqualTo(new[] { "UCS0015" }));
        }

        [Test]
        public async Task LifetimeScope_と無関係な_Find_は報告しない()
        {
            var source = @"
using System.Collections.Generic;

/// <summary>test</summary>
public class Target
{
    /// <summary>test</summary>
    public int Pick(List<int> items) => items.Find(x => x > 0);
}
";
            var ids = await AnalyzerRun.IdsAsync(new DiContainerAnalyzer(), source);
            Assert.That(ids, Is.Empty, "名前だけで拾うと無関係な Find を巻き込む");
        }

        [Test]
        public async Task コンストラクタ注入は報告しない()
        {
            var source = @"
/// <summary>test</summary>
public class Service
{
    private readonly int _value;

    /// <summary>test</summary>
    public Service(int value) => _value = value;
}
";
            var ids = await AnalyzerRun.IdsAsync(new DiContainerAnalyzer(), source);
            Assert.That(ids, Is.Empty);
        }

        [Test]
        public async Task 解析対象外のファイルは報告しない()
        {
            var ids = await AnalyzerRun.IdsAsync(
                new DiContainerAnalyzer(),
                Header + @"
    /// <summary>test</summary>
    public void Wire() { var scope = LifetimeScope.Find(typeof(AppLifetimeScope)); }
" + Footer,
                "Assets/ThirdParty/Vendor/Target.cs");
            Assert.That(ids, Is.Empty);
        }
    }
}
