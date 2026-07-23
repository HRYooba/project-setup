# project-setup 開発メモ

## バージョン管理（版数字は手で触らない）

- **plugin.json の `version` は手編集しない**。`.github/workflows/release.yml` が main への merge 時に自動 bump し、tag と GitHub Release も作る（bump コミットは `chore(release): vX [skip ci]`）。
- **bump 段は PR タイトルの Conventional Commits type で決まる**。default が squash merge なので、squash commit の subject ＝ PR タイトルになり、release.yml はそれを読む:
  - `feat:` → **minor**
  - `fix:` / その他（`refactor` `chore` `docs` など）→ **patch**
  - `!` 付き or `BREAKING CHANGE` → **major**
- よって唯一の操作は **PR タイトルの type を実態に合わせること**。配布物の挙動が変わるなら `feat`。branch 側の commit subject は squash で消えるため bump には効かない。
- **SKILL.md の `version:` は別系統で手動**。各 skill を実質変更した PR では +minor する慣行（plugin.json とは無関係の数字。自動化なし・付け忘れ注意）。
