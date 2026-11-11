// 上流の Claude プラグイン（skills / commands / agents）を、プラグイン機構を通さず配備先の
// `.claude/` へ直接置く。setup-unity（公式 unity プラグイン）と setup-touchdesigner（TDMCPSkills）が使う。
//
// プラグインとして入れると、実体は宣言したプロジェクトではなく `~/.claude/plugins/cache/` へ
// コピーされ、そこから読まれる。配備先のリポジトリに置いても同じで、キャッシュを経由しない
// 経路が無い。個人マシンへ実体を残さず、リポジトリの現物をそのまま読ませるには直置きしかない。
//
// **project-setup 側にコピーを持たない。** テンプレートへ写すと上流の更新がこちらの手作業でしか
// 届かなくなる。適用のたびに上流を clone し、配った sha と名前を状態ファイルへ記録する。
// 記録との食い違いだけが入れ直しの条件になる。

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/* global console */

// 上流トップ階層の仕分け。プラグインローダーは**ディレクトリ名の規約**で構成要素を拾う
// （plugin.json に宣言は要らない）。よってここも名前で振り分ける。
//   copyDirs    … 配るもの。`.claude/<kind>/` へ各エントリを丸ごと（references/ などごと）写す。
//                 値は「これを持つディレクトリだけを配る」marker（null なら全エントリ）
//   inert       … 配備先では何もしないもの（manifest・リポジトリの開発用ファイルなど）
//   unsupported … 直置きでは**再現できない**構成要素（hook は `${CLAUDE_PLUGIN_ROOT}` と
//                 settings.json 登録が要る。MCP も同様）。配らずに名指しで報告する
// **どれにも無い名前が上流に現れたら unknown として報告する。** 黙って無視すると、上流が
// 構成要素を足した更新が「入ったつもりで入っていない」状態のまま誰にも気づかれない。
export const DEFAULT_COPY_DIRS = { skills: "SKILL.md", commands: null, agents: null };
export const DEFAULT_UNSUPPORTED = ["hooks", ".mcp.json"];

/**
 * @param {object} o
 * @param {string} o.repo           clone 元
 * @param {string|null} o.ref       配る sha / tag。null なら上流 HEAD
 * @param {{ missing: string, failed: (ref: string) => string }} o.refNotes
 *                                  ref が無い／取得できないときに状態文言の末尾へ付ける注記
 * @param {string} o.claudeDir      配備先の .claude
 * @param {object} [o.recorded]     前回の記録（{ sha, placed }）
 * @param {(rel: string) => boolean} o.isOwn  自前の配布物か（相対パス `skills/x/SKILL.md` など）
 * @param {string[]} o.inert
 * @param {string} o.licenseName    LICENSE.md を `.claude/skills/` に置くときの名前
 * @param {string} o.tmpPrefix
 */
