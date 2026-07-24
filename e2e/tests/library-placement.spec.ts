import { expect, test, type Request, type Response } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { stateChangingApiHeaders } from "./api";
import { deleteE2eResource, throwE2eCleanupFailures } from "./cleanup";
import {
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
  workspaceE2eDeviceId,
} from "./workspace";

async function expectLibraryState(
  response: Response,
  libraryId: string,
  expected: boolean,
) {
  if (!response.ok()) {
    throw new Error(
      `Library placement read failed: ${response.status()} ${await response.text()}`,
    );
  }
  const payload = (await response.json()) as {
    data: Array<{ id: string; is_in_library: boolean }>;
  };
  expect(
    payload.data.find((library) => library.id === libraryId)?.is_in_library,
  ).toBe(expected);
}

test("media Libraries… placement adds, removes, and returns focus without sharing", async ({
  page,
}, testInfo) => {
  const token = `${testInfo.workerIndex}-${testInfo.retry}-${Date.now()}`;
  const sourceLibraryName = `Placement Source ${token}`;
  const destinationLibraryName = `Placement E2E ${token}`;
  const mediaUrl = `https://example.com/nexus-e2e/library-placement/${token}`;
  let sourceLibraryId: string | null = null;
  let destinationLibraryId: string | null = null;
  let mediaId: string | null = null;
  let productError: unknown = null;
  const shareRequests: string[] = [];
  const captureShareRequest = (request: Request) => {
    const pathname = new URL(request.url()).pathname;
    if (/^\/api\/resource-items\/[^/]+\/shares$/.test(pathname)) {
      shareRequests.push(`${request.method()} ${pathname}`);
    }
  };

  try {
    const createSourceLibrary = await page.request.post("/api/libraries", {
      data: { name: sourceLibraryName },
      headers: stateChangingApiHeaders(),
    });
    if (!createSourceLibrary.ok()) {
      throw new Error(
        `Source library setup failed: ${createSourceLibrary.status()} ${await createSourceLibrary.text()}`,
      );
    }
    const sourceLibraryPayload = (await createSourceLibrary.json()) as {
      data: { id: string };
    };
    sourceLibraryId = sourceLibraryPayload.data.id;

    const createDestinationLibrary = await page.request.post("/api/libraries", {
      data: { name: destinationLibraryName },
      headers: stateChangingApiHeaders(),
    });
    if (!createDestinationLibrary.ok()) {
      throw new Error(
        `Destination library setup failed: ${createDestinationLibrary.status()} ${await createDestinationLibrary.text()}`,
      );
    }
    const destinationLibraryPayload =
      (await createDestinationLibrary.json()) as {
        data: { id: string };
      };
    destinationLibraryId = destinationLibraryPayload.data.id;

    const createMedia = await page.request.post("/api/media/from-url", {
      data: { url: mediaUrl, library_ids: [sourceLibraryId] },
      headers: {
        ...stateChangingApiHeaders(),
        "Idempotency-Key": randomUUID(),
      },
    });
    if (!createMedia.ok()) {
      throw new Error(
        `Media setup failed: ${createMedia.status()} ${await createMedia.text()}`,
      );
    }
    const mediaPayload = (await createMedia.json()) as {
      data: { media_id: string };
    };
    mediaId = mediaPayload.data.media_id;

    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-library-placement"),
      `/libraries/${sourceLibraryId}`,
    );
    const pane = activeWorkspacePane(page);
    const mediaRow = pane
      .getByRole("list", { name: "Library entries" })
      .locator("[data-collection-row-id]");
    await expect(mediaRow).toHaveCount(1, { timeout: 15_000 });
    await expect(mediaRow).toBeVisible({ timeout: 15_000 });
    const optionsTrigger = mediaRow.getByRole("button", {
      name: /^More actions for /,
    });
    await expect(optionsTrigger).toBeVisible({ timeout: 15_000 });

    page.on("request", captureShareRequest);
    await optionsTrigger.click();
    const openPlacement = page.getByRole("menuitem", {
      name: "Libraries…",
      exact: true,
    });
    await expect(openPlacement).toBeVisible();
    const initialList = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === `/api/media/${mediaId}/libraries`,
    );
    await openPlacement.click();

    const dialog = page.getByRole("dialog", { name: "Libraries" });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("searchbox", { name: "Search libraries" }),
    ).toBeFocused();
    const initialResponse = await initialList;
    await expectLibraryState(initialResponse, destinationLibraryId, false);

    const libraryToggle = dialog.getByRole("button", {
      name: destinationLibraryName,
      exact: true,
    });
    await expect(libraryToggle).toHaveAttribute("aria-pressed", "false");

    const addResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === `/api/media/${mediaId}/libraries`,
    );
    const addedList = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === `/api/media/${mediaId}/libraries`,
    );
    await libraryToggle.click();
    expect((await addResponse).status()).toBe(204);
    await expectLibraryState(await addedList, destinationLibraryId, true);
    await expect(libraryToggle).toHaveAttribute("aria-pressed", "true");

    const removeResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        new URL(response.url()).pathname ===
          `/api/media/${mediaId}/libraries/${destinationLibraryId}`,
    );
    const removedList = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === `/api/media/${mediaId}/libraries`,
    );
    await libraryToggle.click();
    expect((await removeResponse).status()).toBe(204);
    await expectLibraryState(await removedList, destinationLibraryId, false);
    await expect(libraryToggle).toHaveAttribute("aria-pressed", "false");

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(optionsTrigger).toBeFocused();
    expect(shareRequests).toEqual([]);
  } catch (error) {
    productError = error;
    throw error;
  } finally {
    page.off("request", captureShareRequest);
    const cleanupErrors: unknown[] = [];
    if (mediaId) {
      try {
        await deleteE2eResource(
          page.request,
          `/api/media/${mediaId}`,
          `Library placement media ${mediaId}`,
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (sourceLibraryId) {
      try {
        await deleteE2eResource(
          page.request,
          `/api/libraries/${sourceLibraryId}`,
          `Library placement source library ${sourceLibraryId}`,
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (destinationLibraryId) {
      try {
        await deleteE2eResource(
          page.request,
          `/api/libraries/${destinationLibraryId}`,
          `Library placement destination library ${destinationLibraryId}`,
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    throwE2eCleanupFailures("Library placement", productError, cleanupErrors);
  }
});
