## 開発ワークフロー

- **Unity 操作**: Editor の状態を変える操作（シーン・GameObject・コンポーネント・import 設定・Play Mode）は Unity CLI 経由で行う。テキスト/アセットファイルの編集自体はファイル操作でよい
- **シリアライズファイル**: `.unity` / `.prefab` / `.asset` / `.meta` などを手編集しない。GUID / fileID が壊れ、その場では分からない（Editor に到達できない Safe Mode のときだけ例外）
- **テスト**: `.cs` を変更したなら PR を作る前に回す。`/code-review`（必要なら `/security-review`）の指摘を反映した**後**に回すこと — レビューは 1 回だけ実行する決まりなので、順序を逆にすると反映で入れた修正が未検証のまま PR に乗る
