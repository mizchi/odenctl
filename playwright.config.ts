import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "static-site.spec.ts",
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  outputDir: "target/playwright-results",
  reporter: [["list"], ["html", {
    outputFolder: "target/playwright-report",
    open: "never",
  }]],
  use: {
    browserName: "chromium",
    viewport: { width: 1100, height: 760 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
