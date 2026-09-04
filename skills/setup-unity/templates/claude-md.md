## 開発ワークフロー

- **Unity 操作**: Unity 操作はすべて Unity CLI 経由で行う。`.unity` / `.prefab` / `.asset` / `.meta` を手編集しない
- **テスト**: `.cs` を変更したなら、PR を作る前に `/code-review`（必要なら `/security-review`）の指摘を反映した**後**に回す
- **lint**: アセット・シーン・Prefab を変更したなら、PR を作る前に `/lint-unity` を回す
