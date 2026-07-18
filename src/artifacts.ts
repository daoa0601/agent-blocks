import path from "node:path";

import { ContentAddressedFileStore } from "@agentic-orch/node-guardrails/cas";
import { Effect } from "effect";

import { JournalError } from "./errors.js";

export const PATCH_MEDIA_TYPE = "text/x-diff";

// captureCandidatePatch is bounded by the same 20 MiB Git output ceiling. Keep publication
// independently bounded so direct callers cannot bypass that workflow invariant.
const PATCH_ARTIFACT_MAX_BYTES = 20 * 1024 * 1024;

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
      const store = new ContentAddressedFileStore({
        root: options.artifactsDirectory,
        maxBytes: PATCH_ARTIFACT_MAX_BYTES,
        extension: ".patch",
        allowEmpty: true,
      });
      const stored = await store.stageFile(options.patchPath, PATCH_ARTIFACT_MAX_BYTES);

      // The path is a private journal compatibility field, not a CAS verification result. The CAS
      // already verified publication through its open handle; do not reopen the pathname here.
      const artifactPath = path.join(options.artifactsDirectory, `${stored.digest}.patch`);
      return {
        artifactId: stored.digest,
        digest: stored.digest,
        size: stored.size,
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
