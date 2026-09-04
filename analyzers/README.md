# UnityCodingStandards.Analyzers

`setup-unity` が配る Roslyn analyzer のソース。配布物（DLL）は
`skills/setup-unity/templates/project/Assets/Analyzers/` に**コミット済み**で、このソースから生成する。

## 何を担当するか

`skills/setup-unity/templates/*/rules/coding-standards.md` のうち、**機械で判定できる規約**。

担当を「型を見ないと判定できない規約だけ」に絞らない。**Unity は `.editorconfig` を C#
コンパイラへ渡さない**ので、`dotnet_naming_rule` や `dotnet_diagnostic` の経路が無い。
既製ルールへ回す先が無いなら、名前だけで判定できる規約もここが持つ。

持たないものは 2 種類だけ。

| 持たない規約 | 理由 |
|:---|:---|
| 名前空間 `<Project>.<Context>` / `<Project>.Tests.<Context>` | `<Project>` は配備先ごとに違い、analyzer が知る手段が無い |
| Subject で中継しない / `AddTo()` の束ね先 / XML doc の WHY / fail-fast と fail-soft の切り分け | 判断が要る。機械で当てると誤検知が規約への信頼を壊す |

テストクラス名 `*Test` とテストメソッド名 `A_B_C` は判定できるが未実装（違反の害が小さい）。

規則 ID の一覧は `src/UnityCodingStandards.Analyzers/AnalyzerReleases.Unshipped.md` が正本。
新しい ID をそこへ書き忘れると `RS2008` でビルドが落ちる（一覧が腐らない）。

**設定ファイル（`.ruleset` / `.globalconfig`）は配らない。** 既定 severity は Warning 固定。
Error にすると Unity が Safe Mode へ落ち、命名違反だけで Editor が作業不能になるため、
配布物としては持たない。

**CI は診断を見ない。** 配る workflow は Editor を起こさないので、警告は Editor の
コンソールで読んで直す（配る `rules/coding-standards.md`「規約の機械チェック」が正本）。

## Unity 同梱 Roslyn への追従（壊れ方が静かなので注意）

Unity 6000.3 / 6000.4 が同梱する Roslyn は **4.3.1**。
参照する `Microsoft.CodeAnalysis.CSharp` をこれより新しくすると Unity 側の C# コンパイラが
analyzer を読み込めず、**診断が 1 件も出ない状態**（＝「違反ゼロ」と見分けが付かない）になる。

版を上げるときは、対象 Editor の
`Editor/Data/DotNetSdkRoslyn/Microsoft.CodeAnalysis.CSharp.dll` の `ProductVersion` を確認してから
`UnityCodingStandards.Analyzers.csproj` の `MicrosoftCodeAnalysisVersion` を動かす。

## 作業手順

```bash
npm run test:analyzer   # 規則の検証（dotnet test）
npm run build:analyzer  # DLL を templates/ へ焼き込み、dist.json を更新
npm test                # 焼き込み忘れの検知を含む Node 側テスト
```

`build:analyzer` を流し忘れたまま `analyzers/src/` を変えると、`npm test` が
`dist.json` の `sourceHash` 不一致で落ちる。**落ちたら流し直してコミットする。**

## 規則を 1 つ足すときに触るファイル

| ファイル | 何を書くか |
|:---|:---|
| `src/.../Rules.cs` | `DiagnosticDescriptor`（ID・メッセージ・規約への参照） |
| `src/.../*Analyzer.cs` | 判定ロジック。既存の Analyzer に足すか、新しいクラスを作る |
| `src/.../AnalyzerReleases.Unshipped.md` | ID の台帳（書き忘れると `RS2008` でビルドが落ちる） |
| `tests/.../*Test.cs` | **陽性と陰性の両方**。陰性（報告しないこと）を書かないと誤検知が残る |

新しい Analyzer クラスを作った場合は、`DiagnosticAnalyzer` に `[DiagnosticAnalyzer]` 属性が
付いていることを確認する。付け忘れると Roslyn がそのクラスを起動せず、**診断が 1 件も出ない**
（＝「違反ゼロ」と区別が付かない）。

## 設計上の約束

- **型は名前で分類する**（`TypeClassification`）。R3 / UniTask のアセンブリを参照しない。
  参照すると、それらを入れていない配備先で analyzer の読み込みに失敗する
- **`override` と interface 実装は報告しない**（`AnalysisScope`）。署名を変えられない箇所を
  赤くすると、lint ごと抑制されて終わる。基底の宣言側で報告する
- **解析対象は `Assets/App/` 配下だけ**（`AnalysisScope`）。除外リストではなくホワイトリスト。
  Unity は `Packages/` や `Library/PackageCache/` のコードまで同じコンパイルに載せるので、
  除外を数え上げる形にすると必ず漏れて、直せない箇所が warning で埋まる
- **summary の有無は見ない**。`CS1591` は全 public メンバーに doc を要求するため
  `coding-standards.md` の「機械的・網羅的な summary 付与は行わない」と正面から衝突する。
  型宣言だけに絞った自作規則も持たない — 既存プロジェクトで大量に出る割に一括修正できず、
  件数に埋もれて他の規則が読まれなくなる
