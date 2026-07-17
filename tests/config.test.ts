import { writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { loadWorkflow } from "../src/config.js";
import { makeGitRepository } from "./helpers.js";

describe("loadWorkflow", () => {
  it("normalizes defaults and resolves the workspace relative to the YAML file", async () => {
    const repository = await makeGitRepository();
    const workflowPath = path.join(repository, "workflow.yaml");
    await writeFile(
      workflowPath,
      `version: 1
name: fixture
objective: Make a focused improvement
workspace: .
supervisor:
  instructions: Coordinate explicit roles.
roles:
  - id: builder
    kind: candidate
    description: Implements a candidate.
    instructions: Keep changes small.
`,
      "utf8",
    );

    const workflow = await Effect.runPromise(loadWorkflow(workflowPath));
    expect(workflow.workspace).toBe(repository);
    expect(workflow.roles[0]?.maxTurns).toBe(2);
    expect(workflow.limits.maxConcurrentAgents).toBe(2);
    expect(workflow.codex.ignoreUserConfig).toBe(true);
  });

  it("rejects duplicate role IDs", async () => {
    const repository = await makeGitRepository();
    const workflowPath = path.join(repository, "workflow.yaml");
    await writeFile(
      workflowPath,
      `version: 1
name: fixture
objective: Improve it
workspace: .
supervisor:
  instructions: Coordinate.
roles:
  - id: builder
    kind: candidate
    description: First.
    instructions: Build.
  - id: builder
    kind: research
    description: Duplicate.
    instructions: Inspect.
`,
      "utf8",
    );

    await expect(Effect.runPromise(loadWorkflow(workflowPath))).rejects.toThrow(
      /Duplicate role id/u,
    );
  });
});
