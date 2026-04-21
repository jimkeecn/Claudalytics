import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/hook-events.ts",
        "src/server.ts",
        "src/otel-emitter.ts",
        "src/**/*.test.ts",
      ],
      thresholds: {
        lines: 60,
        functions: 45,
        "src/field-mapping.ts": {
          lines: 90,
          branches: 85,
          functions: 95,
        },
      },
    },
  },
});
