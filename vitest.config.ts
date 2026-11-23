// Configures Vitest: Node tests by default (renderer tests opt into jsdom with a file docblock), no globals.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: ["tests/e2e/**"],
    environment: "node",
    setupFiles: ["tests/setup.ts"],
  },
});
