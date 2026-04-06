import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@route-atlas/shared": path.resolve(__dirname, "../shared/index.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
