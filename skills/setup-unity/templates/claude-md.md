## 開発ワークフロー

- **Unity 操作**: Unity 操作はすべて Unity CLI 経由で行う。`.unity` / `.prefab` / `.asset` / `.meta` を手編集しない
- **Editor の起動・終了**: このプロジェクトの Editor の起動・保存・終了・再起動はユーザーに聞かずに行う（unity-cli skill の「ユーザーに聞く／閉じてもらう」より優先）。対象は常に `--project-path` か `<project>` で指定した**このプロジェクトの Editor だけ**。他プロジェクトの Editor には触れず、Unity のプロセスを名前でまとめて kill しない
  - 起動: `unity status --project-path <project>` で Editor が無ければ `unity open <project> --until-ready --timeout 600`
  - 終了・再起動: `unity close` は保存しないので、先に `unity command editor save_all` を実行してから `unity close <project>` を実行する。`--force` を使うのは、graceful な終了が timeout したとき、または Pipeline に繋がらない Editor（Safe Mode・起動時のダイアログで止まっている）だけ
  - Safe Mode: `.cs` を直して `unity status --until-ready` で抜けるのを待つ。抜けなければ上の手順で閉じ、開き直す
  - 聞くもの: `--accept-upgrades`（プロジェクトのファイルを書き換える）と `unity bug`（ログを外部へ送る）だけ
- **コンパイル確認**: `.cs` を変更したら `unity command recompile --timeout 120` → `unity command recompile_status` を回し、`failed` と `errors` を読んで直す。Editor がフォーカスされていなくても通り、`AssetDatabase.Refresh()` も要らない（未 import のファイルも recompile が拾う）。`status` の終了値は `completed` と `up_to_date` の 2 つ（変更が無ければ後者）で、片方だけを待つと戻らない
- **規約の機械チェック**: `warning UCS` は `recompile_status` に出ない（返るのは `errors` だけ）。`unity command console --level warn` で読む。**再コンパイルが起きた回にしか出ない**うえ console は過去ぶんを溜めた buffer なので、recompile の前に `unity command console --tail 1` で `cursor` を控え、`--since <cursor>` で今回ぶんだけ読む。0 件を「違反なし」と読まない
- **テスト**: `{{APP_ROOT}}` 配下の `.cs` を変更したなら、PR を作る前に `/code-review`（必要なら `/security-review`）の指摘を反映した**後**に回す
- **テストの対象**: 回すのは**このプロジェクト自身のテストアセンブリだけ**。`unity test` を無指定で撃つと `Packages/` 配下の外部アセットのテストまで回り、こちらの都合で直せないものが混ざる。対象は `Assets/` 配下の `*.asmdef` から**その場で導出**して `--filter` に渡す（アセンブリ名をこの CLAUDE.md へ書き写さない。asmdef が増減すると黙って嘘になる）
- **lint**: PR を作る前に回すものに `/lint-unity` がある（起動条件は lint-unity の description が正本）
