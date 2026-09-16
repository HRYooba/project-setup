## 開発ワークフロー

- **Unity 操作**: Unity 操作はすべて Unity CLI 経由で行う。`.unity` / `.prefab` / `.asset` / `.meta` を手編集しない
- **コンパイル確認**: `.cs` を変更したら `unity command recompile --timeout 120` → `unity command recompile_status` を回し、`failed` と `errors` を読んで直す。Editor がフォーカスされていなくても通り、`AssetDatabase.Refresh()` も要らない（未 import のファイルも recompile が拾う）。`status` の終了値は `completed` と `up_to_date` の 2 つ（変更が無ければ後者）で、片方だけを待つと戻らない
- **規約の機械チェック**: `warning UCS` は `recompile_status` に出ない（返るのは `errors` だけ）。`unity command console --level warn` で読む。**再コンパイルが起きた回にしか出ない**うえ console は過去ぶんを溜めた buffer なので、recompile の前に `unity command console --tail 1` で `cursor` を控え、`--since <cursor>` で今回ぶんだけ読む。0 件を「違反なし」と読まない
- **テスト**: `{{APP_ROOT}}` 配下の `.cs` を変更したなら、PR を作る前に `/code-review`（必要なら `/security-review`）の指摘を反映した**後**に回す
- **テストの対象**: 回すのは**このプロジェクト自身のテストアセンブリだけ**。`unity test` を無指定で撃つと `Packages/` 配下の外部アセットのテストまで回り、こちらの都合で直せないものが混ざる。対象は `Assets/` 配下の `*.asmdef` から**その場で導出**して `--filter` に渡す（アセンブリ名をこの CLAUDE.md へ書き写さない。asmdef が増減すると黙って嘘になる）
- **lint**: `{{APP_ROOT}}` 配下のアセット・シーン・Prefab を変更したなら、PR を作る前に `/lint-unity` を回す
