import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page, test as base } from "@playwright/test";
import { startStaticSiteStack } from "./support/static-site-stack.ts";

type Stack = Awaited<ReturnType<typeof startStaticSiteStack>>;
const test = base.extend<{ stack: Stack }>({
  stack: async ({}, use) => {
    const stack = await startStaticSiteStack();
    try {
      await use(stack);
    } finally {
      await stack.close();
    }
  },
});

async function expectSite(page: Page, stack: Stack, version: "v1" | "v2") {
  await page.setExtraHTTPHeaders(stack.siteHeaders);
  const response = await page.goto(stack.runtimeUrl + "/");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle(`Static site ${version} | odenctl`);
  await expect(
    page.getByRole("heading", { name: `Static site ${version}`, exact: true }),
  ).toBeVisible();
  await expect(page.locator("main")).toHaveCSS(
    "border-top-color",
    version === "v1" ? "rgb(37, 99, 235)" : "rgb(5, 150, 105)",
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-script-version",
    version,
  );
  await expect(page.getByRole("img", { name: "Site mark" })).toBeVisible();
  expect(
    await page.getByRole("img", { name: "Site mark" }).evaluate((
      img: HTMLImageElement,
    ) => img.complete && img.naturalWidth > 0),
  ).toBe(true);
  await page.getByRole("button", { name: "Try JavaScript" }).click();
  await expect(page.getByRole("status")).toHaveText(
    `JavaScript ${version} is working`,
  );
}

test(
  "CLI releases real HTML, CSS, JavaScript and PNG through the cache gateway",
  async ({ stack, page }, testInfo) => {
    const before = await stack.metrics();
    const release = await stack.deploy("v1");
    expect(release.published).toBe(true);
    const first = await stack.get("/");
    expect(first.status()).toBe(200);
    expect(first.headers()["content-type"]).toContain("text/html");
    expect(first.headers()["x-oden-deployment"]).toBe(
      release.deploymentId,
    );
    expect(first.headers()["x-oden-cache"]).toBe("MISS");
    const second = await stack.get("/");
    expect(second.headers()["x-oden-cache"]).toBe("HIT");
    expect(await second.body()).toEqual(await first.body());
    expect(second.headers()["x-oden-request-id"]).not.toBe(
      first.headers()["x-oden-request-id"],
    );
    expect((await stack.metrics()).invocations.total - before.invocations.total)
      .toBe(1);

    for (
      const [path, type] of [["/assets/v1/site.css", "text/css"], [
        "/assets/v1/site.js",
        "text/javascript",
      ], ["/assets/mark.png", "image/png"]]
    ) {
      const miss = await stack.get(path);
      expect(miss.status()).toBe(200);
      expect(miss.headers()["content-type"]).toContain(type);
      expect(miss.headers()["x-oden-cache"]).toBe("MISS");
      const hit = await stack.get(path);
      expect(hit.headers()["x-oden-cache"]).toBe("HIT");
      expect(await hit.body()).toEqual(await miss.body());
    }
    const png = await stack.get("/assets/mark.png");
    expect(await png.body()).toEqual(
      await readFile(resolve("examples/static-site/site/assets/mark.png")),
    );
    const head = await stack.get("/", { method: "HEAD" });
    expect(head.headers()["x-oden-cache"]).toBe("HIT");
    expect(await head.body()).toHaveLength(0);
    expect(Number(head.headers()["content-length"])).toBe(
      (await first.body()).length,
    );

    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await expectSite(page, stack, "v1");
    await page.screenshot({
      path: testInfo.outputPath("static-site-v1.png"),
      fullPage: true,
    });
    await page.getByRole("link", { name: "Read the guide" }).click();
    await expect(page.getByRole("heading", { name: "Release guide v1" }))
      .toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/guide/");
    await page.reload();
    await expect(page.getByRole("heading", { name: "Release guide v1" }))
      .toBeVisible();
    expect(errors).toEqual([]);

    for (
      const path of [
        "/missing",
        "/.env",
        "/assets/nope.png",
        "/assets/%2e%2e%2fCargo.toml",
      ]
    ) {
      const response = await stack.get(path);
      expect(response.status(), path).toBe(404);
      expect(response.headers()["cache-control"]).toBe("no-store");
      expect((await stack.get(path)).headers()["x-oden-cache"]).not.toBe(
        "HIT",
      );
    }
    expect((await stack.get("/", { method: "POST", data: "ignored" })).status())
      .toBe(405);
    const redirect = await stack.get("/guide", { maxRedirects: 0 });
    expect(redirect.status()).toBe(308);
    expect(redirect.headers().location).toBe("/guide/");
    await testInfo.attach("release.json", {
      body: JSON.stringify(release, null, 2),
      contentType: "application/json",
    });
  },
);

