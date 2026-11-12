import { defineConfig } from "vitest/config";

// Unit tests: pure helpers, plus components rendered to a string (no DOM).
export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
