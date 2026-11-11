---
name: setup-touchdesigner
description: >
  現在の TouchDesigner プロジェクトに、AI エージェントで開発するための一式を導入するセットアップコマンド。
  ユーザーが「TouchDesignerセットアップ」「setup-touchdesigner」「TDMCP を入れて」
  「このプロジェクトに TouchDesigner の skill を入れて」などと依頼したときに使用する。
  公式 TDMCPSkills（td-* skill）を上流の release tag から引いて `.claude/skills/` へ直接置き、
  TDMCP 本体（TDMCP.tox）を release から取得してプロジェクト直下へ置き、
  `.mcp.json` へ TDMCP の接続を登録し、CLAUDE.md へ TouchDesigner 操作の方針を配る。
version: 1.1.0
argument-hint: "[導入先ディレクトリ（省略時はカレント）]"
---

# TouchDesigner 開発環境のセットアップ

このコマンドは、対象 TouchDesigner プロジェクトに次を**冪等に**インストールする（再実行安全）:

1. **TDMCPSkills** — [`TouchDesigner/TDMCPSkills`](https://github.com/TouchDesigner/TDMCPSkills) の `skills/` を `{target}/.claude/skills/` へ**直接置く**（プラグインとしては入れない。理由は setup-unity の公式 unity プラグインと同じで、個人マシンのキャッシュを経由せずリポジトリの現物を全員が読むため）
   - 配る版は `upstream.mjs` が固定した **release tag**。`main` は配らない（上流は release を正式版としている）。tag を取得できなければ見送り、前回の配置と記録を残す
   - 再配布なので `LICENSE.md` も置く（`.claude/skills/TDMCP-SKILLS-LICENSE.md`。Shared Use License）
   - 上流から消えた skill は配備先からも消す。対象は前回配った記録にあるものだけ
   - 直置きで再現できない構成要素（`hooks/`）と、扱いを決めていない要素は配らず警告する
2. **プラグイン版の同名 skill を伏せる** — `{target}/.claude/settings.json` の `skillOverrides` へ `"tdmcp-skills:<name>": "off"` と `"touchdesigner:<name>": "off"` を入れる。前者は TDMCPSkills の marketplace から、後者は Claude Desktop 向けプラグインのアカウント同期で Claude Code に届く。既に値があるものは上書きしない
3. **TDMCP 本体** — [`TouchDesigner/TDMCP`](https://github.com/TouchDesigner/TDMCP) の release から `TDMCP.tox` を取得し、`{target}/TDMCP.tox`（`.claude/` と同じ階層）へ置く。隣に `TDMCP-LICENSE.md` も置く
   - 版と中身は `upstream.mjs` の tag と sha256 で固定する。取得物が sha256 と一致しなければ置かずに警告する
   - 配備先の現物が一致していればネットワークへ出ない。版が違えば置き換える。取得できなければ既存を残す
   - **ファイルを置くだけでは .toe に入らない。** ネットワークへのドラッグと **Active** は人が 1 度だけ行う（Step 3）
4. **MCP 接続** — `{target}/.mcp.json` へ `touchdesigner` → `http://127.0.0.1:13316/mcp` をマージする。既に `touchdesigner` があれば触らない（ポートは配備先の値を正とする）
5. **CLAUDE.md** — TouchDesigner 操作の方針（MCP 経由・`td-general` から読む・コンポーネントに触らない・破壊的変更の前の確認）

## 前提

- Node.js 18 以降と `git` が使える（`git` が無いと skill の配置だけ見送って続行する）
- TouchDesigner 2025.33230 以降（TDMCP の動作条件）
- `TDMCP.tox` をネットワークへ入れて **Active** を入れる作業と、初回接続の同意パネルは人にしかできない

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

- 反映には**新しいセッション**が要る。`.mcp.json` のサーバーは初回起動時に承認を求められる
- **TDMCP が未起動だったら**: プロジェクト直下の `TDMCP.tox` を TouchDesigner のネットワークのルート（`/`）へドラッグし、MCP ページの **Active** を入れる。初回接続時に TouchDesigner 側に同意パネルが出る
- **既に .toe に TDMCP が入っているなら**: `TDMCP.tox` を置き換えても .toe の中のコンポーネントは変わらない。版を揃えるには、古いコンポーネントを消して置き直すか、コンポーネントの About ページの **Update** を使う
- **コンポーネントの Install Skills は使わない**。既に使っていたら、コンポーネントの **Uninstall Skills** で外す（同じ `td-*` が二重に読まれる。**Skills Status** が警告を出す）
- コンポーネントの **Port** を既定から変えているなら、`.mcp.json` の `touchdesigner` の URL を合わせる
- **警告行が出ていたら必ず伝える**（`直置きでは再現できない構成要素` / `扱いを決めていない要素`）。上流の構成が変わった合図で、setup-touchdesigner 側の対応が要る
- 見送りがあれば理由（`git` が無い / clone 失敗 / 取得失敗 / ハッシュ不一致 / 不正な JSON）と、解消後の再実行で入る旨

## 注意

- `.claude/skills/td-*` は**上書きコピー**される。手編集は次の適用で消える。独自の skill は `td-` 以外の接頭辞で作る（上流が `td-` を自分の名前空間としている）
- テンプレート自動追随（sync-setup）は skill 版で判定する。setup-github の導入が前提（ドリフト検知の hook は setup-github が配る）
- `TDMCP.tox` と `TDMCP-LICENSE.md` は配布物なので上書きされる。リポジトリへコミットしてよい（約 300KB。Git LFS は要らない）
- **上流の版を上げるとき（スキル開発者向け）**: `upstream.mjs` の tag を変え（TDMCP を上げるなら sha256 も、release の `TDMCP.json` の値へ。TDMCPSkills の tag は TDMCP の release が同梱する版に揃える）、この SKILL.md の `version:` を上げる。上げないと配備先へ届かない（`npm run check:skill-version` が止める）
