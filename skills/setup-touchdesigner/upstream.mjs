// 配る TDMCPSkills の版。上流の release tag を指す（`main` は随時更新されるブランチで、
// 上流は release を正式版としている）。
//
// ここを変えたら setup-touchdesigner の SKILL.md の version を上げる。配備先への追随は
// skill 版の比較で判定されるため、版を上げない tag の更新はどの配備先にも届かない
// （apply.mjs の import に載るので、bump 忘れは check:skill-version が止める）。
export const TDMCP_SKILLS_REPO = "https://github.com/TouchDesigner/TDMCPSkills.git";
export const TDMCP_SKILLS_TAG = "1.4.1";
