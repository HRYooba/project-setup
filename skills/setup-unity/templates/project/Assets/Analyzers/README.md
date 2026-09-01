# コーディング規約の Roslyn analyzer

`.claude/rules/coding-standards.md` のうち **型を見ないと判定できない規約**を、コンパイル時に
機械で止める。既製の analyzer や `.editorconfig` の naming rules では書けない部分だけを担当する
（`private _camelCase`・定数 `PascalCase`・`Async` サフィックスなどは既製ルールの領分）。

## 何がどこで決まるか

| 決めごと | 正本 |
|:---|:---|
| 規約そのもの | `.claude/rules/coding-standards.md` |
| 判定ロジックと規則 ID | `UnityCodingStandards.Analyzers.dll`（project-setup の `analyzers/` がソース） |

**規則 ID の一覧をここに書き写さない。** 診断メッセージ自体が規約の該当節を指すので、
Console に出た文言をそのまま読めばよい。写した一覧は規則を増減したときに黙って古くなる。

## severity は Warning 固定

設定ファイル（`.ruleset` / `.globalconfig`）は配っていない。全規則が Warning で出る。

**Error に上げない。** Unity は C# のコンパイルエラーで Safe Mode に入るため、命名違反 1 件で
Editor が作業不能になる。規約違反はコンパイルエラーではない。

PR の gate は severity ではなく CI が担う。CI がコンパイルログの `warning UCS` を拾って
job を落とすので、赤い PR はマージできない。

どうしても Editor 側で止めたいプロジェクトは、`Assets/Default.ruleset` を自分で置いて
`<Rule Id="UCS0001" Action="Error" />` を書く（配布物ではないので同期で上書きされない）。
`.editorconfig` の `dotnet_diagnostic.<ID>.severity` は**効かない** — Unity は `.editorconfig` を
C# コンパイラへ渡さない（Unity 6000.3 実機で確認済み）。

## 解析されるのは Assets/App/ だけ

`folder-structure.md` がアプリ本体の置き場と定めた `Assets/App/` 配下のコードだけを見る。
`Assets/ThirdParty/` `Assets/Plugins/` `Packages/` などの外部コードは、Unity が同じ
コンパイルに載せていても報告しない（規約を当てても直せないため）。

## 正当な例外を通す

規約を守れない箇所（サードパーティ interface の実装など）は、範囲を絞って抑制する。

```csharp
#pragma warning disable UCS0006 // 外部 interface の署名に合わせるため ct を取れない
public UniTask RunAsync() => default;
#pragma warning restore UCS0006
```

抑制するときは**理由をコメントで書く**。理由の無い抑制は、次に読む人が消せない。

## 更新のしかた

この DLL は project-setup の `setup-unity` が配る。手で置き換えない。
テンプレート更新は `/sync-setup` が同期 PR として持ってくる。
