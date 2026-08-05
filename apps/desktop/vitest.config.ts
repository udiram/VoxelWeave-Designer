import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    environmentOptions: { jsdom: { url: "http://localhost" } },
    setupFiles: "./src/tests/setup.ts",
    globals: true,
    css: true,
    include: ["src/tests/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["e2e/**"],
  },
});
