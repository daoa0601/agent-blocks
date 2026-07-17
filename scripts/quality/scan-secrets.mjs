import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const listed = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
);
const files = listed.split("\0").filter(Boolean).sort();
const findings = [];

function lineAt(source, index) {
  return source.slice(0, index).split("\n").length;
}

function report(file, line, kind) {
  findings.push(`${file}:${line}: ${kind}`);
}

function forbiddenSecretFile(file) {
  const base = path.basename(file).toLowerCase();
  return (
    base === ".env" ||
    base === "credentials.json" ||
    base.endsWith(".pem") ||
    base.endsWith(".key") ||
    base.endsWith(".p12") ||
    base.endsWith(".pfx")
  );
}

function safePlaceholder(raw) {
  const value = raw.replace(/^["']|["']$/gu, "");
  return (
    value.length === 0 ||
    /^(?:replace-|your-|example|dummy|test-|not-needed|redacted|undefined|null|none|false|true|<)/iu.test(
      value,
    ) ||
    value.startsWith("$") ||
    value.startsWith("process.env") ||
    /^[A-Z][A-Z0-9_]+$/u.test(value)
  );
}

const highConfidencePatterns = [
  {
    kind: "private key material",
    regex: new RegExp(["-----BEGIN ", "(?:RSA |EC |OPENSSH )?", "PRIVATE KEY-----"].join(""), "gu"),
  },
  {
    kind: "OpenAI-style secret token",
    regex: new RegExp(["sk-", "(?:proj-)?", "[A-Za-z0-9_-]{20,}"].join(""), "gu"),
  },
  {
    kind: "GitHub secret token",
    regex: new RegExp(["gh", "[pousr]_", "[A-Za-z0-9]{30,}"].join(""), "gu"),
  },
  {
    kind: "AWS access key",
    regex: new RegExp(["AK", "IA", "[0-9A-Z]{16}"].join(""), "gu"),
  },
];

for (const file of files) {
  if (forbiddenSecretFile(file)) {
    report(file, 1, "secret-bearing filename must not be committed");
  }

  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (content.includes("\0")) continue;
  if (file === "scripts/quality/scan-secrets.mjs") continue;

  for (const { kind, regex } of highConfidencePatterns) {
    regex.lastIndex = 0;
    for (const match of content.matchAll(regex)) {
      report(file, lineAt(content, match.index ?? 0), kind);
    }
  }

  if (!/(?:^|\/)(?:\.env[^/]*|[^/]+\.(?:json|ya?ml|toml|ini|properties))$/iu.test(file)) {
    continue;
  }
  const assignment =
    /\b(?:PRIVATE_KEY|SECRET|PASSWORD|API_KEY|TOKEN|CLIENT_SECRET)\b\s*[:=]\s*([^\s,;}]+)/giu;
  for (const match of content.matchAll(assignment)) {
    const value = match[1] ?? "";
    if (!safePlaceholder(value)) {
      report(file, lineAt(content, match.index ?? 0), "non-placeholder secret assignment");
    }
  }
}

if (findings.length > 0) {
  console.error("Secret scan failed:");
  for (const finding of [...new Set(findings)].sort()) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`Secret scan passed (${files.length} repository files inspected).`);
