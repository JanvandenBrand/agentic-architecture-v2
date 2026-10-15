import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    // Bound contention between filesystem-heavy and cryptographic integration suites.
    maxWorkers: 2,
  },
});
