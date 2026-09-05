import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "integration",
    environment: "node",
    include: ["integration/**/*.integration.test.*"],
    testTimeout: 90_000,
    hookTimeout: 90_000,
    fileParallelism: false,
    pool: "forks",
    sequence: {
      shuffle: false,
    },
  },
});
