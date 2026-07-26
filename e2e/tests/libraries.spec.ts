import { test, expect, type Page, type Request } from "@playwright/test";
import { stateChangingApiHeaders } from "./api";
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
  await expect(
    activePane.getByText("Default library", { exact: true }),
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
    const defaultLibraryLabel = activePane.getByText("Default library", {
      exact: true,
    });
    await expect(defaultLibraryLabel).toBeVisible();
    const libraryLink = activePane
      .getByRole("listitem")
      .filter({ hasText: "Default library" })
      .getByRole("link");
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
    const entriesRegion = libraryPane.getByRole("region", {
      name: "Library entries",
    });
    const entriesList = entriesRegion.getByRole("list", {
      name: "Library entries",
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
});
