import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      thresholds: {
        branches: 55,
        functions: 70,
        lines: 70,
        statements: 70,
      },
    },
    include: ["tests/**/*.test.ts"],
  },
});
