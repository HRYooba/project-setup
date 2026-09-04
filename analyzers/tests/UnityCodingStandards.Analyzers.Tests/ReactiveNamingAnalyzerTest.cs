using System.Threading.Tasks;
using NUnit.Framework;

namespace UnityCodingStandards.Analyzers.Tests
{
    /// <summary>R3 命名規則（UCS0001〜UCS0005）の検査。</summary>
    public sealed class ReactiveNamingAnalyzerTest
    {
        private const string Header = @"
using R3;

/// <summary>test</summary>
public class Target
{
";

        private const string Footer = @"
}
";

        private static Task<string[]> RunAsync(string body) =>
            AnalyzerRun.IdsAsync(new ReactiveNamingAnalyzer(), Header + body + Footer);

        [Test]
        public async Task Observable_サフィックスが無いプロパティを報告する()
        {
            var ids = await RunAsync("    public Observable<int> Value { get; } = null;");
            Assert.That(ids, Is.EqualTo(new[] { "UCS0001" }));
        }

        [Test]
        public async Task Observable_サフィックスがあれば報告しない()
        {
            var ids = await RunAsync("    public Observable<int> ValueObservable { get; } = null;");
            Assert.That(ids, Is.Empty);
        }

        [Test]
        public async Task Observable_を返すメソッドも対象にする()
        {
            var ids = await RunAsync("    public Observable<int> GetValue() => null;");
            Assert.That(ids, Is.EqualTo(new[] { "UCS0001" }));
        }

        [Test]
        public async Task Subject_はサフィックスと_private_の両方を要求する()
        {
            var ids = await RunAsync("    public Subject<int> _value = null;");
            Assert.That(ids, Is.EqualTo(new[] { "UCS0002", "UCS0003" }));
        }

        [Test]
        public async Task Subject_が_private_でサフィックスも揃っていれば報告しない()
        {
            var ids = await RunAsync("    private Subject<int> _valueSubject = null;");
            Assert.That(ids, Is.Empty);
        }

        [Test]
        public async Task ReactiveProperty_は_public_なら報告する()
        {
            var ids = await RunAsync("    public ReactiveProperty<int> _value = null;");
            Assert.That(ids, Is.EqualTo(new[] { "UCS0004" }));
        }

        [Test]
        public async Task ReactiveProperty_はアンダースコア無しなら報告する()
        {
            var ids = await RunAsync("    private ReactiveProperty<int> value = null;");
            Assert.That(ids, Is.EqualTo(new[] { "UCS0004" }));
        }

        [Test]
        public async Task ReactiveProperty_が_private_かつアンダースコア付きなら報告しない()
        {
            var ids = await RunAsync("    private ReactiveProperty<int> _value = null;");
            Assert.That(ids, Is.Empty);
        }

        [Test]
        public async Task IReadOnlyReactiveProperty_は_PascalCase_を要求する()
        {
            var ids = await RunAsync("    public IReadOnlyReactiveProperty<int> value { get; } = null;");
            Assert.That(ids, Is.EqualTo(new[] { "UCS0005" }));
        }

        [Test]
        public async Task IReadOnlyReactiveProperty_が_PascalCase_なら報告しない()
        {
            var ids = await RunAsync("    public IReadOnlyReactiveProperty<int> Value { get; } = null;");
            Assert.That(ids, Is.Empty);
        }

        [Test]
        public async Task Reactive_以外の型は対象外()
        {
            var ids = await RunAsync("    public int Value { get; } = 0;");
            Assert.That(ids, Is.Empty);
        }
    }
}
