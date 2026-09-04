using System.Threading.Tasks;
using NUnit.Framework;

namespace UnityCodingStandards.Analyzers.Tests
{
    /// <summary>UniTaskVoid の await 検出（UCS0014）。</summary>
    public sealed class FireAndForgetAnalyzerTest
    {
        private const string Header = @"
using Cysharp.Threading.Tasks;

/// <summary>test</summary>
public class Target
{
    /// <summary>test</summary>
    public UniTaskVoid FireAsync() => default;

    /// <summary>test</summary>
    public UniTask WorkAsync() => default;
";

        private const string Footer = @"
}
";

        private static Task<string[]> RunAsync(string body) =>
            AnalyzerRun.IdsAsync(new FireAndForgetAnalyzer(), Header + body + Footer);

        [Test]
        public async Task UniTaskVoid_を_await_したら報告する()
        {
            var ids = await RunAsync(@"
    /// <summary>test</summary>
    public async System.Threading.Tasks.Task RunAsync() => await FireAsync();
");
            Assert.That(ids, Is.EqualTo(new[] { "UCS0014" }));
        }

        [Test]
        public async Task Forget_で明示すれば報告しない()
        {
            var ids = await RunAsync(@"
    /// <summary>test</summary>
    public void Run() => FireAsync().Forget();
");
            Assert.That(ids, Is.Empty);
        }

        [Test]
        public async Task 呼ばずに放置しても_この規則は関与しない()
        {
            var ids = await RunAsync(@"
    /// <summary>test</summary>
    public void Run() => FireAsync();
");
            Assert.That(ids, Is.Empty, "await していないので UCS0014 の対象外");
        }

        [Test]
        public async Task 解析対象外のファイルは報告しない()
        {
            var ids = await AnalyzerRun.IdsAsync(
                new FireAndForgetAnalyzer(),
                Header + @"
    /// <summary>test</summary>
    public async System.Threading.Tasks.Task RunAsync() => await FireAsync();
" + Footer,
                "Assets/ThirdParty/Vendor/Target.cs");
            Assert.That(ids, Is.Empty);
        }
    }
}
