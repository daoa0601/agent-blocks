import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);
const packed = spawnSync("pnpm", ["pack", "--dry-run", "--json"], {
  cwd: process.cwd(),
  encoding: "utf8",
  maxBuffer: 10 * 1024 * 1024,
});

if (packed.status !== 0) {
  process.stderr.write(packed.stderr);
  process.exit(packed.status ?? 1);
}

let manifest;
try {
  const parsed = JSON.parse(packed.stdout);
  manifest = Array.isArray(parsed) ? parsed[0] : parsed;
} catch {
  console.error("pnpm pack did not return valid JSON.");
  process.exit(1);
}

if (manifest === undefined || !Array.isArray(manifest.files)) {
  console.error("pnpm pack did not return a file manifest.");
  process.exit(1);
}

const files = new Set(
  manifest.files
    .map((entry) => (typeof entry?.path === "string" ? entry.path.replace(/^\.\//u, "") : ""))
    .filter(Boolean),
);
const failures = [];
const forbidden = [
  ".env",
  ".github/",
  ".githooks/",
  ".pnpm-store/",
  "coverage/",
  "node_modules/",
  "src/",
  "tests/",
];

for (const file of files) {
  if (forbidden.some((prefix) => file === prefix || file.startsWith(prefix))) {
    failures.push(`forbidden package entry: ${file}`);
  }
  if (/\.(?:key|p12|pem|pfx)$/iu.test(file)) {
    failures.push(`secret-bearing package entry: ${file}`);
  }
}

function requirePacked(file, source) {
  if (typeof file !== "string") return;
  const normalized = file.replace(/^\.\//u, "");
  if (!files.has(normalized)) failures.push(`missing ${source}: ${normalized}`);
}

requirePacked("package.json", "manifest");
requirePacked("README.md", "documentation");
requirePacked(packageJson.main, "main entry");
requirePacked(packageJson.types, "types entry");
for (const [name, target] of Object.entries(packageJson.bin ?? {})) {
  requirePacked(target, `bin entry ${name}`);
}

function visitExport(value, label) {
  if (typeof value === "string") {
    requirePacked(value, label);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) visitExport(nested, `${label}.${key}`);
}
visitExport(packageJson.exports, "export");

if (typeof packageJson.scripts?.preinstall === "string") {
  const scriptPath = "scripts/quality/require-pnpm.mjs";
  if (packageJson.scripts.preinstall.includes(scriptPath)) requirePacked(scriptPath, "preinstall");
}

if (failures.length > 0) {
  console.error("Package manifest check failed:");
  for (const failure of [...new Set(failures)].sort()) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Package manifest check passed (${files.size} files, no forbidden entries).`);
