import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function makeTempDirectory(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function makeGitRepository(): Promise<string> {
  const repository = await makeTempDirectory("aiur-orchestrator-repo-");
  execFileSync("git", ["init", "--quiet"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "harness@example.invalid"], {
    cwd: repository,
  });
  execFileSync("git", ["config", "user.name", "Harness Test"], { cwd: repository });
  await writeFile(path.join(repository, "README.md"), "fixture\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repository });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repository });
  return repository;
}
