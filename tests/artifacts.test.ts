import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { ContentAddressedStoreError } from "@agentic-orch/node-guardrails/cas";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { PATCH_MEDIA_TYPE, publishPatchArtifact } from "../src/artifacts.js";
import { JournalError } from "../src/errors.js";
import { makeTempDirectory } from "./helpers.js";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("publishPatchArtifact", () => {
  it("publishes an empty patch as a durable content-addressed artifact", async () => {
    const root = await makeTempDirectory("agent-blocks-empty-artifact-");
    const patchPath = path.join(root, "candidate.patch");
    const artifactsDirectory = path.join(root, "artifacts");
    await writeFile(patchPath, Buffer.alloc(0));

    const artifact = await Effect.runPromise(
      publishPatchArtifact({ patchPath, artifactsDirectory }),
    );

    expect(artifact).toEqual({
      artifactId: EMPTY_SHA256,
      digest: EMPTY_SHA256,
      size: 0,
      mediaType: PATCH_MEDIA_TYPE,
      artifactPath: path.join(artifactsDirectory, `${EMPTY_SHA256}.patch`),
    });
    expect(await readFile(artifact.artifactPath)).toHaveLength(0);
  });

  it("deduplicates identical patches without changing the published contract", async () => {
    const root = await makeTempDirectory("agent-blocks-deduplicated-artifact-");
    const firstPatchPath = path.join(root, "first.patch");
    const secondPatchPath = path.join(root, "second.patch");
    const artifactsDirectory = path.join(root, "artifacts");
    await Promise.all([
      writeFile(firstPatchPath, "same patch\n"),
      writeFile(secondPatchPath, "same patch\n"),
    ]);

    const [first, second] = await Promise.all([
      Effect.runPromise(publishPatchArtifact({ patchPath: firstPatchPath, artifactsDirectory })),
      Effect.runPromise(publishPatchArtifact({ patchPath: secondPatchPath, artifactsDirectory })),
    ]);

    expect(second).toEqual(first);
    expect(await readdir(artifactsDirectory)).toEqual([`${first.digest}.patch`]);
    expect(await readFile(first.artifactPath, "utf8")).toBe("same patch\n");
  });

  it("fails closed when a digest path is already occupied by corrupt content", async () => {
    const root = await makeTempDirectory("agent-blocks-corrupt-artifact-");
    const patchPath = path.join(root, "candidate.patch");
    const artifactsDirectory = path.join(root, "artifacts");
    const patch = Buffer.from("trusted patch\n");
    const digest = createHash("sha256").update(patch).digest("hex");
    const occupant = path.join(artifactsDirectory, `${digest}.patch`);
    await mkdir(artifactsDirectory, { mode: 0o700 });
    await Promise.all([writeFile(patchPath, patch), writeFile(occupant, "corrupt")]);

    const error = await Effect.runPromise(
      Effect.flip(publishPatchArtifact({ patchPath, artifactsDirectory })),
    );

    expect(error).toBeInstanceOf(JournalError);
    expect(error).toMatchObject({
      cause: expect.any(ContentAddressedStoreError),
    });
    expect(error.cause).toMatchObject({ kind: "digest_mismatch" });
    expect(await readFile(occupant, "utf8")).toBe("corrupt");
  });
});
