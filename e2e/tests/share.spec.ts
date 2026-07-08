import { test, expect } from "@playwright/test";
import { stateChangingApiHeaders } from "./api";

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
      "/notes",
    );
  });

  test("authenticated URL -> waits for Save before capturing", async ({
    page,
  }) => {
    const sharedUrl = `https://example.com/e2e-share-${Date.now()}`;
    const fromUrlRequests: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/media/from-url"
      ) {
        fromUrlRequests.push(request.url());
      }
    });

    await page.goto(`/share?text=${encodeURIComponent(sharedUrl)}`);

    await expect(
      page.getByRole("heading", { name: "Save to Nexus" }),
    ).toBeVisible();
    await expect(
      page.getByRole("combobox", { name: "Library destinations" }),
    ).toBeVisible();
    expect(fromUrlRequests).toHaveLength(0);

    const fromUrlResponsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/media/from-url" &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Save" }).click();
    const fromUrlResponse = await fromUrlResponsePromise;
    expect(fromUrlResponse.ok()).toBeTruthy();
    await expect(
      page.getByRole("heading", { name: "Saved to Nexus" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Open in Nexus" }),
    ).toHaveAttribute("href", /^\/media\//);
  });

  test("authenticated URL -> creates a destination before Save and files media there", async ({
    page,
  }) => {
    const sharedUrl = `https://example.com/e2e-share-created-${Date.now()}`;
    const libraryName = `Share Destination ${Date.now()}-${Math.floor(
      Math.random() * 10_000,
    )}`;
    let createdLibraryId: string | null = null;

    try {
      await page.goto(`/share?text=${encodeURIComponent(sharedUrl)}`);
      await expect(
        page.getByRole("heading", { name: "Save to Nexus" }),
      ).toBeVisible();

      const picker = page.getByRole("combobox", {
        name: "Library destinations",
      });
      await picker.fill(libraryName);

      const createResponsePromise = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/libraries" &&
          response.request().method() === "POST",
      );
      await page
        .getByRole("option", { name: `Create “${libraryName}”` })
        .click();
      const createResponse = await createResponsePromise;
      expect(createResponse.status()).toBe(201);
      const createPayload = (await createResponse.json()) as {
        data: { id: string; name: string };
      };
      createdLibraryId = createPayload.data.id;
      expect(createPayload.data.name).toBe(libraryName);

      await expect(
        page.getByRole("button", { name: `Remove ${libraryName}` }),
      ).toBeVisible();

      const fromUrlResponsePromise = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/media/from-url" &&
          response.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Save" }).click();
      const fromUrlResponse = await fromUrlResponsePromise;
      expect(fromUrlResponse.ok()).toBeTruthy();
      const fromUrlPayload = (await fromUrlResponse.json()) as {
        data: { media_id: string };
      };

      await expect(
        page.getByRole("heading", { name: "Saved to Nexus" }),
      ).toBeVisible({ timeout: 15_000 });

      const entriesResponse = await page.request.get(
        `/api/libraries/${createdLibraryId}/entries`,
      );
      expect(entriesResponse.ok()).toBeTruthy();
      const entriesPayload = (await entriesResponse.json()) as {
        data: Array<{ media: { id: string } | null }>;
      };
      expect(
        entriesPayload.data.some(
          (entry) => entry.media?.id === fromUrlPayload.data.media_id,
        ),
      ).toBe(true);
    } finally {
      if (createdLibraryId) {
        await page.request.delete(`/api/libraries/${createdLibraryId}`, {
          headers: stateChangingApiHeaders(),
        });
      }
    }
  });

  test("authenticated URL -> cancel before Save captures nothing", async ({
    page,
  }) => {
    const sharedUrl = `https://example.com/e2e-share-cancel-${Date.now()}`;
    const fromUrlRequests: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/media/from-url"
      ) {
        fromUrlRequests.push(request.url());
      }
    });

    await page.goto(`/share?text=${encodeURIComponent(sharedUrl)}`);
    await expect(
      page.getByRole("heading", { name: "Save to Nexus" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Cancel" }).click();
    await expect(page).toHaveURL(/\/libraries$/);
    expect(fromUrlRequests).toHaveLength(0);
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

  test("unauthenticated empty browser share -> empty-state card", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    try {
      const page = await context.newPage();
      await page.goto("/share?text=");

      await expect(
        page.getByRole("heading", { name: "Nothing to share" }),
      ).toBeVisible();
      await expect(
        page.getByText("The shared text was empty, so there was nothing to save."),
      ).toBeVisible();
      await expect(page.getByRole("link", { name: "Done" })).toHaveAttribute(
        "href",
        "/libraries",
      );
    } finally {
      await context.close();
    }
  });

  test("unauthenticated Android shell share dismisses without completion callback", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
      userAgent: "NexusAndroidShell",
    });
    try {
      const page = await context.newPage();
      await page.goto(
        `/share?text=${encodeURIComponent("https://example.com")}`,
      );

      await expect(
        page.getByRole("heading", { name: "Sign in to save this" }),
      ).toBeVisible();
      await expect(page.getByRole("link", { name: "Done" })).toHaveAttribute(
        "href",
        "nexus-share://dismiss",
      );
    } finally {
      await context.close();
    }
  });
});