export function vendorUpstreamPlugin({
  repo,
  ref,
  refNotes,
  claudeDir,
  recorded,
  isOwn,
  inert,
  copyDirs = DEFAULT_COPY_DIRS,
  unsupported: unsupportedNames = DEFAULT_UNSUPPORTED,
  licenseName,
  tmpPrefix,
}) {
  const prevPlaced = recorded?.placed && typeof recorded.placed === "object" ? recorded.placed : {};
  const prevOf = (kind) => (Array.isArray(prevPlaced[kind]) ? prevPlaced[kind].map(String) : []);
  const skip = (state) => ({ state, record: recorded, unsupported: [], unknown: [], collided: [] });
  const inertSet = new Set(inert);
  const unsupportedSet = new Set(unsupportedNames);

  const tmp = mkdtempSync(join(tmpdir(), tmpPrefix));
  try {
    const clone = spawnSync("git", ["clone", "--depth", "1", "--quiet", repo, tmp], {
      encoding: "utf8",
      timeout: 180000,
    });
    if (clone.error) {
      return skip(
        clone.error.code === "ENOENT" ? "見送りました（git がありません）" : `見送りました（${clone.error.message}）`
      );
    }
    if (clone.status !== 0) {
      const msg = (clone.stderr || clone.stdout || "").trim().split(/\r?\n/).pop() ?? "";
      return skip(`見送りました（clone 失敗 exit ${clone.status}${msg ? `: ${msg}` : ""}）`);
    }

    // 指定の ref へ移す。--depth 1 の clone には HEAD しか無いので個別に fetch する。
    // 失敗したら HEAD のまま続ける（配置は決定的に完了させる）。
    let refNote = ref ? "" : refNotes.missing;
    if (ref) {
      const moved =
        spawnSync("git", ["-C", tmp, "fetch", "--depth", "1", "origin", ref], { encoding: "utf8", timeout: 180000 })
          .status === 0 &&
        spawnSync("git", ["-C", tmp, "checkout", "--quiet", "FETCH_HEAD"], { encoding: "utf8", timeout: 60000 })
          .status === 0;
      if (!moved) refNote = refNotes.failed(ref);
    }

    const head = spawnSync("git", ["-C", tmp, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 30000 });
    const sha = head.status === 0 ? (head.stdout ?? "").trim() : null;
    if (!sha) return skip("見送りました（sha を読めませんでした）");

    const top = readdirSync(tmp);
    const unsupported = top.filter((n) => unsupportedSet.has(n)).sort();
    const unknown = top.filter((n) => !inertSet.has(n) && !unsupportedSet.has(n) && !(n in copyDirs)).sort();

    // **自前の配布物と名前がぶつかったら上流を配らない。** 黙って潰すと別物へ差し替わる。
    // どちらを採るかは人の判断なので、触らずに名指しで報告する。
    const collided = [];
    const wanted = {};
    for (const [kind, marker] of Object.entries(copyDirs)) {
      const src = join(tmp, kind);
      if (!existsSync(src) || !statSync(src).isDirectory()) continue;
      const names = [];
      for (const n of readdirSync(src).sort()) {
        if (marker && !existsSync(join(src, n, marker))) continue;
        if (isOwn(`${kind}/${n}`) || isOwn(`${kind}/${n}/${marker ?? "SKILL.md"}`)) {
          collided.push(`${kind}/${n}`);
          continue;
        }
        names.push(n);
      }
      if (names.length) wanted[kind] = names;
    }
    if (!wanted.skills) {
      return skip("見送りました（上流に配れる skills/ がありません。構成が変わった可能性があります）");
    }

    const counts = Object.entries(wanted).map(([kind, n]) => `${n.length} ${kind}`);
    const unchanged =
      recorded?.sha === sha &&
      Object.keys(wanted).length === Object.keys(prevPlaced).length &&
      Object.entries(wanted).every(([kind, names]) => {
        const prev = prevOf(kind);
        return prev.length === names.length && prev.every((n) => names.includes(n) && existsSync(join(claudeDir, kind, n)));
      });
    if (unchanged) {
      return {
        state: `導入済み（${counts.join(" / ")} / ${sha.slice(0, 7)} と一致）${refNote}`,
        record: { sha, placed: wanted },
        unsupported,
        unknown,
        collided,
      };
    }

    for (const [kind, names] of Object.entries(wanted)) {
      const dstDir = join(claudeDir, kind);
      mkdirSync(dstDir, { recursive: true });
      for (const n of names) {
        const dst = join(dstDir, n);
        rmSync(dst, { recursive: true, force: true });
        cpSync(join(tmp, kind, n), dst, { recursive: true });
      }
    }
    // 再配布にはライセンス表記が付いて回る。配った skill と同じ場所に置く。
    const licenseSrc = join(tmp, "LICENSE.md");
    if (existsSync(licenseSrc)) cpSync(licenseSrc, join(claudeDir, "skills", licenseName));

    // 上流から消えたものを配備先からも消す。**前回配った記録にあるものだけ**を対象にする
    // （自前の配布物は別経路なので触ってはいけない）。
    const dropped = [];
    for (const kind of new Set([...Object.keys(prevPlaced), ...Object.keys(wanted)])) {
      const names = wanted[kind] ?? [];
      for (const n of prevOf(kind)) {
        if (names.includes(n)) continue;
        const p = join(claudeDir, kind, n);
        if (!existsSync(p)) continue;
        try {
          rmSync(p, { recursive: true });
          dropped.push(`${kind}/${n}`);
        } catch (e) {
          console.log(`注意: 上流から消えた配布物を削除できませんでした（手で消してください）: .claude/${kind}/${n} — ${e.message}`);
        }
      }
    }

    const prefix = recorded?.sha
      ? `入れ直しました（記録 ${String(recorded.sha).slice(0, 7)} → ${sha.slice(0, 7)}）`
      : `導入しました（${sha.slice(0, 7)}）`;
    const suffix = dropped.length ? `。上流から消えた ${dropped.length} 件を削除: ${dropped.join(" ")}` : "";
    return {
      state: `${prefix}: ${counts.join(" / ")}${suffix}${refNote}`,
      record: { sha, placed: wanted },
      unsupported,
      unknown,
      collided,
    };
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // 一時ディレクトリが残るだけなので握りつぶす
    }
  }
}

