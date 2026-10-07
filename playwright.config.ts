import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./tests/integration",
  testMatch: "**/extension-browser.spec.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 30_000,
})
