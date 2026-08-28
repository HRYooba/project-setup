---
name: test-unity
description: >
  このスキルは、ユーザーが「テスト実行」「テスト生成」「ユニットテスト」「単体テスト」「/test-unity」
  と依頼した場合に使用される。変更差分のテスト責任を判定し、必要なUnityテストの設計・実装・重複整理・実行、
  またはテスト不要理由の報告を行う。ファイルパスやフォルダパスの指定も可。
version: 2.0.0
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

このファイルは実行フロー（Unity CLI 操作とターン計画）のみを定義する。
**テストの追加・削除の是非は必ず designing-guide のゲートで判断する**。

Unity 操作の方針・失敗判定・コンパイル確認・コンソールエラー取得は `.claude/rules/unity-cli.md` が正。
`unity test` は Editor 常駐を要さないので、**live Editor に到達できなくてもこの skill は完走できる**。

## 呼び出しパターン

| パターン | 動作 |
|---|---|
| `/test-unity` | ブランチ変更 → テスト要否判定 → 設計 → 実装 → 重複整理 → 実行 |
| `/test-unity Assets/.../Foo.cs` | 指定ファイルのテスト要否判定 → 設計 → 実装 → 重複整理 → 実行 |

## ターン実行計画

| Turn | ステップ | 内容 |
|:-----|:---------|:----------------|
| 1 | B1 | 前提判定 + git diff x3 + Glob x2（並列）→ 対象ファイル決定 |
| 2 | B2 | 整合性検査 + コンソールエラー + **仕様ソース** + 全対象 + 依存型 + 既存テストを取得 → **設計** |
| 3 | B3 | **実装**（writing-guide で Write/Edit）→ コンパイル確認 |
| 4 | B4 | **重複整理**（designing-guide §7）→ コンパイル確認 |
| 5 | B5 | `unity test` 実行 → 結果判定（red なら切り分け） |
| 6 | B6 | 結果報告（+ PR コメント） |

**B3 / B4 は無条件段ではない。** B2 でゲートを通ったケースが 0 件なら B3 / B4 を飛ばして B5 へ進み、
テストを 1 件も書かずに報告する（手ぶらで B6 に入る経路が正規のフローに含まれる）。

---

### B1: 前提判定と対象ファイル決定 [Turn 1]

引数パース: `.cs` → 対象ファイル / `/` → 対象ディレクトリ / なし → git diff。

default branch は `git symbolic-ref --short refs/remotes/origin/HEAD` で検出する
（失敗時は `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`。以下 `<default>` と表記）。

**1 回の並列呼び出しで同時実行:**
```
Bash: unity doctor --ci --format json
Bash: unity pipeline list --format json
Bash: git symbolic-ref --short refs/remotes/origin/HEAD && git diff --name-only origin/<default>...HEAD -- '*.cs'
Bash: git diff --name-only HEAD -- '*.cs'
Bash: git ls-files --others --exclude-standard -- '*.cs'
Glob: Assets/App/Scripts/Tests/EditMode/*.asmdef
Glob: Assets/App/Scripts/Tests/EditMode/**/*Test.cs
```

`unity doctor --ci` の判定（**ここで落ちたらテストを書かずに停止する**。実装してから
「ライセンスが無くて実行できません」と報告するのは時間の無駄）:

| 結果 | 扱い |
|:--|:--|
| exit 0 | 続行（warning 行は報告に含めるだけ） |
| exit 6 | 確定失敗。`errors[]` の code（`LICENSE_NONE` / `EDITOR_NOT_INSTALLED` / `DISK_SPACE_LOW` 等）と remediation を添えて停止 |
| exit 7 | サービス到達不可で判定不能。1 回だけ再実行し、それでも 7 なら停止 |

`unity pipeline list` は**到達性**の判定に使う（`rules/unity-cli.md`「前提の確認」の表）。
到達できるなら B3 のコンパイル確認を行い、できないなら飛ばして B5 の `unity test` に兼ねさせる。
**到達性の判定に `unity doctor --ci` を使わない**（あれは Editor のインストール有無）。

3 つの git 結果を合算・重複除去して対象一覧とする。
- 変更なし → 「テスト対象なし」で停止

