import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";

import { JournalError } from "./errors.js";

export const PATCH_MEDIA_TYPE = "text/x-diff";

export interface PublishedPatchArtifact {
  readonly artifactId: string;
  readonly digest: string;
  readonly size: number;
  readonly mediaType: typeof PATCH_MEDIA_TYPE;
  /** Trusted harness-internal location; never expose this through the public run projection. */
  readonly artifactPath: string;
}

export function publishPatchArtifact(options: {
  readonly patchPath: string;
  readonly artifactsDirectory: string;
}): Effect.Effect<PublishedPatchArtifact, JournalError> {
  return Effect.tryPromise({
    try: async () => {
      const bytes = await readFile(options.patchPath);
      const digest = createHash("sha256").update(bytes).digest("hex");
      const artifactPath = path.join(options.artifactsDirectory, `${digest}.patch`);
      await mkdir(options.artifactsDirectory, { recursive: true });
      try {
        await writeFile(artifactPath, bytes, { flag: "wx" });
      } catch (cause) {
        if (
          typeof cause !== "object" ||
          cause === null ||
          !("code" in cause) ||
          cause.code !== "EEXIST"
        ) {
          throw cause;
        }
        const existingStat = await lstat(artifactPath);
        if (!existingStat.isFile()) {
          throw new Error(`Existing artifact ${digest} is not a regular file`);
        }
        const existing = await readFile(artifactPath);
        const existingDigest = createHash("sha256").update(existing).digest("hex");
        if (existingDigest !== digest) {
          throw new Error(`Existing artifact ${digest} does not match its content address`);
        }
      }
      return {
        artifactId: digest,
        digest,
        size: bytes.byteLength,
        mediaType: PATCH_MEDIA_TYPE,
        artifactPath,
      };
    },
    catch: (cause) =>
      new JournalError({
        message: `Unable to publish patch artifact from ${options.patchPath}`,
        cause,
      }),
  });
}
