// セキュリティ感応な変更の検出（security-review-nudge.mjs が使う純粋関数）。
//
// 目的: 「毎 PR で /security-review」ではなく「感応な変更を含む PR でだけ促す」ための
// ヒューリスティック。誤検知・見逃しは原理的に避けられない前提で、非ブロックの nudge
// 用途に振っている（balanced: 依存変更 / 感応パス・名 / 追加行キーワード の OR）。
//
// この関数は git I/O を持たない（テスト可能に保つ）。呼び出し側が files（変更パス）と
// addedLines（追加行・先頭 + を除いたもの）を集めて渡す。ツール設定系（.claude/ 等）の
// 自己変更で誤発火しないよう、呼び出し側で除外パスを外してから渡すこと。

// 依存マニフェスト（basename 完全一致 or 特定パス/拡張子）。追加・更新はサプライチェーン
// 面で見直す価値があるため感応扱い。
const DEP_BASENAMES = new Set([
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml",
  "requirements.txt", "pipfile", "pipfile.lock", "pyproject.toml", "poetry.lock",
  "gemfile", "gemfile.lock", "go.mod", "go.sum", "cargo.toml", "cargo.lock",
  "composer.json", "composer.lock", "pom.xml", "build.gradle", "build.gradle.kts",
  "packages.config",
]);

export function isDepManifest(path) {
  const p = String(path).toLowerCase();
  const base = p.split("/").pop();
  if (DEP_BASENAMES.has(base)) return true;
  if (p.endsWith(".csproj")) return true; // .NET / Unity
  // Unity Package Manager
  if (p.endsWith("packages/manifest.json") || p.endsWith("packages/packages-lock.json")) return true;
  return false;
}

// 感応パス/ファイル名（小文字化して部分一致）。認証・秘密情報・暗号まわりを curate。
// balanced ゆえ多少の巻き込み（例: tokenizer が "token" に当たる）は許容する。
const SENSITIVE_PATH_TERMS = [
  "auth", "login", "signin", "logout", "session", "token", "secret", "credential",
  "password", "passwd", "crypto", "cipher", "encrypt", "decrypt", "jwt", "oauth",
  "saml", "authoriz", "permission", "cookie", "apikey", "api-key", "api_key",
  "privatekey", "private-key", ".env",
];

export function sensitivePath(path) {
  const p = String(path).toLowerCase();
  return SENSITIVE_PATH_TERMS.some((t) => p.includes(t));
}

// 追加行のキーワード分類。ラベル単位でまとめ、当たった分類名を理由に載せる。
// 大文字小文字は無視。誤検知抑制のため語境界（\b）を要所で使う。
export const KEYWORD_CATEGORIES = [
  {
    label: "暗号・秘密情報の操作",
    re: /\b(crypto|createcipher|createhash|pbkdf2|bcrypt|scrypt|hmac|randombytes)\b|\b(aes|rsa)\b|api[_-]?key|\bsecret\b|\bpassword\b|\btoken\b/i,
  },
  {
    label: "外部コマンド実行",
    re: /child_process|\bexecsync\b|\bexecfilesync\b|\bexec\b|\bspawn\b|subprocess|os\.system|runtime\.getruntime|process\.start|shell\s*=\s*true|\beval\(/i,
  },
  {
    label: "SQL 組立",
    re: /\b(select|insert|update|delete)\b[\s\S]{0,40}\b(from|into|set|where)\b|executequery|rawquery|rawsql/i,
  },
  {
    label: "デシリアライズ",
    re: /\bpickle\b|yaml\.load\b|\bmarshal\b|objectinputstream|binaryformatter|typenamehandling|\bunserialize\b/i,
  },
  {
    label: "XSS / DOM 注入",
    re: /innerhtml|dangerouslysetinnerhtml|document\.write|new\s+function\(/i,
  },
  {
    label: "TLS / CORS / CSRF 設定",
    re: /access-control-allow-origin|\bcors\b|\bcsrf\b|rejectunauthorized\s*[:=]\s*false|insecureskipverify|ssl_verify_none|trustallcerts|verify\s*=\s*false/i,
  },
];

// files（変更パス配列）と addedLines（追加行配列）から感応理由の配列を返す。
// 空配列なら「感応なし」＝ nudge 不要。順序は依存 → パス → 追加行キーワード。
export function securityReasons({ files = [], addedLines = [] } = {}) {
  const reasons = [];
  if (files.some(isDepManifest)) reasons.push("依存関係の変更（package.json / lockfile 等）");
  if (files.some(sensitivePath)) reasons.push("認証・秘密情報に関わるパス/ファイル名");
  const blob = addedLines.join("\n");
  if (blob) {
    for (const c of KEYWORD_CATEGORIES) {
      if (c.re.test(blob)) reasons.push(`追加コードに${c.label}`);
    }
  }
  return reasons;
}