**対象選別（自動検出時のみ）** — `references/test-designing-guide.md` §1・§2 に従い、
テスト対象外（ランタイム挙動の手動確認に委譲する変更等）のみなら「テスト不要」の理由を添えて終了。

対象 0 件 → 停止。

### B2: 解析 & 設計 [Turn 2]

**整合性検査 + コンソールエラー + 仕様ソース + 全対象ファイル + 依存型 + 同名既存テストを
1 レスポンスにまとめて実行**（逐次読み禁止）。

```
Bash: unity projects verify --format json
Bash: unity command --format json    # 到達できる場合のみ。再コンパイル・ログ取得の名前をここで拾う
（+ 仕様ソース・対象ファイル・依存型・既存テストの Read / gh 呼び出し）
```

ここでコマンド名を拾っておくと、B3 のコンパイル確認を Write/Edit と同一レスポンスで撃てる。
到達できない場合は発見を撃たず、コンソールエラーは Editor ログから読む（`rules/unity-cli.md`）。

- `unity projects verify` が `CONFLICT_MARKERS` / `MANIFEST_INVALID` / `GUID_DUPLICATE` を返す →
  **テストを書かずに停止**。この状態のテスト結果は信用できない（マージ事故の残骸なので、
  直すのはテストの仕事ではない）
- `META_MISSING` / `META_ORPHAN` → 報告に載せて続行（テスト結果自体は成立する）
- 既存のコンパイルエラー検出 → 停止してユーザーに確認

**仕様ソースを必ず 1 つ以上読む**（期待値の出所を実装以外に持つため）:
- PR があれば `gh pr view --json title,body`、Issue が紐づいていれば `gh issue view <N>`
- 対象の振る舞いを規定する `rules/*.md` の該当節
- どれも取得できない場合は「仕様ソース無し」として記録し、**期待値を実装から複写しない**。
  仕様が判然としないケースは `AskUserQuestion` で確認するか、未定義仕様として報告して書かない。

Read 結果から抽出:
1. 名前空間・クラス名・基底・実装 interface
2. コンストラクタ（依存と型）
3. public メソッド / プロパティ（シグネチャ）
4. 所属アセンブリ（パスから推定）

> **private フィールドの初期値を期待値の出所にしない。** 初期契約をテストする場合の期待値は、
> 仕様ソースまたは購読側が依存している値から決める（実装の初期化子を読み返すのは写経）。

各対象について `references/test-designing-guide.md` に従い判定する:
1. §1・§2 で**テスト要否**を決める（不要なら理由を記録して対象から外す）
2. §3 技法 + §4 依存エラー方針で**検証すべきケースを列挙**
3. §5 **追加前ゲート**（回帰特定 / 一意性 / 仕様語↔assertion 整合 / ダブル語彙）を各ケースに適用。1 つでも満たせないケースは捨てる
4. §6 合成クラス方針 / §8 禁止リスト / §9 テスタビリティに照合

> 設計段階で、各ケースについて**そのテストが落ちる具体的な実装改変**を 1 つ挙げる（§5 ゲート 1）。
> 挙げられないケース、および既存テストが同じ改変で落ちるケースは書かない。
> テスタビリティ FAIL（§9）の兆候があれば、テストを書かず対象コードの設計見直しを報告する。
> **1 対象クラスあたりの新規テストが 5 件を超える場合、超過分は書かずに候補一覧として報告する。**

### B3: 実装 [Turn 3]

**B2 でゲートを通ったケースが 0 件ならこの段を実行せず B5 へ進む。**

`references/test-writing-guide.md` に従い実装する。
- asmdef を実ファイルで確認し、不足参照のみ追加（§6）
- 既存テストがあれば優先して **Edit**、無ければ **Write**（配置・命名・namespace は §1）
- TestDoubles は共有定義を使う。新規スタブは `TestDoubles/<Context>/` に追加（§3）
- 非同期 SUT は `[Test] void` + `.GetAwaiter().GetResult()`（§2）

Write/Edit 後、`rules/unity-cli.md` の「コンパイル確認」を実行する。
**コマンド名を B2 で発見済みなら Write/Edit と同一レスポンスで撃てる。** 未発見なら
`unity command --format json` を先に撃ち、次のレスポンスで実行する（発見の戻り値が要るので畳めない）。

