# Git 運用ルール

## ブランチ戦略（Git Flow）

### 永続ブランチ

| ブランチ | 役割 |
|:---------|:-----|
| `main` | リリース済みの安定版。 |
| `develop` | 開発統合ブランチ。次回リリースに向けた最新の開発状態 |

### 作業ブランチ

| プレフィックス | 用途 | 例 |
|:---------------|:-----|:---|
| `feature/` | 新機能の追加 | `feature/12-player-movement` |
| `fix/` | バグ修正 | `fix/34-camera-flicker` |
| `refactor/` | リファクタリング | `refactor/56-cleanup-presenter` |
| `perf/` | パフォーマンス改善 | `perf/91-avatar-load` |
| `docs/` | ドキュメント更新 | `docs/78-update-readme` |
| `style/` | フォーマット変更 | `style/82-formatter` |
| `test/` | テストの追加・修正 | `test/45-add-auth-tests` |
| `build/` | ビルドシステム・依存関係 | `build/93-uniask-update` |
| `ci/` | CI 設定変更 | `ci/95-cache-key` |
| `chore/` | その他の雑務 | `chore/90-misc` |

### リリース・緊急修正ブランチ

| プレフィックス | 切り元 | マージ先 | 用途 |
|:---------------|:-------|:---------|:-----|
| `release/` | `develop` | `main` と `develop` | リリース準備（バージョン更新、最終調整） |
| `hotfix/` | `main` | `main` と `develop` | リリース済みの緊急バグ修正 |

## コミット規約（Conventional Commits 準拠）

