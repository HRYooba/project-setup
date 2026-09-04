using System.Threading.Tasks;
using NUnit.Framework;

namespace UnityCodingStandards.Analyzers.Tests
{
    /// <summary>非同期署名の検査（UCS0006 / UCS0007 / UCS0008）。</summary>
    public sealed class AsyncSignatureAnalyzerTest
    {
        private const string Header = @"
using System.Threading;
using Cysharp.Threading.Tasks;

/// <summary>test</summary>
public class Target
{
";

        private const string Footer = @"
}
";

        private static Task<string[]> RunAsync(string body) =>
            AnalyzerRun.IdsAsync(new AsyncSignatureAnalyzer(), Header + body + Footer);

        [Test]
        public async Task CancellationToken_が無い_UniTask_メソッドを報告する()
        {
            var ids = await RunAsync("    public UniTask RunAsync() => default;");
            Assert.That(ids, Is.EqualTo(new[] { "UCS0006" }));
        }

        [Test]
        public async Task CancellationToken_があれば報告しない()
        {
            var ids = await RunAsync("    public UniTask RunAsync(CancellationToken cancellationToken) => default;");
            Assert.That(ids, Is.Empty);
        }

        [Test]
        public async Task CancellationToken_の既定値を報告する()
        {
            var ids = await RunAsync("    public UniTask RunAsync(CancellationToken ct = default) => default;");
            Assert.That(ids, Is.EqualTo(new[] { "UCS0007" }));
        }

        [Test]
        public async Task Task_戻り値を報告する()
        {
            var ids = await RunAsync(
                "    public System.Threading.Tasks.Task RunAsync(CancellationToken cancellationToken) => null;");
            Assert.That(ids, Is.EqualTo(new[] { "UCS0008" }));
        }

        [Test]
        public async Task Task_戻り値で_CancellationToken_も無ければ両方報告する()
        {
            var ids = await RunAsync("    public System.Threading.Tasks.Task RunAsync() => null;");
            Assert.That(ids, Is.EqualTo(new[] { "UCS0006", "UCS0008" }));
        }

        [Test]
        public async Task 同期メソッドは対象外()
        {
            var ids = await RunAsync("    public int Run() => 0;");
            Assert.That(ids, Is.Empty);
        }

        [Test]
        public async Task Async_サフィックスが無ければ報告する()
        {
            var ids = await RunAsync("    public UniTask Run(CancellationToken cancellationToken) => default;");
            Assert.That(ids, Is.EqualTo(new[] { "UCS0011" }));
        }

        [Test]
        public async Task UniTaskVoid_も_Async_サフィックスの対象()
        {
            var ids = await RunAsync("    public UniTaskVoid Fire(CancellationToken cancellationToken) => default;");
            Assert.That(ids, Is.EqualTo(new[] { "UCS0011" }));
        }

        [Test]
        public async Task Async_サフィックスがあれば報告しない()
        {
            var ids = await RunAsync("    public UniTask RunAsync(CancellationToken cancellationToken) => default;");
            Assert.That(ids, Is.Empty);
        }

        [Test]
        public async Task interface_実装は基底側の責任なので報告しない()
        {
            var source = @"
using System.Threading;
using Cysharp.Threading.Tasks;

/// <summary>test</summary>
public interface IRunner
{
    /// <summary>test</summary>
    UniTask RunAsync();
}

/// <summary>test</summary>
public class Runner : IRunner
{
    /// <summary>test</summary>
    public UniTask RunAsync() => default;
}
";
            var ids = await AnalyzerRun.IdsAsync(new AsyncSignatureAnalyzer(), source);
            Assert.That(ids, Is.EqualTo(new[] { "UCS0006" }), "interface 宣言側だけが報告対象");
        }

        [Test]
        public async Task override_は基底側の責任なので報告しない()
        {
            var source = @"
using Cysharp.Threading.Tasks;

/// <summary>test</summary>
public abstract class RunnerBase
{
    /// <summary>test</summary>
    public abstract UniTask RunAsync(System.Threading.CancellationToken cancellationToken);
}

/// <summary>test</summary>
public class Runner : RunnerBase
{
    /// <summary>test</summary>
    public override UniTask RunAsync(System.Threading.CancellationToken cancellationToken) => default;
}
";
            var ids = await AnalyzerRun.IdsAsync(new AsyncSignatureAnalyzer(), source);
            Assert.That(ids, Is.Empty);
        }
    }
}
