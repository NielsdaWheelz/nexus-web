import { test, expect } from "@playwright/test";

/**
 * The Android share-sheet capture surface (`/share`). `make test-e2e` runs this
 * against the real stack (Next.js, FastAPI, Postgres): the authenticated cases
 * use the bootstrapped `storageState` session and capture for real; the
 * unauthenticated case drives a cookie-less context. Only deterministic,
 * fully internal outcomes are asserted — no background extraction, no external
 * page content.
 */
test.describe("share to Nexus", () => {
  test("authenticated plain text -> capture confirms it on today's daily note", async ({
    page,
  }) => {
    const sharedText = `E2E shared note ${Date.now()}`;
    await page.goto(`/share?text=${encodeURIComponent(sharedText)}`);

    await expect(
      page.getByRole("heading", { name: "Saved to Nexus" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Added to today")).toBeVisible();
    await expect(page.getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      "/daily",
    );
  });

  test("authenticated URL -> capture confirms the saved media", async ({
    page,
  }) => {
    // A fresh URL per run keeps the capture a deterministic first-time "Saved"
    // rather than a re-run "Already in your library", and the test independent.
    const sharedUrl = `https://example.com/e2e-share-${Date.now()}`;
    await page.goto(`/share?text=${encodeURIComponent(sharedUrl)}`);

    await expect(
      page.getByRole("heading", { name: "Saved to Nexus" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Open in Nexus" }),
    ).toHaveAttribute("href", /^\/media\//);
  });

  test("unauthenticated -> sign-in-required card captures nothing", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    try {
      const page = await context.newPage();
      await page.goto(
        `/share?text=${encodeURIComponent("https://example.com")}`,
      );

      await expect(
        page.getByRole("heading", { name: "Sign in to save this" }),
      ).toBeVisible();
      await expect(
        page.getByText(
          "Open Nexus, sign in, then share again to save this to your library.",
        ),
      ).toBeVisible();
      await expect(page.getByRole("link", { name: "Done" })).toBeVisible();

      // Nothing was captured: no "Saved to Nexus" confirmation appears.
      await expect(
        page.getByRole("heading", { name: "Saved to Nexus" }),
      ).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
