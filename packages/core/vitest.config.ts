import path from "node:path";

import dotenv from "dotenv";
import { defineConfig } from "vitest/config";

// Core tests run from packages/core — load the XMTP bot env (richest shared set).
dotenv.config({ path: path.resolve(import.meta.dirname, "../../apps/basemate-tba/.env") });

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 10_000,
    isolate: true,
  },
});
