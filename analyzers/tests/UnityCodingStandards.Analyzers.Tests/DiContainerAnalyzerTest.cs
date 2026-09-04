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
        public async Task Unity_の探索_API_に_LifetimeScope_を渡す形も報告する()
        {
            var ids = await RunAsync(@"
    /// <summary>test</summary>
    public void Wire() { var scope = Object.FindFirstObjectByType<AppLifetimeScope>(); }
");
            Assert.That(ids, Is.EqualTo(new[] { "UCS0015" }));
        }

        [Test]
        public async Task 修飾なしの探索も報告する_MemberAccess_にならない形()
        {
            var ids = await RunAsync(@"
    /// <summary>test</summary>
    public void Wire() { var scope = FindFirstObjectByType<AppLifetimeScope>(); }
");
            Assert.That(
                ids,
                Is.EqualTo(new[] { "UCS0015" }),
                "MonoBehaviour 内から修飾なしで撃つと GenericNameSyntax になる");
        }

        [Test]
        public async Task 無関係な汎用_Find_に_LifetimeScope_を渡しても報告しない()
        {
            var source = @"
using UnityEngine;
using VContainer.Unity;

/// <summary>test</summary>
public class AppLifetimeScope : LifetimeScope { }

/// <summary>test</summary>
public class Repository
{
    /// <summary>test</summary>
    public T Find<T>() where T : class => null;
}

/// <summary>test</summary>
public class Target
{
    private readonly Repository _repository = new Repository();

    /// <summary>test</summary>
    public void Wire() { var scope = _repository.Find<AppLifetimeScope>(); }
}
";
            var ids = await AnalyzerRun.IdsAsync(new DiContainerAnalyzer(), source);
            Assert.That(ids, Is.Empty, "型引数だけを見ると無関係な Find<T> を巻き込む");
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
