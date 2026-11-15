import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Integration tests run inside workerd (Miniflare) with a real local D1.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(process.cwd(), "migrations")),
          ENVIRONMENT: "development",
          APP_SECRET: "test-secret-0123456789-0123456789-abcdef",
          OWNER_EMAIL: "owner@test.dev",
          DEV_USER_EMAIL: "",
          TURNSTILE_SECRET_KEY: "",
        },
      },
    })),
  ],
  test: {
    include: ["test/worker/**/*.test.ts"],
    setupFiles: ["./test/worker/apply-migrations.ts"],
    testTimeout: 60_000,
  },
});
