import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);
const failures = [];

function expectMetadata(condition, message) {
  if (!condition) failures.push(message);
}

expectMetadata(
  packageJson.private === true,
  "package must stay private because it is a local workspace building block",
);
expectMetadata(packageJson.type === "module", 'package type must be "module"');
expectMetadata(packageJson.main === "./dist/index.js", "main must target the built ESM entry");
expectMetadata(packageJson.types === "./dist/index.d.ts", "types must target the root declaration");
expectMetadata(
  packageJson.bin?.["agent-blocks"] === "./dist/cli.js",
  "agent-blocks bin must target the built CLI",
);
expectMetadata(
  packageJson.exports?.["."]?.types === packageJson.types,
  "root export must expose the root declaration through the types condition",
);
expectMetadata(
  packageJson.exports?.["."]?.import === packageJson.main,
  "root export must expose the built ESM entry through the import condition",
);
expectMetadata(
  packageJson.exports?.["./persistence"]?.types === "./dist/persistence.d.ts",
  "persistence export must expose its declaration through the types condition",
);
expectMetadata(
  packageJson.exports?.["./templates/scoped-worktree"]?.import ===
    "./dist/templates/scoped-worktree.js",
  "scoped-worktree template must expose its built ESM entry",
);
expectMetadata(
  packageJson.exports?.["./templates/scoped-worktree/control-plane"]?.import ===
    "./dist/templates/scoped-worktree-control-plane.js",
  "scoped-worktree control plane must expose its built ESM entry",
);
expectMetadata(
  packageJson.dependencies?.effect === undefined,
  "effect must not be a bundled runtime dependency",
);
expectMetadata(
  typeof packageJson.peerDependencies?.effect === "string",
  "effect must be a required peer because public APIs expose Effect types",
);
expectMetadata(
  packageJson.devDependencies?.effect === packageJson.peerDependencies?.effect,
  "the development Effect version must match the public peer contract",
);

if (failures.length > 0) {
  console.error("Agent Blocks local package contract check failed:");
  for (const failure of [...new Set(failures)].sort()) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Agent Blocks local package contract check passed.");