test(
  "release v2 and rollback v1 invalidate HTML while keeping versioned assets consistent",
  async ({ stack, page }, testInfo) => {
    const v1 = await stack.deploy("v1");
    await expectSite(page, stack, "v1");
    const oldCss = await (await stack.get("/assets/v1/site.css")).body();
    // Warm the gateway independently of the browser's HTTP cache.
    await stack.get("/");
    expect((await stack.get("/")).headers()["x-oden-cache"]).toBe("HIT");
    const v2 = await stack.deploy("v2");
    expect(v2.deploymentId).not.toBe(v1.deploymentId);
    expect(v2.artifactId).not.toBe(v1.artifactId);
    const updated = await stack.get("/");
    expect(updated.headers()["x-oden-cache"]).toBe("MISS");
    expect(updated.headers()["x-oden-deployment"]).toBe(v2.deploymentId);
    expect(await updated.text()).toContain("Static site v2");
    await expectSite(page, stack, "v2");
    // An old HTML document can still finish loading after the release switch.
    expect(await (await stack.get("/assets/v1/site.css")).body()).toEqual(
      oldCss,
    );
    await page.screenshot({
      path: testInfo.outputPath("static-site-v2.png"),
      fullPage: true,
    });

    await stack.rollback(v1.deploymentId);
    const rolledBack = await stack.get("/");
    expect(rolledBack.headers()["x-oden-cache"]).toBe("MISS");
    expect(rolledBack.headers()["x-oden-deployment"]).toBe(
      v1.deploymentId,
    );
    expect(await rolledBack.text()).toContain("Static site v1");
    await expectSite(page, stack, "v1");
    const purge = await stack.purge();
    expect(purge.removed).toBeGreaterThan(0);
    expect((await stack.get("/")).headers()["x-oden-cache"]).toBe("MISS");
    await testInfo.attach("releases.json", {
      body: JSON.stringify({ v1, v2, rollback: v1.deploymentId }, null, 2),
      contentType: "application/json",
    });
  },
);

test("unauthorized writes and invalid components cannot replace a released site", async ({ stack }) => {
  const release = await stack.deploy("v1");
  const deniedPublish = await stack.controlRequest(
    "/snapshots/routes/publish",
    {},
    false,
  );
  expect(deniedPublish.status()).toBe(401);
  const deniedPurge = await stack.runtimeRequest(
    "/__runtime/response-cache/purge",
    { method: "POST", data: {} },
  );
  expect(deniedPurge.status()).toBe(401);
  const invalid = await stack.controlRequest("/artifacts/local", {
    projectId: stack.projectId,
    bytesBase64: Buffer.from("not wasm").toString("base64"),
  });
  expect(invalid.status()).toBe(400);
  expect((await stack.get("/")).headers()["x-oden-deployment"]).toBe(
    release.deploymentId,
  );
  expect(
    (await stack.get("/", { headers: { cookie: "session=private" } }))
      .headers()["x-oden-cache"],
  ).toBe("BYPASS");
});
