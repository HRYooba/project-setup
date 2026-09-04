using System.Threading.Tasks;
using NUnit.Framework;

namespace UnityCodingStandards.Analyzers.Tests
{
    /// <summary>解析対象フォルダ判定の検査。</summary>
    /// <remarks>
    /// 規約はアプリ本体（folder-structure.md が定める Assets/App/ 配下）に向けたもので、
    /// そこ以外のコードは規約を当てても直せない。Unity は Packages/ や Library/PackageCache/ の
    /// コードまで同じコンパイルに載せるため、ホワイトリストであることを固定しておく
    /// （除外リストにすると外部コードの置き場を数え漏らして warning で埋まる）。
    /// </remarks>
    public sealed class AnalysisScopeTest
    {
        private const string Violating = "public abstract class Presenter { }";

        [TestCase("/project/Assets/App/Scripts/Presenter.cs")]
        [TestCase("Assets/App/Scripts/Presenter.cs")]
        [TestCase("")]
        public async Task アプリ本体は解析する(string filePath)
        {
            var ids = await AnalyzerRun.IdsAsync(new TypeNamingAnalyzer(), Violating, filePath);
            Assert.That(ids, Is.EqualTo(new[] { "UCS0010" }));
        }

        [TestCase("/project/Assets/ThirdParty/Vendor/Presenter.cs")]
        [TestCase("/project/Assets/Plugins/Vendor/Presenter.cs")]
        [TestCase("/project/Assets/Sandbox/Harness/Presenter.cs")]
        [TestCase("/project/Assets/Photon/PhotonUnityNetworking/Presenter.cs")]
        [TestCase("/project/Packages/com.vrmc.vrm/Runtime/Presenter.cs")]
        [TestCase("/project/Library/PackageCache/com.unity.timeline/Presenter.cs")]
        public async Task アプリ本体の外は解析しない(string filePath)
        {
            var ids = await AnalyzerRun.IdsAsync(new TypeNamingAnalyzer(), Violating, filePath);
            Assert.That(ids, Is.Empty);
        }

        [Test]
        public async Task 名前がAppで始まるだけの兄弟フォルダは解析しない()
        {
            var ids = await AnalyzerRun.IdsAsync(
                new TypeNamingAnalyzer(), Violating, "/project/Assets/AppExtras/Presenter.cs");
            Assert.That(ids, Is.Empty);
        }

        [Test]
        public async Task 判定はパス区切りが逆スラッシュでも効く()
        {
            var windowsPath = string.Join(
                new string(new[] { (char)92 }),
                new[] { "C:", "project", "Assets", "App", "Scripts", "Presenter.cs" });

            var ids = await AnalyzerRun.IdsAsync(new TypeNamingAnalyzer(), Violating, windowsPath);
            Assert.That(ids, Is.EqualTo(new[] { "UCS0010" }));
        }
    }
}
