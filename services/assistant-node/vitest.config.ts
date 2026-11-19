import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // index.ts only starts the server; everything it calls is tested.
      exclude: ["src/**/*.test.ts", "src/**/*.testutil.ts", "src/index.ts"],
      reporter: ["text-summary", "lcov"],
      // A floor, not a goal: it stops coverage from quietly falling. Raise it when the numbers rise.
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 75 },
    },
  },
});
