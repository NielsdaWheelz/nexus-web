import { test, expect, type Page, type Request } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { stateChangingApiHeaders } from "./api";
import { deleteE2eResource, throwE2eCleanupFailures } from "./cleanup";
import {
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
  workspaceE2eDeviceId,
} from "./workspace";

async function createLibraryViaUi(
  page: Page,
  prefix: string
): Promise<{ id: string; name: string; role: string }> {
  const activePane = activeWorkspacePane(page);
  // The Default library row presents as "All" with secondary "Across your
  // libraries"; wait on the secondary so the list is committed before creating.
  await expect(
    activePane.getByText("Across your libraries", { exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  const nameInput = activePane.getByPlaceholder("New library name...");
  await expect(nameInput).toBeVisible();
  const libraryName = `${prefix} ${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
  const createButton = activePane.getByRole("button", { name: /^create$/i });
  await expect(async () => {
    await nameInput.fill(libraryName);
    await expect(nameInput).toHaveValue(libraryName);
    await expect(createButton).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  const createResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/libraries" &&
      response.request().method() === "POST" &&
      response.status() === 201
  );
  await createButton.click();
  const createResponse = await createResponsePromise;
  expect(createResponse.ok()).toBeTruthy();
  const payload = (await createResponse.json()) as {
    data: { id: string; name: string; role: string };
  };

  return { id: payload.data.id, name: payload.data.name, role: payload.data.role };
}

// Create media that lands in the viewer's Default library only. `library_ids: []`
// still records the physical Default-library entry (intrinsic membership) and no
// other membership, so the media qualifies as Unfiled in the All projection.
async function createDefaultLibraryMedia(
  page: Page,
  url: string,
): Promise<string> {
  const response = await page.request.post("/api/media/from-url", {
    data: { url, library_ids: [] },
    headers: {
      ...stateChangingApiHeaders(),
      "Idempotency-Key": randomUUID(),
    },
  });
  if (!response.ok()) {
    throw new Error(
      `Media setup failed: ${response.status()} ${await response.text()}`,
    );
  }
  const payload = (await response.json()) as { data: { media_id: string } };
  return payload.data.media_id;
}

// A durable web reader-state write records a canonical reader engagement with
// partial progression, so the media projects read_state = InProgress. Mirrors the
// conditional-envelope write in reader-progress-continuity.spec.ts.
async function markMediaInProgress(page: Page, mediaId: string): Promise<void> {
  const current = await page.request.get(`/api/media/${mediaId}/reader-state`);
  expect(current.ok()).toBeTruthy();
  const baseRevision = (
    (await current.json()) as { data: { revision: number } }
  ).data.revision;
  const response = await page.request.put(`/api/media/${mediaId}/reader-state`, {
    headers: stateChangingApiHeaders(),
    data: {
      base_revision: baseRevision,
      locator: {
        kind: "web",
        target: { fragment_id: randomUUID() },
        locations: {
          text_offset: 0,
          progression: 0,
          total_progression: 0.1,
          position: null,
        },
        text: { quote: null, quote_prefix: null, quote_suffix: null },
      },
    },
  });
  const body = await response.text();
  expect(
    response.ok(),
    `PUT /api/media/${mediaId}/reader-state failed: ${response.status()} ${body}`,
  ).toBeTruthy();
}

test.describe("libraries", () => {
  test("create library", async ({ page }, testInfo) => {
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-libraries"),
      "/libraries",
    );
    let createdId: string | null = null;
    try {
      const created = await createLibraryViaUi(page, "Test Library");
      createdId = created.id;
      expect(created.role).toBe("admin");

      const getResponse = await page.request.get(`/api/libraries/${created.id}`);
      expect(getResponse.ok()).toBeTruthy();
    } finally {
      if (createdId) {
        await page.request.delete(`/api/libraries/${createdId}`, {
          headers: stateChangingApiHeaders(),
        });
      }
    }
  });

  test("browse and select library", async ({ page }, testInfo) => {
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-libraries"),
      "/libraries",
    );
    const activePane = activeWorkspacePane(page);
    // Default presents as "All" / "Across your libraries" (libraryPresentation).
    const defaultLibraryItem = activePane
      .getByRole("listitem")
      .filter({ hasText: "Across your libraries" });
    await expect(
      defaultLibraryItem.getByText("All", { exact: true }),
    ).toBeVisible();
    const libraryLink = defaultLibraryItem.getByRole("link");
    await expect(libraryLink).toBeVisible();
    await libraryLink.click();
    await expect(page).toHaveURL(/libraries\/.+/);
  });

  test("sorts the Default library in place with one exact entries request", async ({
    page,
  }, testInfo) => {
    const librariesResponse = await page.request.get("/api/libraries");
    expect(librariesResponse.ok()).toBeTruthy();
    const libraries = (await librariesResponse.json()) as {
      data: Array<{ id: string; isDefault: boolean }>;
    };
    const defaultLibrary = libraries.data.find((library) => library.isDefault);
    if (!defaultLibrary) {
      throw new Error("Default library missing from E2E seed");
    }

    const libraryHref = `/libraries/${defaultLibrary.id}`;
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-libraries"),
      libraryHref,
    );
    await expect(page.locator("[data-pane-id]:visible")).toHaveCount(1);
    const sortSelect = activeWorkspacePane(page).getByRole("combobox", {
      name: "Sort by",
    });
    await expect(sortSelect).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState("networkidle");
    const libraryPane = activeWorkspacePane(page);
    // The entries region/list are named by libraryPresentation — "All" for the
    // Default library.
    const entriesRegion = libraryPane.getByRole("region", {
      name: "All",
    });
    const entriesList = entriesRegion.getByRole("list", {
      name: "All",
    });
    const initialFirstTitle = (
      await entriesList
        .getByRole("listitem")
        .first()
        .getByRole("link")
        .first()
        .textContent()
    )?.trim();
    if (!initialFirstTitle) {
      throw new Error("Default library first row had no title");
    }
    type EntriesPayload = {
      data: Array<{
        media?: { title?: string };
        podcast?: { title?: string };
      }>;
    };
    const firstTitle = (payload: EntriesPayload) =>
      (
        payload.data[0]?.media?.title ?? payload.data[0]?.podcast?.title
      )?.trim();
    const titleSorts = [
      {
        option: "title-asc",
        direction: "asc",
        label: "Title — A–Z",
      },
      {
        option: "title-desc",
        direction: "desc",
        label: "Title — Z–A",
      },
    ] as const;
    const preflightSorts = await Promise.all(
      titleSorts.map(async (sort) => {
        const path =
          `/api/libraries/${defaultLibrary.id}/entries` +
          `?sort=title&direction=${sort.direction}`;
        const response = await page.request.get(path);
        expect(response.ok()).toBeTruthy();
        return {
          ...sort,
          path,
          firstTitle: firstTitle((await response.json()) as EntriesPayload),
        };
      }),
    );
    const factualSort = preflightSorts.find(
      (sort) =>
        sort.firstTitle !== undefined &&
        sort.firstTitle.length > 0 &&
        sort.firstTitle !== initialFirstTitle,
    );
    if (!factualSort?.firstTitle) {
      throw new Error(
        "Neither title order changed the Default library first row",
      );
    }
    const entriesRegionElement = await entriesRegion.elementHandle();
    if (!entriesRegionElement) {
      throw new Error("Library entries region did not resolve to a DOM element");
    }
    const sortElement = await sortSelect.elementHandle();
    if (!sortElement) {
      throw new Error("Sort by control did not resolve to a DOM element");
    }

    const factualEntriesPath = factualSort.path;
    const postSettleLibraryGets: string[] = [];
    const postSettleLocatorResolvePosts: string[] = [];
    const captureRelevantRequest = (request: Request) => {
      const method = request.method();
      const url = new URL(request.url());
      if (
        method === "POST" &&
        url.pathname === "/api/resource-items/locators/resolve"
      ) {
        postSettleLocatorResolvePosts.push(url.pathname);
      }
      if (method !== "GET") {
        return;
      }
      if (
        url.pathname === `/api/libraries/${defaultLibrary.id}` ||
        url.pathname.startsWith(`/api/libraries/${defaultLibrary.id}/`)
      ) {
        postSettleLibraryGets.push(`${url.pathname}${url.search}`);
      }
    };
    page.on("request", captureRelevantRequest);

    await sortSelect.focus();
    await expect(sortSelect).toBeFocused();
    const factualEntriesResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "GET" &&
        `${url.pathname}${url.search}` === factualEntriesPath
      );
    });
    await sortSelect.selectOption(factualSort.option);

    await expect
      .poll(() => {
        const url = new URL(page.url());
        return `${url.pathname}${url.search}`;
      })
      .toBe(
        `${libraryHref}?sort=title&direction=${factualSort.direction}`,
      );
    const response = await factualEntriesResponse;
    expect(response.ok()).toBeTruthy();
    const returnedTitle = firstTitle(
      (await response.json()) as EntriesPayload,
    );
    if (!returnedTitle) {
      throw new Error(
        "Title-sorted Default library response had no titled entry",
      );
    }
    expect(returnedTitle).toBe(factualSort.firstTitle);
    expect(returnedTitle).not.toBe(initialFirstTitle);

    await expect(
      entriesList
        .getByRole("listitem")
        .first()
        .getByText(returnedTitle, { exact: true }),
    ).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(sortSelect).toHaveValue(factualSort.option);
    await expect(sortSelect).toBeFocused();
    await expect(
      libraryPane
        .getByRole("status")
        .filter({ hasText: `Updating to ${factualSort.label}` }),
    ).toHaveCount(0);
    expect(
      await sortSelect.evaluate(
        (current, initial) => current === initial,
        sortElement,
      ),
    ).toBe(true);
    expect(
      await entriesRegion.evaluate(
        (current, initial) => current === initial,
        entriesRegionElement,
      ),
    ).toBe(true);
    await expect(page.locator("[data-pane-id]:visible")).toHaveCount(1);
    page.off("request", captureRelevantRequest);
    expect(postSettleLibraryGets).toEqual([factualEntriesPath]);
    expect(postSettleLocatorResolvePosts).toEqual([]);
  });

  test("membership management guardrail", async ({ page }, testInfo) => {
    // Create a non-default library so the Rename UI is visible
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-libraries"),
      "/libraries",
    );
    let createdId: string | null = null;
    try {
      const created = await createLibraryViaUi(page, "Mgmt Test");
      createdId = created.id;

      const detailsResponse = await page.request.get(`/api/libraries/${created.id}`);
      expect(detailsResponse.ok()).toBeTruthy();
      const details = (await detailsResponse.json()) as { data: { role: string } };
      expect(details.data.role).toBe("admin");

      const renamed = `${created.name} Renamed`;
      const renameResponse = await page.request.patch(`/api/libraries/${created.id}`, {
        data: { name: renamed },
        headers: stateChangingApiHeaders(),
      });
      expect(renameResponse.ok()).toBeTruthy();
      const renamedPayload = (await renameResponse.json()) as { data: { name: string } };
      expect(renamedPayload.data.name).toBe(renamed);
    } finally {
      if (createdId) {
        await page.request.delete(`/api/libraries/${createdId}`, {
          headers: stateChangingApiHeaders(),
        });
      }
    }
  });

  test("All → Unfiled placement and In Progress consumption reconcile in place, and reload preserves the exact view", async ({
    page,
  }, testInfo) => {
    const librariesResponse = await page.request.get("/api/libraries");
    expect(librariesResponse.ok()).toBeTruthy();
    const libraries = (await librariesResponse.json()) as {
      data: Array<{ id: string; isDefault: boolean }>;
    };
    const defaultLibrary = libraries.data.find((library) => library.isDefault);
    if (!defaultLibrary) {
      throw new Error("Default library missing from E2E seed");
    }
    const defaultHref = `/libraries/${defaultLibrary.id}`;
    const entriesPath = `/api/libraries/${defaultLibrary.id}/entries`;
    const token = `${testInfo.workerIndex}-${testInfo.retry}-${Date.now()}`;
    const destinationLibraryName = `All Views Destination ${token}`;

    let destinationLibraryId: string | null = null;
    let unfiledMediaId: string | null = null;
    let inProgressMediaId: string | null = null;
    let productError: unknown = null;

    try {
      const createDestination = await page.request.post("/api/libraries", {
        data: { name: destinationLibraryName },
        headers: stateChangingApiHeaders(),
      });
      expect(createDestination.ok()).toBeTruthy();
      destinationLibraryId = (
        (await createDestination.json()) as { data: { id: string } }
      ).data.id;

      unfiledMediaId = await createDefaultLibraryMedia(
        page,
        `https://example.com/nexus-e2e/all-views/unfiled/${token}`,
      );
      inProgressMediaId = await createDefaultLibraryMedia(
        page,
        `https://example.com/nexus-e2e/all-views/in-progress/${token}`,
      );
      // Reader activity on the second media before opening the pane.
      await markMediaInProgress(page, inProgressMediaId);

      await gotoSinglePaneWorkspace(
        page,
        workspaceE2eDeviceId(testInfo, "e2e-all-views"),
        defaultHref,
      );
      const pane = activeWorkspacePane(page);
      const viewSelect = pane.getByRole("combobox", { name: "View" });
      await expect(viewSelect).toBeVisible({ timeout: 15_000 });
      // The Default library presents as "All".
      await expect(
        pane.getByRole("heading", { name: "All", level: 1 }),
      ).toBeVisible();

      // View → Unfiled: the URL gains ?projection=unfiled and the entries endpoint
      // is requested with that projection.
      const unfiledEntries = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === "GET" &&
          url.pathname === entriesPath &&
          url.searchParams.get("projection") === "unfiled"
        );
      });
      await viewSelect.selectOption("unfiled");
      expect((await unfiledEntries).ok()).toBeTruthy();
      await expect(viewSelect).toHaveValue("unfiled");
      await expect
        .poll(() => new URL(page.url()).searchParams.get("projection"))
        .toBe("unfiled");

      // The default (virtual) library keys rows by media id.
      const unfiledRow = pane.locator(
        `[data-collection-row-id="${unfiledMediaId}"]`,
      );
      await expect(unfiledRow).toBeVisible({ timeout: 15_000 });

      // File it into the destination library through the Libraries… overlay. The
      // in-process placement revision that write publishes drives exactly one
      // reconciliation of the All → Unfiled projection.
      await unfiledRow
        .getByRole("button", { name: /^More actions for / })
        .click();
      await page
        .getByRole("menuitem", { name: "Libraries…", exact: true })
        .click();
      const searchLibraries = page.getByRole("combobox", {
        name: "Search libraries",
      });
      await expect(searchLibraries).toBeVisible();
      const placementWrite = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname ===
            `/api/media/${unfiledMediaId}/libraries`,
      );
      await page.getByRole("option", { name: destinationLibraryName }).click();
      expect((await placementWrite).status()).toBe(204);
      await page.keyboard.press("Escape");
      await expect(searchLibraries).toBeHidden();

      // Reconciliation: the now-filed media leaves Unfiled without a reload.
      await expect(unfiledRow).toHaveCount(0, { timeout: 15_000 });

      // View → In Progress: the reader-engaged media appears.
      const inProgressEntries = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === "GET" &&
          url.pathname === entriesPath &&
          url.searchParams.get("projection") === "in-progress"
        );
      });
      await viewSelect.selectOption("in-progress");
      expect((await inProgressEntries).ok()).toBeTruthy();
      await expect(viewSelect).toHaveValue("in-progress");
      await expect
        .poll(() => new URL(page.url()).searchParams.get("projection"))
        .toBe("in-progress");

      const inProgressRow = pane.locator(
        `[data-collection-row-id="${inProgressMediaId}"]`,
      );
      await expect(inProgressRow).toBeVisible({ timeout: 15_000 });

      // Mark finished from the row action → it leaves In Progress immediately.
      await inProgressRow
        .getByRole("button", { name: /^More actions for / })
        .click();
      await page
        .getByRole("menuitem", { name: "Mark as finished", exact: true })
        .click();
      await expect(inProgressRow).toHaveCount(0, { timeout: 15_000 });

      // Undo the completion → the media returns to In Progress through consumption
      // reconciliation (absent-row entry).
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await expect(inProgressRow).toBeVisible({ timeout: 15_000 });

      // A factual sort composes with the projection; the exact view is URL-owned.
      const sortSelect = pane.getByRole("combobox", { name: "Sort by" });
      await sortSelect.selectOption("title-asc");
      await expect
        .poll(() => {
          const url = new URL(page.url());
          return [
            url.searchParams.get("projection"),
            url.searchParams.get("sort"),
            url.searchParams.get("direction"),
          ].join("|");
        })
        .toBe("in-progress|title|asc");

      // Reload the exact URL: projection and sort are restored from the pane URL.
      await page.reload({ waitUntil: "domcontentloaded" });
      const reloadedPane = activeWorkspacePane(page);
      await expect(reloadedPane).toBeVisible({ timeout: 15_000 });
      await expect(
        reloadedPane.getByRole("combobox", { name: "View" }),
      ).toHaveValue("in-progress", { timeout: 15_000 });
      await expect(
        reloadedPane.getByRole("combobox", { name: "Sort by" }),
      ).toHaveValue("title-asc");
      const reloadedUrl = new URL(page.url());
      expect(reloadedUrl.pathname).toBe(defaultHref);
      expect(reloadedUrl.searchParams.get("projection")).toBe("in-progress");
      expect(reloadedUrl.searchParams.get("sort")).toBe("title");
      expect(reloadedUrl.searchParams.get("direction")).toBe("asc");
    } catch (error) {
      productError = error;
      throw error;
    } finally {
      const cleanupErrors: unknown[] = [];
      const cleanupTargets = [
        unfiledMediaId
          ? { path: `/api/media/${unfiledMediaId}`, label: `unfiled media ${unfiledMediaId}` }
          : null,
        inProgressMediaId
          ? {
              path: `/api/media/${inProgressMediaId}`,
              label: `in-progress media ${inProgressMediaId}`,
            }
          : null,
        destinationLibraryId
          ? {
              path: `/api/libraries/${destinationLibraryId}`,
              label: `destination library ${destinationLibraryId}`,
            }
          : null,
      ];
      for (const target of cleanupTargets) {
        if (target === null) continue;
        try {
          await deleteE2eResource(page.request, target.path, target.label);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      throwE2eCleanupFailures("All views journey", productError, cleanupErrors);
    }
  });
});
