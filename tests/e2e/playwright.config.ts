import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

const root = new URL("../../", import.meta.url);

export default defineConfig({
  testDir: ".",
  testMatch: "static-site.spec.ts",
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  outputDir: fileURLToPath(new URL("target/playwright-results", root)),
  reporter: [["list"], ["html", {
    outputFolder: fileURLToPath(new URL("target/playwright-report", root)),
    open: "never",
  }]],
  use: {
    browserName: "chromium",
    viewport: { width: 1100, height: 760 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