live Editor に到達できない場合はこの段を飛ばし、B5 の `unity test` にコンパイル確認を兼ねさせる
（コンパイルエラーなら exit 8 ではなく 6 で落ちるので区別できる）。
エラー → 最大 3 回修正。修正不可 → 停止。

### B4: 重複整理（dedup パス）[Turn 4]

追加・変更したテスト + 同一テストクラスの既存テストを読み直し、`references/test-designing-guide.md` §7 を適用:
- **重複**（同じ実装箇所の同じ回帰を殺している）→ より正確な名前を残し他を削除
- **パラメータ化マージ**（同一同値区分・同一期待結果で引数だけ違う）→ 1 メソッドに統合（本体に if/switch なし、期待値をパラメータ化しない）
- **禁止リスト該当の既存テスト**（`rules/testing.md`）→ 削除を提案し、B6 で一覧を報告する

変更があれば再度「コンパイル確認」を実行。

> このステップは「AI がテストを書きすぎる」傾向への構造的歯止め。書いた直後に必ず通す。

### B5: テスト実行 [Turn 5]

```bash
unity test --mode EditMode --filter <パターン> --format json
```

レポートファイルが要るとき（CI へ渡す等）だけ `--report-format junit --output <path>` を足す。
既定では書かない — 使わないファイルを作業ツリーへ落とすと `.gitignore` の管理が増える。

**`--filter` に何を渡すか（この節が既定の正本）:**

1. `rules/testing.md`「テスト実行のスコープ」に値があればそれを使う
2. 無ければ **B1 で検出したテストの名前空間**（`*Test.cs` の `namespace` 宣言から取る。
   asmdef 名とは一致しないので、ファイルの中身を見る）
3. 名前空間が特定できなければ `--filter` を付けない（全件実行）

- **実行件数が 0 件なら緑と扱わず停止する。** `--filter` が何にもマッチしないと exit 0 で返るので、
  リネーム後の古いスコープがそのまま「成功」に見える。レポートの実行件数を必ず確認する
- **ポーリングしない。** `unity test` は完了まで戻らない
- 長時間化が想定されるなら `--timeout <秒>` を付ける（超過は exit 6）

**結果判定は exit code で行う**（`rules/unity-cli.md`「失敗判定」の表が正）:

| exit | 意味 | 次にやること |
|:--|:--|:--|
| 0 | 全件成功 | B6 へ |
| 8 | テストが実行されて失敗 | 下の「red の切り分け」 |
| 6 / その他の非 0 | 実行に至らなかった（コンパイルエラー・ライセンス・認証・タイムアウト） | **テスト失敗として報告しない。**`rules/unity-cli.md`「失敗判定」の表と `errors[0].code`（`TEST_RUN_ERROR` / `TEST_TIMED_OUT`）で切り分けて報告 |

**red の切り分け**（exit 8 のとき）:

1. `unity test --rerun-failed --format json` — 失敗分だけ再実行して再現性を見る（全件を回し直さない）
2. **再現した** → 自分が加えた変更に起因するかを判定し、修正して 1 に戻る（最大 3 回）
3. **再現しなかった** → `unity test --filter <失敗したテスト> --retries 2 --format json` で flaky か確かめる。
   CLI がリトライ通過を **flaky** として報告するので、その報告をそのまま根拠にする。
   **自分の判断で「たまたま落ちた」と結論しない**

### B6: 結果報告 [最終 Turn]

`## テスト責任 & 実行結果` 形式で報告。PR があれば `gh pr comment` で投稿。
報告項目は `rules/testing.md`「完了報告」が単一ソース。この skill 固有の追加項目は次の 5 つ:
- 対象ファイルと、参照した仕様ソース（無ければ「仕様ソース無し」と明記）
- 重複整理: 削除・統合した内容、削除を提案した既存テストとその根拠
- `unity test` の exit code と、それが「テスト失敗」か「実行できなかった」かの区別
- flaky と判定されたテスト（`--retries` の報告に基づくもののみ）
- ゲート通過が 0 件だった場合、または 5 件上限で保留した候補があればその一覧
