# Git 運用ルール

[Conventional Commits v1.0.0](https://www.conventionalcommits.org/ja/v1.0.0/) に準拠する。commit / branch / PR / Issue すべて同じ type 語彙で揃える。以下は spec に無い「日本語運用」と「GitHub 固有の落とし穴」だけを書く。

## 日本語での書き方

- subject は日本語で書く
- **全角 25〜30 字目安**
- **体言止めまたは動詞終止形**（"した" / "しました" など過去形・敬体は使わない）
- **末尾に句点を付けない**

## Issue の自動クローズ（GitHub 固有）

- auto-close は **footer または PR 本文の `Closes #N`** で発火する。**`(#N)` を書いただけでは発火しない**
- subject と PR タイトルに `(#N)` を**書かない**。GitHub の Squash Merge がタイトル末尾へ `(#PR番号)` を自動付与するため、手書きの Issue 番号と混同する

## ブランチ

- `<type>/<issue番号>-<簡潔な説明>`（例: `fix/34-camera-flicker`）。`<type>` はコミットの type と同じ語彙（`feat/` を使い `feature/` は使わない）

## revert

- `git revert` の自動生成メッセージ（`Revert "<元subject>"`）は Conventional Commits 形式ではないため、`revert: <元subject>` + footer `Refs: <sha>` + 理由 の形へ手で書き換える

## PR テンプレート

`.github/pull_request_template.md`（小文字・単一ファイル）が無いリポジトリでは、この内容で作る。Issue 紐づけが無い PR では `Closes #` 行を削除する。

```markdown
Closes #

## Summary

## Test plan
- [ ] 
```
