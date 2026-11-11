## TouchDesigner 開発ワークフロー

- **TouchDesigner 操作**: ネットワークの読み書きは TDMCP の MCP ツール（`touchdesigner` サーバー）経由で行う。`.toe` / `.tox` はバイナリなので手編集しない
- **skill**: TouchDesigner の作業では最初に `td-general` を読み、そこの Skill Map に従って他の `td-*` を読む。`td-*` は `.claude/skills/` に同梱済み。TDMCP コンポーネントの **Install Skills** は使わない（同じ skill が二重に読まれる）
- **繋がらないとき**: TouchDesigner の起動、TDMCP コンポーネントの **Active**、初回接続時の同意パネルはユーザーにしかできない。どれが欠けているかを伝えて頼む
- **TDMCP コンポーネント（`/TDMCP`）には触らない**。`execute_code` からも変更しない。プロジェクト直下の `TDMCP.tox` も手で差し替えない（setup-touchdesigner が版を固定して配る）
- **破壊的な変更の前に確認する**: operator の削除や大きな組み替えの前に、`.toe` が保存済みか・git にコミット済みかをユーザーに確かめる。ツールの変更は TouchDesigner の undo に積まれるが、保存していない `.toe` は TouchDesigner が落ちると戻せない