[Conventional Commits v1.0.0](https://www.conventionalcommits.org/ja/v1.0.0/) に準拠する。

### フォーマット

```
<type>(<scope>): <説明>

<body（任意）>

<footer（任意）>
```

- `<scope>` は任意。記載する場合は変更領域を表す名詞（モジュール名・機能名・レイヤー名）を **小文字 kebab-case** で書く
- Breaking Change は subject に `!` を付けるか、footer に `BREAKING CHANGE: <説明>` を書く（両方併記可）
- Issue 参照は subject に書かず、footer に GitHub の auto-close キーワード（`Closes` / `Fixes` / `Resolves`）+ `#N` で書く

### type 一覧

| type | 用途 |
|:-----|:-----|
| `feat` | 新機能の追加 |
| `fix` | バグ修正 |
| `docs` | ドキュメントのみの変更 |
| `style` | コード動作に影響しないフォーマット変更（空白・セミコロン等） |
| `refactor` | 機能変更を伴わないコード改善 |
| `perf` | パフォーマンス改善 |
| `test` | テストの追加・修正 |
| `build` | ビルドシステム・外部依存関係の変更 |
| `ci` | CI 設定・スクリプトの変更 |
| `chore` | その他の雑務（上記いずれにも当てはまらない保守作業） |
| `revert` | 過去コミットの取り消し |

### 書き方ガイド

- 日本語で簡潔に記述する
- 「何をしたか」ではなく「何が変わるか」を意識する
- 1 コミット = 1 つの論理的変更にまとめる
- subject 行は **全角 25〜30 字目安** に収める
- subject は **体言止め** または **動詞終止形** で統一する（"した" / "しました" など過去形・敬体は避ける）
- subject 末尾に **句点を付けない**
- body を書く場合は subject との間に空行を 1 行入れ、各行は 72 字以内で改行する

### Breaking Change

```
feat!: 認証APIの戻り値型を OperationResult へ変更

BREAKING CHANGE: AuthService.LoginAsync の戻り値が AuthResult から
OperationResult<AuthInfo> へ変更。呼び出し側の result.IsSuccess チェックが必要
```

### Issue 参照

GitHub の auto-close キーワードを footer に書く:

```
feat: プレイヤーのジャンプ機能を追加

Closes #12
```

- `Closes` / `Fixes` / `Resolves` の各派生（`closed` / `fixes` / `resolved` 等）が auto-close キーワード
- `(#12)` を subject に書いてもキーワードがないと auto-close は動作しない
- auto-close は **default branch にマージされた時のみ** 発火する

### `revert` の運用

`git revert` の自動生成メッセージ（`Revert "<元subject>"`）は Conventional Commits 形式ではないため、**手動で書き換える**:

```
revert: feat: プレイヤーのジャンプ機能を追加

This reverts commit abc1234.
理由: ジャンプアニメーションが破綻するため
```

### 例

```
feat: プレイヤーのジャンプ機能を追加

Closes #12
```

```
feat(player): ジャンプ機能を追加
```

```
fix(camera): シーン遷移時のちらつきを修正

Fixes #34
```

```
refactor(presenter): 共通処理を基底クラスに集約
```

```
perf: アバター読み込みを並列化
```

```
build: UniTask を 2.5.10 へアップデート
```

```
ci: GitHub Actions のキャッシュキーを修正
```

## Pull Request 規約

### タイトルフォーマット

```
<type>(<scope>): <説明>
```

- コミット規約と同じ形式
- `(#issue-number)` を **タイトルに付けない**（Issue 参照は本文の auto-close キーワードで表現）
- GitHub の Squash Merge は PR タイトル末尾に `(#PR番号)` を **自動付与** する。これは PR 番号であり Issue 番号とは別物

### PR テンプレート

`.github/pull_request_template.md` を配置すると PR 作成時に本文へ自動挿入される。以下を標準テンプレとして配置する:

```markdown
Closes #

## Summary

## Test plan
- [ ] 
```

- 先頭の `Closes #` に Issue 番号を入れる（複数 Issue を閉じる場合は `Closes #N` を改行して複数行）
- Issue 紐づけがない PR では `Closes #` 行を削除する
- `## Summary` は何が変わるか、`## Test plan` は検証項目をチェックリストで記載

### Issue の自動クローズ

PR 本文先頭の auto-close キーワードで Issue を自動クローズする:

- キーワード: `Closes` / `Fixes` / `Resolves`（および `closed` / `fixes` / `resolved` 等の派生）
- `(#12)` 単独では auto-close は発火しない
- default branch にマージされた時のみ発火する

## Issue 運用（GitHub Issues）

### Issue とブランチの紐付け

- ブランチ名に Issue 番号を含める
- フォーマット: `<type>/<issue-number>-<簡潔な説明>`

例: `feature/12-player-movement`, `fix/34-camera-flicker`

### Issue ラベル

コミット規約の type と同じ体系のラベルを使用し、ワークフロー全体で一貫性を保つ。

| ラベル | 用途 | 対応する type |
|:-------|:-----|:-------------|
| `feat` | 新機能の追加 | `feat` |
| `fix` | バグ修正 | `fix` |
| `docs` | ドキュメント | `docs` |
| `style` | フォーマット変更 | `style` |
| `refactor` | リファクタリング | `refactor` |
| `perf` | パフォーマンス改善 | `perf` |
| `test` | テスト | `test` |
| `build` | ビルドシステム・依存関係 | `build` |
| `ci` | CI 設定 | `ci` |
| `chore` | その他雑務 | `chore` |

- `revert` は Issue として起票せず、必要時に直接 revert コミットを行う
- `/create-issue` 実行時にコンテキストから type を判定し、対応するラベルを自動付与する
- 1 つの Issue に付与する type ラベルは原則 1 つとする

### Issue の記載項目

- **機能追加**: 概要、背景・目的、スコープ、対象外、完了条件を含めること
- **バグ報告**: 概要、再現手順、期待する動作、実際の動作、スコープ、完了条件を含めること
- **その他（refactor / perf / docs / style / test / build / ci / chore）**: 概要、背景・目的、スコープ、対象外、完了条件を含めること
- 制約・注意点、検証観点、参考情報は必要に応じて含めること
- テンプレート本文は `/create-issue` スキルが自動適用する
