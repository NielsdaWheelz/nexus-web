import { test, expect, type Page, type Request } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { openAddContentPanel } from "./add-content";
import { stateChangingApiHeaders } from "./api";
import { deleteE2eResource, throwE2eCleanupFailures } from "./cleanup";
import { selectFreshVisibleTextSnippet } from "./selection";
import {
  activePaneSelector,
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
  workspaceE2eDeviceId,
} from "./workspace";

interface SeededNonPdfMedia {
  media_id: string;
  fragment_id: string;
  quote_highlight_id: string;
  focus_highlight_id: string;
  quote_exact: string;
  focus_exact: string;
}

function readSeededNonPdfMedia(): SeededNonPdfMedia {
  const seedPath = path.join(__dirname, "..", ".seed", "non-pdf-media.json");
  return JSON.parse(readFileSync(seedPath, "utf-8"));
}

function workspacePaneButton(page: Page, name: RegExp | string) {
  return page
    .getByRole("toolbar", { name: "Workspace panes" })
    .getByRole("button", { name });
}

async function isMediaInLibrary(
  page: Page,
  mediaId: string,
  libraryId: string,
): Promise<boolean> {
  const response = await page.request.get(`/api/media/${mediaId}/libraries`);
  if (!response.ok()) {
    throw new Error(
      `membership read failed: ${response.status()} ${await response.text()}`,
    );
  }
  const payload: unknown = await response.json();
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("data" in payload) ||
    !Array.isArray(payload.data)
  ) {
    throw new Error("Membership read returned an invalid data envelope.");
  }
  const membership = payload.data.find(
    (entry: unknown) =>
      typeof entry === "object" &&
      entry !== null &&
      "id" in entry &&
      entry.id === libraryId,
  );
  if (
    typeof membership !== "object" ||
    membership === null ||
    !("is_in_library" in membership) ||
    typeof membership.is_in_library !== "boolean"
  ) {
    throw new Error(`Membership projection omitted library ${libraryId}.`);
  }
  return membership.is_in_library;
}

