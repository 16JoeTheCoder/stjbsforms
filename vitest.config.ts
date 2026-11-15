import { defineConfig } from "vitest/config";

// Unit tests (Node): shared validation, search, shuffle, PDF engine.
export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
  },
});
