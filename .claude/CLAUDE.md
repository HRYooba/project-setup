# project-setup 開発メモ

## バージョン管理（版数字は手で触らない）

- **plugin.json の `version` は手編集しない**。`.github/workflows/release.yml` が main への merge 時に自動 bump し、tag と GitHub Release も作る（bump コミットは `chore(release): vX [skip ci]`）。
- **bump 段は PR タイトルの Conventional Commits type で決まる**。default が squash merge なので、squash commit の subject ＝ PR タイトルになり、release.yml はそれを読む:
  - `feat:` → **minor**
  - `fix:` / その他（`refactor` `chore` `docs` など）→ **patch**
  - `!` 付き or `BREAKING CHANGE` → **major**
- よって唯一の操作は **PR タイトルの type を実態に合わせること**。配布物の挙動が変わるなら `feat`。branch 側の commit subject は squash で消えるため bump には効かない。

## skill 版（SKILL.md の `version:`）

- **`skills/<skill>/SKILL.md` の `version:` は plugin.json とは別系統で手動**。plugin.json の数字とは無関係。
- **この数字はテンプレ自動追随の drift 判定に載っている**（`skills/sync-setup/skill-version.mjs`）。プラグイン版では判定しない — それだと setup-unity のテンプレだけ変わった更新で setup-github だけの配備先まで drift 扱いになる。
- したがって **`templates/**` か `apply.mjs` を変えた PR では必ず上げる**。上げ忘れると、その更新はどの配備先にも**黙って**届かない（エラーも出ない）。
- 忘れは機械が止める: `npm run check:skill-version origin/main`（CI の `skill-version` job が PR で走る）。merge-base から作業ツリーまでを見るので、push 前にローカルでも同じ判定が出る。
- 2 層になっている。**plugin.json の version が「配る」トリガー**（marketplace の更新機構が見る）、**skill 版が「配備先へ反映する」トリガー**。前者が上がらないと後者の変更は誰のマシンにも届かない。
