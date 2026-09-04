using System.Threading.Tasks;
using NUnit.Framework;

namespace UnityCodingStandards.Analyzers.Tests
{
    /// <summary>抽象基底クラス命名の検査（UCS0010）。</summary>
    public sealed class TypeNamingAnalyzerTest
    {
        private static Task<string[]> RunAsync(string source) =>
            AnalyzerRun.IdsAsync(new TypeNamingAnalyzer(), source);

        [Test]
        public async Task Base_サフィックスの無い抽象クラスを報告する()
        {
            var ids = await RunAsync(@"
/// <summary>test</summary>
public abstract class Presenter { }
");
            Assert.That(ids, Is.EqualTo(new[] { "UCS0010" }));
        }

        [Test]
        public async Task Base_サフィックスがあれば報告しない()
        {
            var ids = await RunAsync(@"
/// <summary>test</summary>
public abstract class PresenterBase { }
");
            Assert.That(ids, Is.Empty);
        }

        [Test]
        public async Task 非抽象クラスは対象外()
        {
            var ids = await RunAsync(@"
/// <summary>test</summary>
public class Presenter { }
");
            Assert.That(ids, Is.Empty);
        }

        [Test]
        public async Task interface_は対象外()
        {
            var ids = await RunAsync(@"
/// <summary>test</summary>
public interface IPresenter { }
");
            Assert.That(ids, Is.Empty);
        }

        [Test]
        public async Task static_クラスは対象外()
        {
            var ids = await RunAsync(@"
/// <summary>test</summary>
public static class PresenterHelper { }
");
            Assert.That(ids, Is.Empty);
        }
    }
}
