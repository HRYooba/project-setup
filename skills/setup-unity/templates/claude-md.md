## 開発ワークフロー

- **Unity 操作**: Unity 操作はすべて Unity CLI 経由で行う。`.unity` / `.prefab` / `.asset` / `.meta` を手編集しない
- **テスト**: `Assets/App/` 配下の `.cs` を変更したなら、PR を作る前に `/code-review`（必要なら `/security-review`）の指摘を反映した**後**に回す。あわせて Editor のログの `warning UCS` を読んで直す（規約の機械チェック。**再コンパイルが起きた回のログにしか出ない**ので、0 行を「違反なし」と読まない）
- **テストの対象**: 回すのは**このプロジェクト自身のテストアセンブリだけ**。`unity test` を無指定で撃つと `Packages/` 配下の外部アセットのテストまで回り、こちらの都合で直せないものが混ざる。対象は `Assets/` 配下の `*.asmdef` から**その場で導出**して `--filter` に渡す（アセンブリ名をこの CLAUDE.md へ書き写さない。asmdef が増減すると黙って嘘になる）
- **lint**: `Assets/App/` 配下のアセット・シーン・Prefab を変更したなら、PR を作る前に `/lint-unity` を回す
