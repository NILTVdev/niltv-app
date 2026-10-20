import { defineConfig } from "vitest/config";

// Unit tests cover the pure helpers in src/lib only (no DOM).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