test.describe("web articles", () => {
  test("add article from URL", async ({ page }, testInfo) => {
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-web-articles"),
      "/libraries",
    );
    const addContentPanel = await openAddContentPanel(page);
    const urlInput = addContentPanel.getByRole("textbox", { name: "Links" });
    await expect(urlInput).toBeVisible();
    await urlInput.fill("https://example.com");
    await addContentPanel.getByRole("button", { name: "Review links" }).click();
    await expect(addContentPanel.getByText("Ready to add")).toBeVisible();

    const acceptance = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/media/from-url",
    );
    await addContentPanel.getByRole("button", { name: "Add 1 item" }).click();
    expect((await acceptance).ok()).toBeTruthy();

    // Acceptance retains the workbench. Opening the media is a separate user action.
    await expect(addContentPanel).toBeVisible();
    await expect(
      addContentPanel.getByText(
        /^(Saved|Already in Nexus) · (processing|ready|processing failed)$/,
      ),
    ).toBeVisible({ timeout: 15_000 });
    await addContentPanel.getByRole("button", { name: "Open" }).click();
    await expect(addContentPanel).toBeHidden();
    await expect(
      workspacePaneButton(page, /^https:\/\/example\.com\b/),
    ).toBeVisible({
      timeout: 15_000,
    });
    const activePane = activeWorkspacePane(page);
    await expect(
      activePane.getByRole("heading", { name: "https://example.com" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(activePane.getByText(/processing|pending/i)).toBeVisible({
      timeout: 15_000,
    });
  });

  test("accepted rows support convergent row and bulk filing", async ({
    page,
  }, testInfo) => {
    test.slow();
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-web-article-filing"),
      "/libraries",
    );

    const token = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const libraryName = `Filing E2E ${token}`;
    const firstUrl = `https://example.com/nexus-e2e/${token}/one`;
    const secondUrl = `https://example.com/nexus-e2e/${token}/two`;
    const rejectedUrl = `http://10.0.0.1/nexus-e2e/${token}`;
    const acceptedUrls = [firstUrl, secondUrl];
    const submittedUrls = [...acceptedUrls, rejectedUrl];
    const mediaByUrl = new Map<string, string>();
    let libraryId: string | null = null;
    let productError: unknown = null;

    try {
      const createLibrary = await page.request.post("/api/libraries", {
        data: { name: libraryName },
        headers: stateChangingApiHeaders(),
      });
      if (!createLibrary.ok()) {
        throw new Error(
          `library setup failed: ${createLibrary.status()} ${await createLibrary.text()}`,
        );
      }
      const createdLibrary: unknown = await createLibrary.json();
      if (
        typeof createdLibrary !== "object" ||
        createdLibrary === null ||
        !("data" in createdLibrary) ||
        typeof createdLibrary.data !== "object" ||
        createdLibrary.data === null ||
        !("id" in createdLibrary.data) ||
        typeof createdLibrary.data.id !== "string"
      ) {
        throw new Error("Library setup returned an invalid response.");
      }
      const filingLibraryId = createdLibrary.data.id;
      libraryId = filingLibraryId;

      const add = await openAddContentPanel(page);
      await add
        .getByRole("textbox", { name: "Links" })
        .fill(submittedUrls.join("\n"));
      await add.getByRole("button", { name: "Review links" }).click();
      await expect(add.getByText("Ready to add")).toHaveCount(3);

      const acceptanceTasks = acceptedUrls.map(async (url) => {
        const response = await page.waitForResponse((candidate) => {
          if (
            candidate.request().method() !== "POST" ||
            new URL(candidate.url()).pathname !== "/api/media/from-url"
          ) {
            return false;
          }
          const requestBody: unknown = candidate.request().postDataJSON();
          return (
            typeof requestBody === "object" &&
            requestBody !== null &&
            "url" in requestBody &&
            requestBody.url === url
          );
        });
        const responseBody: unknown = await response.json();
        const mediaId =
          typeof responseBody === "object" &&
          responseBody !== null &&
          "data" in responseBody &&
          typeof responseBody.data === "object" &&
          responseBody.data !== null &&
          "media_id" in responseBody.data &&
          typeof responseBody.data.media_id === "string"
            ? responseBody.data.media_id
            : null;
        if (mediaId) mediaByUrl.set(url, mediaId);
        if (!response.ok()) {
          throw new Error(
            `URL acceptance failed: ${response.status()} ${JSON.stringify(responseBody)}`,
          );
        }
        if (mediaId === null) {
          throw new Error("URL acceptance returned an invalid response.");
        }
      });
      const rejectionTask = page.waitForResponse((response) => {
        if (
          response.request().method() !== "POST" ||
          new URL(response.url()).pathname !== "/api/media/from-url"
        ) {
          return false;
        }
        const requestBody: unknown = response.request().postDataJSON();
        return (
          typeof requestBody === "object" &&
          requestBody !== null &&
          "url" in requestBody &&
          requestBody.url === rejectedUrl
        );
      });
      await add.getByRole("button", { name: "Add 3 items" }).click();
      const [acceptanceResults, rejectionResponse] = await Promise.all([
        Promise.allSettled(acceptanceTasks),
        rejectionTask,
      ]);
      const acceptanceFailure = acceptanceResults.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (acceptanceFailure) {
        throw acceptanceFailure.reason;
      }
      expect(rejectionResponse.status()).toBe(400);
      const rejectionBody: unknown = await rejectionResponse.json();
      expect(rejectionBody).toMatchObject({
        error: {
          code: "E_INVALID_REQUEST",
          message: "URL hostname '10.0.0.1' is not allowed",
        },
      });
      await expect(
        add.getByText(
          /^(Saved|Already in Nexus) · (processing|ready|processing failed)$/,
        ),
      ).toHaveCount(2, { timeout: 15_000 });
      for (const url of acceptedUrls) {
        await expect(
          add
            .getByRole("article")
            .filter({ hasText: url })
            .getByText(
              /^(Saved|Already in Nexus) · (processing|ready|processing failed)$/,
            ),
        ).toBeVisible();
      }
      const rejectedRow = add
        .getByRole("article")
        .filter({ hasText: rejectedUrl });
      await expect(
        rejectedRow.getByText("Not added", { exact: true }),
      ).toBeVisible();
      await expect(rejectedRow).toContainText("This item could not be added.");
      await expect(
        rejectedRow.getByRole("button", { name: "Restage" }),
      ).toBeEnabled();
      expect(mediaByUrl.size).toBe(2);
      expect(new Set(mediaByUrl.values()).size).toBe(2);
      await expect(add).toBeVisible();
      await expect(add.getByText("2 items added")).toBeVisible();

      const firstMediaId = mediaByUrl.get(firstUrl);
      const secondMediaId = mediaByUrl.get(secondUrl);
      if (!firstMediaId || !secondMediaId) {
        throw new Error(
          "Accepted media identities did not match the submitted URLs.",
        );
      }

      const firstRow = add.getByRole("article").filter({ hasText: firstUrl });
      await firstRow
        .getByRole("button", { name: "Libraries", exact: true })
        .click();
      const rowLibraries = page.getByRole("dialog", {
        name: `Libraries for ${firstUrl}`,
      });
      const rowLibraryButton = rowLibraries
        .getByRole("button")
        .filter({ hasText: libraryName });
      await expect(rowLibraryButton).toBeVisible();
      const rowAddResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname ===
            `/api/media/${firstMediaId}/libraries`,
      );
      await rowLibraryButton.click();
      const completedRowAdd = await rowAddResponse;
      expect(completedRowAdd.ok()).toBeTruthy();
      expect(completedRowAdd.request().postDataJSON()).toEqual({
        library_ids: [filingLibraryId],
      });
      await expect(rowLibraryButton).toContainText("Remove from this library");
      await expect
        .poll(() => isMediaInLibrary(page, firstMediaId, filingLibraryId))
        .toBe(true);
      await expect
        .poll(() => isMediaInLibrary(page, secondMediaId, filingLibraryId))
        .toBe(false);
      await rowLibraries.getByRole("button", { name: "Close dialog" }).click();

      const bulkAddRequests: Array<{ mediaId: string; body: unknown }> = [];
      const captureBulkAdd = (request: Request) => {
        if (request.method() !== "POST") return;
        const match = new URL(request.url()).pathname.match(
          /^\/api\/media\/([^/]+)\/libraries$/,
        );
        const mediaId = match?.[1];
        if (mediaId) {
          bulkAddRequests.push({ mediaId, body: request.postDataJSON() });
        }
      };
      await add.getByRole("button", { name: "Add all to…" }).click();
      const bulkAdd = page.getByRole("dialog", {
        name: "Add all to libraries",
      });
      const bulkAddButton = bulkAdd
        .getByRole("button")
        .filter({ hasText: libraryName });
      await expect(bulkAddButton).toContainText("Add to library");
      const completedBulkAdd = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname ===
            `/api/media/${secondMediaId}/libraries`,
      );
      page.on("request", captureBulkAdd);
      try {
        await bulkAddButton.click();
        expect((await completedBulkAdd).ok()).toBeTruthy();
        await expect(bulkAdd.getByText("No eligible libraries.")).toBeVisible();
      } finally {
        page.off("request", captureBulkAdd);
      }
      expect(bulkAddRequests).toEqual([
        { mediaId: secondMediaId, body: { library_ids: [filingLibraryId] } },
      ]);
      await expect
        .poll(() => isMediaInLibrary(page, firstMediaId, filingLibraryId))
        .toBe(true);
      await expect
        .poll(() => isMediaInLibrary(page, secondMediaId, filingLibraryId))
        .toBe(true);
      await bulkAdd.getByRole("button", { name: "Close dialog" }).click();

      const bulkRemovePaths: string[] = [];
      const captureBulkRemove = (request: Request) => {
        if (request.method() !== "DELETE") return;
        const pathname = new URL(request.url()).pathname;
        if (pathname.endsWith(`/libraries/${filingLibraryId}`)) {
          bulkRemovePaths.push(pathname);
        }
      };
      await add.getByRole("button", { name: "Remove all from…" }).click();
      const bulkRemove = page.getByRole("dialog", {
        name: "Remove all from libraries",
      });
      const bulkRemoveButton = bulkRemove
        .getByRole("button")
        .filter({ hasText: libraryName });
      await expect(bulkRemoveButton).toContainText("Remove from this library");
      const removalResponses = [firstMediaId, secondMediaId].map((mediaId) =>
        page.waitForResponse(
          (response) =>
            response.request().method() === "DELETE" &&
            new URL(response.url()).pathname ===
              `/api/media/${mediaId}/libraries/${filingLibraryId}`,
        ),
      );
      page.on("request", captureBulkRemove);
      try {
        await bulkRemoveButton.click();
        for (const response of await Promise.all(removalResponses)) {
          expect(response.status()).toBe(204);
        }
        await expect(
          bulkRemove.getByText("No eligible libraries."),
        ).toBeVisible();
      } finally {
        page.off("request", captureBulkRemove);
      }
      expect(bulkRemovePaths.sort()).toEqual(
        [
          `/api/media/${firstMediaId}/libraries/${filingLibraryId}`,
          `/api/media/${secondMediaId}/libraries/${filingLibraryId}`,
        ].sort(),
      );
      await expect
        .poll(() => isMediaInLibrary(page, firstMediaId, filingLibraryId))
        .toBe(false);
      await expect
        .poll(() => isMediaInLibrary(page, secondMediaId, filingLibraryId))
        .toBe(false);
      await expect(add.getByText("2 items added")).toBeVisible();
      await expect(
        rejectedRow.getByText("Not added", { exact: true }),
      ).toBeVisible();
    } catch (error) {
      productError = error;
      throw error;
    } finally {
      const cleanupErrors: unknown[] = [];
      for (const mediaId of new Set(mediaByUrl.values())) {
        try {
          await deleteE2eResource(
            page.request,
            `/api/media/${mediaId}`,
            `Filing E2E media ${mediaId}`,
          );
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (libraryId) {
        try {
          await deleteE2eResource(
            page.request,
            `/api/libraries/${libraryId}`,
            `Filing E2E library ${libraryId}`,
          );
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      throwE2eCleanupFailures(
        "Add content filing",
        productError,
        cleanupErrors,
      );
    }
  });

  test("open and view seeded web article", async ({ page }, testInfo) => {
    const seed = readSeededNonPdfMedia();
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-web-articles"),
      `/media/${seed.media_id}`,
    );
    await expect(
      activeWorkspacePane(page).getByText(seed.quote_exact),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("web article highlights are present", async ({ page }, testInfo) => {
    const seed = readSeededNonPdfMedia();
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-web-articles"),
      `/media/${seed.media_id}`,
    );
    // Highlights render as spans with data-active-highlight-ids attribute
    await expect(
      activeWorkspacePane(page).locator("[data-active-highlight-ids]").first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("creates highlight from paragraph text selection without OUTSIDE_CONTENT warning", async ({
    page,
  }, testInfo) => {
    test.slow();

    const seed = readSeededNonPdfMedia();
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-web-articles"),
      `/media/${seed.media_id}`,
    );
    const activePane = activeWorkspacePane(page);

    const beforeCount = await activePane
      .locator("[data-active-highlight-ids]")
      .count();

    const existingResponse = await page.request.get(
      `/api/fragments/${seed.fragment_id}/highlights`,
    );
    expect(existingResponse.ok()).toBeTruthy();
    const existingPayload = (await existingResponse.json()) as {
      data: { highlights: Array<{ exact: string }> };
    };
    const existingCount = existingPayload.data.highlights.length;
    const existingExacts = new Set(
      existingPayload.data.highlights.map((highlight) => highlight.exact),
    );

    const paragraphs = activePane.locator('[class*="fragments"] p');
    await expect(paragraphs.first()).toBeVisible({ timeout: 10_000 });

    const selectedText = await selectFreshVisibleTextSnippet(
      page,
      activePaneSelector('[class*="fragments"] p'),
      Array.from(existingExacts),
      { method: "range" },
    );
    expect(selectedText.trim().length).toBeGreaterThanOrEqual(2);

    await expect(
      page.getByRole("group", { name: /selection actions/i }),
    ).toBeVisible({ timeout: 5_000 });

    const highlightActions = page.getByRole("group", {
      name: /selection actions/i,
    });
    await highlightActions
      .getByRole("button", { name: "Highlight color" })
      .click();
    const greenButton = page.getByRole("button", { name: /^Green$/ }).first();
    await expect(greenButton).toBeEnabled();
    const createHighlightResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response
          .url()
          .includes(`/api/fragments/${seed.fragment_id}/highlights`),
    );
    await greenButton.click();
    const createdHighlightResponse = await createHighlightResponse;
    expect(createdHighlightResponse.ok()).toBeTruthy();
    const createdHighlight = (await createdHighlightResponse.json()) as {
      data: { exact: string };
    };
    expect(createdHighlight.data.exact.replace(/\s+/g, " ").trim()).toBe(
      selectedText.replace(/\s+/g, " ").trim(),
    );

    await expect
      .poll(
        async () => {
          const response = await page.request.get(
            `/api/fragments/${seed.fragment_id}/highlights`,
          );
          expect(response.ok()).toBeTruthy();
          const payload = (await response.json()) as {
            data: { highlights: Array<{ exact: string }> };
          };
          return payload.data.highlights.length > existingCount;
        },
        { timeout: 20_000 },
      )
      .toBe(true);

    await expect(
      page.getByText("Selection start is outside rendered content."),
    ).toHaveCount(0);

    await expect
      .poll(
        async () => activePane.locator("[data-active-highlight-ids]").count(),
        {
          timeout: 20_000,
        },
      )
      .toBeGreaterThan(beforeCount);
  });
});
