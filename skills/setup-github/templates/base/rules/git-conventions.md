# Git 運用ルール

[Conventional Commits v1.0.0](https://www.conventionalcommits.org/ja/v1.0.0/) に準拠する。commit / branch / PR / Issue すべて同じ type 語彙で揃える。以下は spec に無い「日本語運用」と「この環境の取り決め」だけを書く。

## 日本語での書き方

- subject は日本語で書く
- **全角 25〜30 字目安**
- **体言止めまたは動詞終止形**（"した" / "しました" など過去形・敬体は使わない）
- **末尾に句点を付けない**

## PR 本文

- 先頭に `Closes #N`（Issue 紐づけが無ければ省略）、続けて `## Summary` と `## Test plan`
- `.github/pull_request_template.md`（小文字・単一ファイル）を置くとこの形が自動挿入される

## ブランチ

- `<type>/<簡潔な説明>`。Issue が紐づくときだけ番号を挟む `<type>/<issue番号>-<簡潔な説明>`（例: `fix/camera-flicker` / `fix/34-camera-flicker`）
- `<type>` はコミットの type と同じ語彙（`feat/` を使い `feature/` は使わない）

## revert

- `git revert` の自動生成メッセージ（`Revert "<元subject>"`）は Conventional Commits 形式ではないため、`revert: <元subject>` + footer `Refs: <sha>` + 理由 の形へ手で書き換える
