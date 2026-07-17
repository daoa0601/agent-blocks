import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

if (root !== process.cwd()) {
  console.error("Run this command from the repository root.");
  process.exit(1);
}

try {
  execFileSync("git", ["config", "--local", "--unset-all", "core.hooksPath"], {
    cwd: root,
    stdio: "ignore",
  });
} catch {
  // The default .git/hooks path was already active.
}

const rawHooksDirectory = execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
  encoding: "utf8",
}).trim();
const hooksDirectory = path.isAbsolute(rawHooksDirectory)
  ? rawHooksDirectory
  : path.resolve(root, rawHooksDirectory);
const managedMarker = "# managed-by: agentic-orch-quality";
mkdirSync(hooksDirectory, { recursive: true });

for (const hook of ["pre-commit", "pre-push"]) {
  const source = path.join(root, ".githooks", hook);
  const destination = path.join(hooksDirectory, hook);
  const expected = readFileSync(source, "utf8");

  if (existsSync(destination)) {
    const existing = readFileSync(destination, "utf8");
    if (existing !== expected && !existing.includes(managedMarker)) {
      console.error(`Refusing to overwrite unmanaged Git hook: ${destination}`);
      process.exit(1);
    }
  }

  copyFileSync(source, destination);
  chmodSync(destination, 0o755);
}

console.log(`Installed managed pre-commit and pre-push hooks in ${hooksDirectory}.`);
