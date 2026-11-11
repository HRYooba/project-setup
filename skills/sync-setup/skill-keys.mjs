// 追随の対象になる skill。状態ファイルのキーでもある。
// skill-version.mjs と分けて置く: そちらは全 apply.mjs の import に載るため、ここへ同居させると
// skill を足すだけで全 skill の版の bump が要求される（配備先の出力は変わらないのに同期 PR が出る）。
export const SKILL_KEYS = ["setup-github", "setup-unity", "setup-touchdesigner"];
