---
name: setup-touchdesigner
description: >
  現在の TouchDesigner プロジェクトに、AI エージェントで開発するための一式を導入するセットアップコマンド。
  ユーザーが「TouchDesignerセットアップ」「setup-touchdesigner」「TDMCP を入れて」
  「このプロジェクトに TDMCP.tox を置いて」などと依頼したときに使用する。
  TDMCP 本体（TDMCP.tox）を固定した release から取得してプロジェクト直下へ置き、
  `.mcp.json` へ TDMCP の接続を登録し、CLAUDE.md へ TouchDesigner 操作の方針を配る。skill（td-*）は TDMCP コンポーネントが入れる。
version: 2.0.0
argument-hint: "[導入先ディレクトリ（省略時はカレント）]"
---

# TouchDesigner 開発環境のセットアップ

このコマンドは、対象 TouchDesigner プロジェクトに次を**冪等に**インストールする（再実行安全）:

1. **TDMCP 本体** — [`TouchDesigner/TDMCP`](https://github.com/TouchDesigner/TDMCP) の release から `TDMCP.tox` を取得し、`{target}/TDMCP.tox`（`.claude/` と同じ階層）へ置く。隣に `TDMCP-LICENSE.md` も置く
   - 版と中身は `upstream.mjs` の tag と sha256 で固定する。取得物が sha256 と一致しなければ置かずに警告する
   - 配備先の現物が一致していればネットワークへ出ない。版が違えば置き換える。取得できなければ既存を残す
   - **ファイルを置くだけでは .toe に入らない。** ネットワークへのドラッグと **Active** は人が 1 度だけ行う（Step 3）
2. **MCP 接続** — `{target}/.mcp.json` へ `touchdesigner` → `http://127.0.0.1:13316/mcp` をマージする。コンポーネントの Add MCP（Install Scope: Project）が出す `claude mcp add --scope project` と同じ中身で、CLI を呼ばずに書く。既に `touchdesigner` があれば触らない（ポートは配備先の値を正とする）
3. **CLAUDE.md** — TouchDesigner 操作の方針（MCP 経由・`td-general` から読む・コンポーネントに触らない・破壊的変更の前の確認）
4. **以前の版が直置きした `td-*` skill の取り除き** — 1.x は TDMCPSkills を `.claude/skills/` へ直置きしていた。状態ファイルの記録にあるものと `TDMCP-SKILLS-LICENSE.md` を消す（コンポーネントの Install Skills と二重に読まれるため）。消し終えたら記録も消す
   - `.claude/settings.json` の skillOverrides（プラグイン版の同名 skill を伏せる `"off"`）は**残す**。コンポーネントから入れても、プラグイン版が並べば二重に読まれる点は変わらない

**skill（`td-*`）は配らない。** TDMCP コンポーネントの MCP ページで **Install For** と **Install Scope** を選び、**Install Skills** を押す。範囲は Local（自分だけ）・Project（リポジトリに入り全員で共有）・User（自分の全プロジェクト）から選ぶ。MCP の接続は `.mcp.json` で配り済みなので、**Add MCP** のコマンドは実行しなくてよい。

## 前提

- Node.js 18 以降
- TouchDesigner 2025.33230 以降（TDMCP の動作条件）
- `TDMCP.tox` をネットワークへ入れて **Active** を入れる作業、Install Skills、初回接続の同意パネルは人にしかできない

## 手順

### Step 1: 導入先の確認

- 引数があればそのディレクトリ、なければカレントを導入先とする
- 直下に `.toe` があるかを見る。無ければ導入先が合っているかをユーザーに確かめる
- TDMCP が起動しているかを見る（結果は Step 3 の案内に使う。起動していなくても導入は進める）:

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:13316/mcp
```

  `000` が出る（接続できない）なら未起動。それ以外の応答コードなら起動している（認証が有効なら `401`）

### Step 2: インストール実行

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/setup-touchdesigner/apply.mjs" {target}
```

### Step 2.5: 要マージのファイルを統合する

出力に「要マージ」節があれば、`${CLAUDE_PLUGIN_ROOT}/skills/merge-contract.md` を Read し、
そこに書かれた手順と判断基準に従って統合する。**この工程を飛ばすとテンプレ更新がその配備先に届かない。**

### Step 3: 結果報告

apply.mjs の出力をそのまま伝え、加えて次を案内する:

- **TDMCP が未起動だったら**: プロジェクト直下の `TDMCP.tox` を TouchDesigner のネットワークのルート（`/`）へドラッグし、MCP ページの **Active** を入れる。初回接続時に TouchDesigner 側に同意パネルが出る
- **skill**: MCP ページで Install For（Claude Code）と Install Scope を選び、**Install Skills** を押す。Add MCP のコマンドは実行しない（同じ `touchdesigner` を別の範囲に二重登録する）
- 反映には**新しいセッション**が要る。`.mcp.json` のサーバーは初回起動時に承認を求められる
- コンポーネントの **Port** を既定から変えているなら、`.mcp.json` の `touchdesigner` の URL を合わせる
- **同じ `td-*` を 2 つの範囲に入れない**（例: Project と User）。二重に読まれる。**Skills Status** が警告を出す
- **既に .toe に TDMCP が入っているなら**: `TDMCP.tox` を置き換えても .toe の中のコンポーネントは変わらない。版を揃えるには、古いコンポーネントを消して置き直すか、コンポーネントの About ページの **Update** を使う
- 「以前に直置きした td-* skill」の行が出たら、消したものを伝える。消せなかったものがあれば手で消して再実行してもらう。Install Skills（Project 範囲）は**この適用の後に**押す（先に押すと、同じ名前の skill をこの適用が記録どおりに消す）
- 見送りがあれば理由（取得失敗 / ハッシュ不一致 / 不正な JSON）と、解消後の再実行で入る旨

## 注意

- テンプレート自動追随（sync-setup）は skill 版で判定する。setup-github の導入が前提（ドリフト検知の hook は setup-github が配る）
- `TDMCP.tox` と `TDMCP-LICENSE.md` は配布物なので上書きされる。リポジトリへコミットしてよい（約 300KB。Git LFS は要らない）
- **上流の版を上げるとき（スキル開発者向け）**: `upstream.mjs` の tag と sha256（release の `TDMCP.json` の値）を変え、この SKILL.md の `version:` を上げる。上げないと配備先へ届かない（`npm run check:skill-version` が止める）
