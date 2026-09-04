// Roslyn analyzer のビルドと、setup-unity テンプレートへの反映。
//
// 生成物（テンプレート側）:
//   skills/setup-unity/templates/project/Assets/Analyzers/UnityCodingStandards.Analyzers.dll
// 生成物（この配下）:
//   analyzers/dist.json   — 配布 DLL がどのソースから作られたかの記録
//
// dist.json の sourceHash は tests/setup-unity-analyzer.test.mjs が検証する。ソースを変えて
// このスクリプトを流し忘れると、そこで落ちる（DLL とソースが黙って乖離しない）。
//
// 設定ファイル（.ruleset / .globalconfig）は生成しない。既定 severity は Warning 固定で、
// PR の gate は CI がコンパイルログの 'warning UCS' を拾って落とす。Error へ上げたい配備先が
// 自分で Assets/Default.ruleset を置く（配布物としては持たない）。
//
// 使い方: node analyzers/build.mjs
// 依存: .NET SDK（`dotnet`）。Node 標準以外のパッケージには依存しない。

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ANALYZER_SRC_DIR, hashAnalyzerSources } from "./source-hash.mjs";
/* global process, console */

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = ANALYZER_SRC_DIR;
const project = join(srcDir, "UnityCodingStandards.Analyzers.csproj");
const analyzersDir = join(
  here, "..", "skills", "setup-unity", "templates", "project", "Assets", "Analyzers");
const assemblyName = "UnityCodingStandards.Analyzers";

const dotnet = spawnSync("dotnet", ["build", project, "-c", "Release", "--nologo"], { encoding: "utf8" });
if (dotnet.status !== 0) {
  console.error(dotnet.stdout ?? "");
  console.error(dotnet.stderr ?? "");
  console.error("dotnet build が失敗しました。");
  process.exit(1);
}

const builtDll = join(srcDir, "bin", "Release", "netstandard2.0", `${assemblyName}.dll`);
mkdirSync(analyzersDir, { recursive: true });
copyFileSync(builtDll, join(analyzersDir, `${assemblyName}.dll`));

const sourceHash = hashAnalyzerSources();
writeFileSync(
  join(here, "dist.json"),
  JSON.stringify(
    { assembly: `${assemblyName}.dll`, sourceHash, generatedBy: "analyzers/build.mjs" },
    null,
    2
  ) + "\n",
  "utf8"
);

console.log(`ビルド: ${builtDll}`);
console.log(`配置  : ${join(analyzersDir, `${assemblyName}.dll`)}`);
console.log(`記録  : ${join(here, "dist.json")}（sourceHash: ${sourceHash.slice(0, 12)}…）`);
