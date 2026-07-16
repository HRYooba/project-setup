# Unity 操作ルール（Unity MCP）

Unity Editor に関わる操作時に常に従う絶対ルール。

## Unity 操作は全て MCP 経由

- 「Unity操作」= Unity Editor の状態を変更する操作（シーン・GameObject・コンポーネント・import 設定・Play Mode 等）
- テキスト/アセットファイルの新規作成・編集自体はファイル操作で行ってよい（適用・確認は下の「コンパイル確認」で行う）
- Unity MCP が接続失敗、または下の「失敗判定」に該当 → 停止してユーザーに確認

## バインディング

- 以下の節は、setup-unity が接続中の Unity MCP 実装に合わせて生成した**実装固有の呼び出し**（常時必要な操作のみ）
- テスト実行・アセット検索・シーン/GameObject/Prefab/Material 検査などの操作は、
  バインディング表の全文（`.claude/skills/test-unity/references/unity-mcp-tools.md`。lint-unity にも同内容）に
  定義される。skills / agents は操作名で表を参照し、以下に無い Unity 操作を行うときは先に表全文を Read する
- 実装を乗り換える場合は setup-unity を再実行して差し替える
