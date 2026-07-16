---
name: test-unity
description: >
  このスキルは、ユーザーが「テスト実行」「テスト生成」「ユニットテスト」「単体テスト」「/test-unity」
  と依頼した場合に使用される。変更差分のテスト責任を判定し、必要なUnityテストの設計・実装・重複整理・実行、
  またはテスト不要理由の報告を行う。ファイルパスやフォルダパスの指定も可。
version: 1.0.0
argument-hint: "[ファイルパス|フォルダパス]"
context: fork
agent: unity-tester
---

# テスト責任の判定・設計・実装・実行

**現在のブランチ**: !`git branch --show-current`
**引数**: $ARGUMENTS

判断基準は 2 つの参照ガイドが正:
- **何をテストするか**（対象選別・技法・価値判定・重複定義・禁止）→ `references/test-designing-guide.md`
- **どう書くか**（命名・NUnit/UniTask 規約・TestDoubles・asmdef・テンプレート）→ `references/test-writing-guide.md`

このファイルは実行フロー（MCP 操作とターン計画）のみを定義する。**テストの追加・削除の是非は必ず designing-guide のゲートで判断する**。

MCP ツールの具体的な呼び出し（ツール名・パラメータ・失敗判定）は
`.claude/skills/test-unity/references/unity-mcp-tools.md`（この skill 同梱のバインディング表）が正。
以下の手順は操作名（「コンパイル確認」等）で表を参照する。
表の内容がコンテキストに無ければ Turn 1 で Read する。

## 呼び出しパターン

| パターン | 動作 |
|---|---|
| `/test-unity` | ブランチ変更 → テスト要否判定 → 設計 → 実装 → 重複整理 → 実行 |
| `/test-unity Assets/.../Foo.cs` | 指定ファイルのテスト要否判定 → 設計 → 実装 → 重複整理 → 実行 |

## ターン実行計画

| Turn | ステップ | 内容 |
|:-----|:---------|:----------------|
| 1 | B1 | バインディング表 Read + git diff x3 + Glob x2（並列）→ 対象ファイル決定 |
| 2 | B2 | コンソールエラー取得 + 全対象 + 依存型 + 既存テストを Read → **設計**（designing-guide でケース選別） |
| 3 | B3 | **実装**（writing-guide で Write/Edit）→ コンパイル確認 |
| 4 | B4 | **重複整理**（designing-guide §7 の 2 軸定義で dedup）→ コンパイル確認 |
| 5 | B5 | テスト実行（assembly 限定）→ テスト結果取得 |
| 6 | B6 | 結果報告（+ PR コメント） |

---

### B1: 対象ファイル決定 [Turn 1]

引数パース: `.cs` → 対象ファイル / `/` → 対象ディレクトリ / なし → git diff。

default branch は `git symbolic-ref --short refs/remotes/origin/HEAD` で検出する
（失敗時は `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`。以下 `<default>` と表記）。

**1 回の並列呼び出しで同時実行:**
```
Read: .claude/skills/test-unity/references/unity-mcp-tools.md（バインディング表。コンテキストに読込済みなら省略可）
Bash: git symbolic-ref --short refs/remotes/origin/HEAD && git diff --name-only origin/<default>...HEAD -- '*.cs'
Bash: git diff --name-only HEAD -- '*.cs'
Bash: git ls-files --others --exclude-standard -- '*.cs'
Glob: Assets/App/Scripts/Tests/EditMode/*.asmdef
Glob: Assets/App/Scripts/Tests/EditMode/**/*Test.cs
```
3 つの git 結果を合算・重複除去して対象一覧とする。
- 変更なし → 「テスト対象なし」で停止

**対象選別（自動検出時のみ）** — `references/test-designing-guide.md` §1・§2 に従い、
テスト対象外（ランタイム挙動の手動確認に委譲する変更等）のみなら「テスト不要」の理由を添えて終了。

対象 0 件 → 停止。

### B2: 解析 & 設計 [Turn 2]

**「コンソールエラー取得」（count=20）+ 全対象ファイル + 依存型 + 同名既存テストを 1 レスポンスにまとめて実行**（逐次読み禁止）。
- 既存のコンパイルエラー検出 → 停止してユーザーに確認

Read 結果から抽出:
1. 名前空間・クラス名・基底・実装 interface
2. コンストラクタ（依存と型）
3. public メソッド / プロパティ（シグネチャ）
4. private フィールド（ReactiveProperty 等の初期値）
5. 所属アセンブリ（パスから推定）

各対象について `references/test-designing-guide.md` に従い判定する:
1. §1・§2 で**テスト要否**を決める（不要なら理由を記録して対象から外す）
2. §3 技法 + §4 依存エラー方針で**検証すべきケースを列挙**
3. §5 **追加前ゲート**（回帰特定 / 一意性=2軸重複 / 仕様語↔assertion 整合 / ダブル語彙）を各ケースに適用。1 つでも満たせないケースは捨てる
4. §6 合成クラス方針 / §8 禁止リスト / §9 テスタビリティに照合

> 設計段階で「検証内容（観測可能な性質）」を 1 行で言語化する。言語化できないケースは書かない。
> テスタビリティ FAIL（§9）の兆候があれば、テストを書かず対象コードの設計見直しを報告する。

### B3: 実装 [Turn 3]

`references/test-writing-guide.md` に従い実装する。
- asmdef を実ファイルで確認し、不足参照のみ追加（§6）
- 既存テストがあれば優先して **Edit**、無ければ **Write**（配置・命名・namespace は §1）
- TestDoubles は共有定義を使う。新規スタブは `TestDoubles/<Context>/` に追加（§3）
- 非同期 SUT は `[Test] void` + `.GetAwaiter().GetResult()`（§2）

Write/Edit 後、**同一レスポンス内で**バインディング表の「コンパイル確認」を実行。
エラー → 最大 3 回修正。修正不可 → 停止。

### B4: 重複整理（dedup パス）[Turn 4]

追加・変更したテスト + 同一テストクラスの既存テストを読み直し、`references/test-designing-guide.md` §7 を適用:
- **真の重複**（condition も assertion も同一）→ より正確な名前を残し他を削除
- **パラメータ化マージ**（同一同値区分・同一期待結果で引数だけ違う）→ 1 メソッドに統合（本体に if/switch なし、期待値をパラメータ化しない）

変更があれば再度「コンパイル確認」を実行。

> このステップは「AI がテストを書きすぎる」傾向への構造的歯止め。書いた直後に必ず通す。

### B5: テスト実行 [Turn 5]

B1 で検出したテスト asmdef のアセンブリ名を指定し、バインディング表の「テスト実行」→「テスト結果取得」を実行する。
各モード最大 3 回ポーリング。タイムアウト → 停止。
`rules/testing.md`「既知失敗テスト」に記録があれば、green/red 判定はそれを除外して行う。

### B6: 結果報告 [最終 Turn]

`## テスト責任 & 実行結果` 形式で報告。PR があれば `gh pr comment` で投稿。必ず含める:
- 対象ファイル
- テスト追加/更新/削除の有無
- 追加/更新した場合: **守る仕様・回帰リスク**（各テストが殺す回帰を 1 行で）
- 重複整理: 削除・統合した内容
- 追加しない場合: 不要理由、または既存テストで十分な理由
- コンパイル確認の結果
- テスト実行の結果（既知失敗を除いた判定）
