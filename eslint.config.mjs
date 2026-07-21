// project-setup 自身の lint 設定（flat config）。
//
// 目的: テンプレート .mjs（配備先の .claude/hooks 等へコピーされる hook / installer）が、
// eslint を回すプロジェクトへ落ちても CI を壊さないことを source 側で保証する。
// 実例: setup-sync-check.mjs が no-irregular-whitespace（正規表現内のリテラル BOM）と
// no-undef（Buffer 未宣言）で配備先 CI（2606）を落とした。ここで先に検出する。
//
// 方針: **Node グローバルを自動付与しない**。各ファイルが `/* global process, ... */` で
// 自己宣言することを強制し、宣言漏れ（＝グローバルを提供しない配備先で no-undef になる型）を
// source 側で捕まえる。配備先の eslint 設定は千差万別なので、globals を自己宣言したテンプレが
// 最も可搬。整形は Prettier 非依存（このリポは Prettier を使わない）。

import js from "@eslint/js";

export default [
  { ignores: ["node_modules/**"] },
  js.configs.recommended,
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
    },
  },
];
