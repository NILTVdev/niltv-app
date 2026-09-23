import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Mobile unit tests run on vitest, the runner the backend already uses.
 * jest-expo is deliberately NOT used: it pulls react-test-renderer, which has
 * no React 19 release, and adding it breaks `npm install` for the whole
 * workspace. That rules out rendering components here — these tests cover the
 * pure logic that screens delegate to, which is where the bugs that typecheck
 * cannot catch actually live.
 */
export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: { "@": resolve(import.meta.dirname, "src") },
  },
});
