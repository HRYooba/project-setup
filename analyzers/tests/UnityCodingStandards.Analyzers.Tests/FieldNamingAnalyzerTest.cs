using System.Threading.Tasks;
using NUnit.Framework;

namespace UnityCodingStandards.Analyzers.Tests
{
    /// <summary>フィールドの命名と可視性の検査（UCS0012 / UCS0013）。</summary>
    public sealed class FieldNamingAnalyzerTest
    {
        private const string Header = @"
using R3;
using UnityEngine;

/// <summary>test</summary>
public class Target : MonoBehaviour
{
";

        private const string Footer = @"
}
";

        private static Task<string[]> RunAsync(string body) =>
            AnalyzerRun.IdsAsync(new FieldNamingAnalyzer(), Header + body + Footer);

        [Test]
        public async Task private_フィールドが_camelCase_でなければ報告する()
        {
            var ids = await RunAsync("    private int player;");
            Assert.That(ids, Is.EqualTo(new[] { "UCS0012" }));
        }

        [Test]
        public async Task アンダースコア付き_camelCase_は報告しない()
        {
            var ids = await RunAsync("    private int _player;");
            Assert.That(ids, Is.Empty);
        }

        [Test]
        public async Task m_プレフィックス_は報告する()
        {
            var ids = await RunAsync("    private int m_player;");
            Assert.That(ids, Is.EqualTo(new[] { "UCS0012" }), "Unity 自身の流儀だがこの規約では違反");
        }

        [Test]
        public async Task アクセス修飾子を省いた宣言も_private_として見る()
        {
            var ids = await RunAsync("    int player;");
            Assert.That(ids, Is.EqualTo(new[] { "UCS0012" }));
        }

        [Test]
        public async Task public_フィールドは命名の対象外()
        {
            var ids = await RunAsync("    public int Player;");
            Assert.That(ids, Is.Empty, "規約が定めているのは private フィールドの形だけ");
        }

        [Test]
        public async Task 定数は規約が形を定めていないので報告しない()
        {
            var ids = await RunAsync("    private const int MaxHealth = 10;");
            Assert.That(ids, Is.Empty);
        }

        [Test]
        public async Task enum_メンバーは報告しない()
        {
            var source = @"
/// <summary>test</summary>
public enum Kind
{
    /// <summary>test</summary>
    First,
}
";
            var ids = await AnalyzerRun.IdsAsync(new FieldNamingAnalyzer(), source);
            Assert.That(ids, Is.Empty);
        }

        [Test]
        public async Task ReactiveProperty_は_UCS0004_の領分なので二重に報告しない()
        {
            var ids = await RunAsync("    private ReactiveProperty<int> health;");
            Assert.That(ids, Is.Empty, "名前も可視性も UCS0004 がまとめて見る");
        }

        [Test]
        public async Task Subject_は除外しない_UCS0004_の対象ではないため()
        {
            var ids = await RunAsync("    private Subject<int> clickSubject;");
            Assert.That(
                ids,
                Is.EqualTo(new[] { "UCS0012" }),
                "UCS0002/UCS0003 はサフィックスと可視性しか見ず、名前の形は誰も見ていない");
        }

        [Test]
        public async Task SerializeField_が_public_なら報告する()
        {
            var ids = await RunAsync("    [SerializeField] public int Speed;");
            Assert.That(ids, Is.EqualTo(new[] { "UCS0013" }));
        }

        [Test]
        public async Task SerializeField_が_private_で_camelCase_なら報告しない()
        {
            var ids = await RunAsync("    [SerializeField] private int _target;");
            Assert.That(ids, Is.Empty);
        }

        [Test]
        public async Task SerializeField_が_public_かつ命名も外れていれば可視性だけ報告する()
        {
            var ids = await RunAsync("    [SerializeField] internal int target;");
            Assert.That(ids, Is.EqualTo(new[] { "UCS0013" }), "命名規約は private フィールドにだけ当てる");
        }

        [Test]
        public async Task 解析対象外のファイルは報告しない()
        {
            var ids = await AnalyzerRun.IdsAsync(
                new FieldNamingAnalyzer(),
                Header + "    private int player;" + Footer,
                "Assets/ThirdParty/Vendor/Target.cs");
            Assert.That(ids, Is.Empty);
        }
    }
}
