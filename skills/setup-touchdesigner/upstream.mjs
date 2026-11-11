// 配る TDMCP 本体（TDMCP.tox）の release。
//
// ここを変えたら setup-touchdesigner の SKILL.md の version を上げる。配備先への追随は
// skill 版の比較で判定されるため、版を上げない tag の更新はどの配備先にも届かない
// （apply.mjs の import に載るので、bump 忘れは check:skill-version が止める）。
//
// sha256 は release の TDMCP.json が載せる値。取得物はこれと照合し、一致しなければ置かない。
// skill（TDMCPSkills）はここでは固定しない。コンポーネントの Install Skills が入れ、
// 版は既定で TDMCPSkills の最新 release になる（固定はコンポーネントの Skills Version で行う）。
export const TDMCP_REPO = "TouchDesigner/TDMCP";
export const TDMCP_TAG = "1.1.57";
export const TDMCP_TOX_SHA256 = "a074d4564d5e08eea918271ec88de80ed1fb92b6fa49aa4e8cc1cdc8e67fdfac";