// プラグインとして入っている同名 skill を伏せる。
//
// 直置きした skill と同じものをマーケットプレース経由で user スコープに入れているマシンでは、
// `<namespace>:<name>` へ名前空間化された同じ skill が並んで**両方**モデルへ提示され、
// どちらを引くかは決まっていない。`.claude/settings.json` の skillOverrides で名指しで伏せる。
//
// 伏せる名前は**配った skill から導出する**ので、上流の増減に自動で追随する。
// **既に値があるなら上書きしない**（"on" の明示は重複を承知した配備先の意思）。
// **上流から消えた skill の "off" は取り下げる**（値が "off" のものだけ）。
export function disablePluginSkills(claudeDir, namespaces, names, prevNames) {
  const wanted = [...new Set(names)].sort();
  const stale = prevNames.filter((n) => !wanted.includes(n));
  if (wanted.length === 0 && stale.length === 0) return "対象なし";
  const keysOf = (list) => namespaces.flatMap((ns) => list.map((n) => `${ns}:${n}`));
  const p = join(claudeDir, "settings.json");
  let obj = {};
  if (existsSync(p)) {
    try {
      obj = JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
    } catch {
      return "見送りました（settings.json が不正な JSON です。手で直してから再実行してください）";
    }
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
      return "見送りました（settings.json のトップレベルがオブジェクトではありません）";
    }
  }
  const overrides = obj.skillOverrides;
  if (overrides !== undefined && (typeof overrides !== "object" || overrides === null || Array.isArray(overrides))) {
    return "見送りました（settings.json の skillOverrides がオブジェクトではありません）";
  }
  const next = { ...(overrides ?? {}) };
  const added = [];
  const kept = [];
  const pruned = [];
  for (const key of keysOf(stale)) {
    if (next[key] !== "off") continue;
    delete next[key];
    pruned.push(key);
  }
  const wantedKeys = keysOf(wanted);
  for (const key of wantedKeys) {
    const current = next[key];
    if (typeof current === "string") {
      if (current !== "off") kept.push(`${key}: ${current}`);
      continue;
    }
    next[key] = "off";
    added.push(key);
  }
  if (added.length || pruned.length) {
    obj.skillOverrides = next;
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
  }
  const parts = [];
  parts.push(added.length ? `${added.length} 件を off にしました` : `変更なし（${wantedKeys.length} 件は設定済み）`);
  if (pruned.length) parts.push(`上流から消えた ${pruned.length} 件の off を取り下げ: ${pruned.join(" ")}`);
  if (kept.length) parts.push(`触っていません: ${kept.join(" / ")}（配備先の意思とみなします）`);
  return parts.join("。");
}

// vendorUpstreamPlugin の結果のうち、上流の構成変化を示す警告を出す。
// `owner` は対応を取る側の skill 名（文言に出す）。
export function printUpstreamWarnings(result, owner) {
  if (result.unsupported?.length) {
    console.log(`警告: 上流に直置きでは再現できない構成要素があります（配っていません）: ${result.unsupported.join(" ")}`);
    console.log(
      "  hook は ${CLAUDE_PLUGIN_ROOT} の解決と settings.json への登録が要り、MCP も同様です。" +
        `プラグインとして入れるか、${owner} 側で明示的に対応するか決めてください。`
    );
  }
  if (result.unknown?.length) {
    console.log(`警告: 上流に扱いを決めていない要素があります（配っていません）: ${result.unknown.join(" ")}`);
    console.log(`  ${owner} の上流の仕分け（配る / 何もしない / 再現できない）に足してください。`);
  }
}

export function printCollisionWarning(result, owner) {
  if (!result.collided?.length) return;
  console.log(`警告: 上流の配布物が ${owner} 自前のものと同名です（上流側を配っていません）: ${result.collided.join(" ")}`);
  console.log(`  どちらを採るかは人の判断です。上流を採るなら ${owner} 側の配布をやめてください。`);
}
