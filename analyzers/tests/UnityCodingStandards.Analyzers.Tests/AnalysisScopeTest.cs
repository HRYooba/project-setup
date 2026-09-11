using System;
using System.IO;
using System.Threading.Tasks;
using NUnit.Framework;

namespace UnityCodingStandards.Analyzers.Tests
{
    /// <summary>解析対象フォルダ判定の検査。</summary>
    /// <remarks>
    /// 規約はアプリ本体（folder-structure.md が定める置き場。既定は Assets/App/ で、配備先が
    /// setup-unity の --app-root で変えられる）に向けたもので、
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

        // アプリ本体の置き場は配備先ごとに選べる（setup-unity の --app-root）。値は DLL の隣の
        // マーカーで渡る。Unity が .editorconfig / .globalconfig を C# コンパイラへ渡さないため、
        // 設定を届ける経路がここしか無い（analyzers/README.md が正本）。
        [Test]
        public async Task マーカーがあれば解析対象ルートを差し替える()
        {
            var project = NewProjectWithMarker("Assets/Game/");

            var inside = await AnalyzerRun.IdsAsync(
                new TypeNamingAnalyzer(), Violating, project + "/Assets/Game/Scripts/Presenter.cs");
            Assert.That(inside, Is.EqualTo(new[] { "UCS0010" }));

            // 既定値だった場所は、差し替え後は対象外になる（既定との OR 判定にしない）。
            var outside = await AnalyzerRun.IdsAsync(
                new TypeNamingAnalyzer(), Violating, project + "/Assets/App/Scripts/Presenter.cs");
            Assert.That(outside, Is.Empty);
        }

        [Test]
        public async Task マーカーが無ければ既定のAssetsAppを使う()
        {
            var project = NewProject();

            var ids = await AnalyzerRun.IdsAsync(
                new TypeNamingAnalyzer(), Violating, project + "/Assets/App/Scripts/Presenter.cs");
            Assert.That(ids, Is.EqualTo(new[] { "UCS0010" }));
        }

        // マーカーは apply.mjs が生成する。手編集しない旨を書けるよう注釈行を許す。
        [Test]
        public async Task マーカーの注釈行と空行は読み飛ばす()
        {
            var project = NewProjectWithMarker("# setup-unity が生成。手で編集しない" + NewLine + NewLine + "Assets/Game/");

            var ids = await AnalyzerRun.IdsAsync(
                new TypeNamingAnalyzer(), Violating, project + "/Assets/Game/Presenter.cs");
            Assert.That(ids, Is.EqualTo(new[] { "UCS0010" }));
        }

        [TestCase("Assets/Game")]
        [TestCase("/Assets/Game/")]
        [TestCase("AssetsSEPGame")]
        public async Task マーカーの書式のゆらぎを吸収する(string written)
        {
            var project = NewProjectWithMarker(written.Replace("SEP", Separator));

            var ids = await AnalyzerRun.IdsAsync(
                new TypeNamingAnalyzer(), Violating, project + "/Assets/Game/Presenter.cs");
            Assert.That(ids, Is.EqualTo(new[] { "UCS0010" }));
        }

        // マーカーが壊れていても analyzer は落とさない（例外はコンパイルごと巻き込む）。
        [Test]
        public async Task マーカーが空なら既定へ倒す()
        {
            var project = NewProjectWithMarker("   ");

            var ids = await AnalyzerRun.IdsAsync(
                new TypeNamingAnalyzer(), Violating, project + "/Assets/App/Presenter.cs");
            Assert.That(ids, Is.EqualTo(new[] { "UCS0010" }));
        }

        private static readonly string Separator = new string(new[] { (char)92 });
        private static readonly string NewLine = System.Environment.NewLine;

        /// <summary>マーカーを持たない一時プロジェクト。解析対象ルートはプロジェクト単位でキャッシュ
        /// されるため、テストごとに別のディレクトリを作る。</summary>
        private static string NewProject()
        {
            var dir = Path.Combine(Path.GetTempPath(), "ucs-scope-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Path.Combine(dir, "Assets", "Analyzers"));
            return dir.Replace((char)92, '/');
        }

        private static string NewProjectWithMarker(string content)
        {
            var dir = NewProject();
            File.WriteAllText(Path.Combine(dir, "Assets", "Analyzers", "analyzable-root.txt"), content);
            return dir;
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
