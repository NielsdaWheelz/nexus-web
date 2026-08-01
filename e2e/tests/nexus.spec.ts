import {
  devices,
  test,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { stateChangingApiHeaders } from "./api";
import { deleteE2eResource, throwE2eCleanupFailures } from "./cleanup";
import {
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
  gotoWithWorkspaceSession,
  makeWorkspacePane,
  makeWorkspaceState,
  workspacePaneButton,
  workspaceE2eDeviceId,
  type WorkspaceState,
} from "./workspace";

// Desktop Nexus is a portal'd ARIA dialog, not a native <dialog>.
function desktopNexusDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: "Nexus" });
}

function desktopNexusInput(root: Page | Locator): Locator {
  return root.getByRole("combobox", { name: "Find anything" });
}

function desktopNexusGrid(root: Page | Locator): Locator {
  return root.getByRole("grid");
}

function workspaceWithNotesAndSearchPanes(): WorkspaceState {
  return makeWorkspaceState(
    [
      makeWorkspacePane("pane-notes", "/notes"),
      makeWorkspacePane("pane-search", "/search"),
    ],
    { activePrimaryPaneId: "pane-notes" },
  );
}

function workspaceAtPaneLimit(): WorkspaceState {
  const panes = Array.from({ length: 12 }, (_, index) =>
    makeWorkspacePane(`pane-limit-${index}`, "/libraries"),
  );
  return makeWorkspaceState(panes, {
    activePrimaryPaneId: panes.at(-1)!.id,
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readE2eSeed<T>(name: string): T {
  return JSON.parse(
    readFileSync(path.join(__dirname, "..", ".seed", name), "utf-8"),
  ) as T;
}

async function expectOk(
  response: {
    ok(): boolean;
    status(): number;
    statusText(): string;
    text(): Promise<string>;
  },
  label: string,
): Promise<void> {
  if (response.ok()) return;
  throw new Error(
    `${label} failed: ${response.status()} ${response.statusText()} ${await response.text()}`,
  );
}

async function openDesktopNexus(
  page: Page,
): Promise<{ dialog: Locator; input: Locator }> {
  await page.getByRole("button", { name: "Search or ask anything" }).click();
  const dialog = desktopNexusDialog(page);
  const input = desktopNexusInput(dialog);
  await expect(dialog).toBeVisible();
  await expect(input).toBeFocused();
  return { dialog, input };
}

function desktopNexusGroup(dialog: Locator, id: string): Locator {
  return dialog.locator(
    `[role="rowgroup"][aria-labelledby="desktop-nexus-section-${id}"]`,
  );
}

async function makeRoomAndRetry(dialog: Locator): Promise<void> {
  await dialog.getByRole("button", { name: "Manage tabs" }).click();
  await expect(
    dialog.getByRole("heading", { name: "Manage tabs" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: /^Close / }).first().click();
  await dialog.getByRole("button", { name: "Retry open" }).click();
  await expect(dialog).toBeHidden();
}

interface NexusSearchSeed {
  readonly media_id: string;
  readonly quote_exact: string;
}

interface NexusAudioSeed {
  readonly media_id: string;
  readonly title: string;
  readonly stream_path: string;
  readonly duration_seconds: number;
}

interface NexusLecternItem {
  readonly itemId: string;
  readonly mediaId: string;
}

function toneWav(durationSeconds: number): Buffer {
  const sampleRate = 8_000;
  const dataSize = sampleRate * durationSeconds;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + dataSize, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate, 28);
  bytes.writeUInt16LE(1, 32);
  bytes.writeUInt16LE(8, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(dataSize, 40);
  for (let sample = 0; sample < dataSize; sample += 1) {
    bytes[44 + sample] =
      128 +
      Math.round(Math.sin((2 * Math.PI * 440 * sample) / sampleRate) * 48);
  }
  return bytes;
}

async function removeMediaFromLectern(
  request: APIRequestContext,
  mediaId: string,
): Promise<void> {
  const response = await request.get("/api/lectern");
  await expectOk(response, "Read Lectern");
  const payload = (await response.json()) as {
    data: { items: NexusLecternItem[] };
  };
  for (const item of payload.data.items.filter(
    (candidate) => candidate.mediaId === mediaId,
  )) {
    const removed = await request.post("/api/lectern/commands", {
      headers: stateChangingApiHeaders(),
      data: {
        kind: "RemoveItem",
        clientMutationId: randomUUID(),
        itemId: item.itemId,
      },
    });
    await expectOk(removed, `Remove Lectern item ${item.itemId}`);
  }
}

async function resetAndPlaceAudio(
  request: APIRequestContext,
  mediaId: string,
): Promise<void> {
  await removeMediaFromLectern(request, mediaId);
  const reset = await request.post("/api/consumption/commands", {
    headers: stateChangingApiHeaders(),
    data: {
      kind: "ResetProgress",
      clientMutationId: randomUUID(),
      mediaId,
    },
  });
  await expectOk(reset, `Reset audio ${mediaId}`);
  const placed = await request.post("/api/lectern/commands", {
    headers: stateChangingApiHeaders(),
    data: {
      kind: "PlaceItems",
      clientMutationId: randomUUID(),
      mediaIds: [mediaId],
      placement: { kind: "Last" },
    },
  });
  await expectOk(placed, `Place audio ${mediaId}`);
}

test.describe("desktop Nexus", () => {
  test("Root intent opens over the restored workspace", async ({
    page,
  }, testInfo) => {
    await gotoWithWorkspaceSession(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-root-nexus"),
      workspaceWithNotesAndSearchPanes(),
      "/?nexus=1&intent=Root",
    );

    const dialog = desktopNexusDialog(page);
    await expect(dialog).toBeVisible();
    await expect(desktopNexusInput(dialog)).toBeFocused();
    const searchActions = dialog.getByRole("button", {
      name: "Actions for Notes",
    });
    await expect(searchActions).toBeVisible();
    await expect(
      desktopNexusGrid(dialog).getByRole("gridcell", {
        name: /Actions for Notes\. Shortcut /,
      }),
    ).toBeVisible();
    await expect(desktopNexusGrid(dialog)).toHaveAttribute(
      "aria-label",
      "Nexus options",
    );

    await expect(workspacePaneButton(page, /^Notes\b/)).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(workspacePaneButton(page, /^Search\b/)).toBeVisible();
    await expect(workspacePaneButton(page, /^Lectern\b/)).toHaveCount(0);
    await expect(
      page
        .getByRole("toolbar", { name: "Workspace panes" })
        .getByRole("button", { name: /^Close / }),
    ).toHaveCount(2);
    await expect(page).toHaveURL(/\/notes$/);
  });

  test("retired WebSearch intent opens the explicit recovery state", async ({
    page,
  }) => {
    await page.goto("/libraries?nexus=1&intent=WebSearch&q=epistemology");

    const dialog = desktopNexusDialog(page);
    await expect(
      dialog.getByRole("heading", { name: "Web Search" }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole("heading", {
        name: "This link is no longer supported",
      }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Open Browse" }),
    ).toBeVisible();
    await expect(dialog.getByText("epistemology")).toHaveCount(0);
  });

  for (const viewport of [
    { width: 769, height: 800 },
    { width: 844, height: 390 },
  ] as const) {
    test(`Actions remains pointer reachable at ${viewport.width}x${viewport.height} fine-pointer desktop`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      await gotoWithWorkspaceSession(
        page,
        workspaceE2eDeviceId(
          testInfo,
          `e2e-nexus-narrow-actions-${viewport.width}x${viewport.height}`,
        ),
        workspaceWithNotesAndSearchPanes(),
        "/?nexus=1&intent=Root",
      );

      await expect(
        desktopNexusDialog(page).getByRole("button", {
          name: "Actions for Notes",
        }),
      ).toBeVisible();
    });
  }

  test("Home and End remain input-owned while the grid exposes sibling action cells", async ({
    page,
  }) => {
    await page.goto("/libraries?nexus=1&intent=Root");
    const dialog = desktopNexusDialog(page);
    await expect(dialog).toBeVisible();
    const input = desktopNexusInput(dialog);
    await expect(input).toBeFocused();
    await input.fill("Find");
    const grid = desktopNexusGrid(dialog);
    await expect(grid.getByRole("row").nth(1)).toBeVisible();
    const activeBefore = await input.getAttribute("aria-activedescendant");
    await input.press("Home");
    await expect(input).toHaveJSProperty("selectionStart", 0);
    await expect(input).toHaveAttribute(
      "aria-activedescendant",
      activeBefore ?? "",
    );
    await input.press("End");
    await expect(input).toHaveJSProperty("selectionStart", 4);
    await expect(input).toHaveAttribute(
      "aria-activedescendant",
      activeBefore ?? "",
    );
    await expect(grid.getByRole("option")).toHaveCount(0);
    await expect(grid.getByRole("gridcell").first()).toBeVisible();
  });
});

test.describe("Nexus real-stack journeys", () => {
  test("replays one created Page after pane-limit recovery", async ({
    page,
  }, testInfo) => {
    test.slow();
    const title = `Nexus replay Page ${randomUUID()}`;
    let createdId: string | null = null;
    let productError: unknown = null;
    let createRequests = 0;
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/notes/pages"
      ) {
        createRequests += 1;
      }
    });

    try {
      await gotoWithWorkspaceSession(
        page,
        workspaceE2eDeviceId(testInfo, "e2e-nexus-page-replay"),
        workspaceAtPaneLimit(),
        "/libraries",
      );
      const { dialog, input } = await openDesktopNexus(page);
      await input.fill(`/p ${title}`);
      const createResponsePromise = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/notes/pages",
      );
      await desktopNexusGroup(dialog, "Results")
        .getByRole("gridcell", { name: /^New Page\b/ })
        .click();
      const createResponse = await createResponsePromise;
      await expectOk(createResponse, "Create Page through Nexus");
      const created = (await createResponse.json()) as {
        data: { id: string };
      };
      createdId = created.data.id;

      await expect(
        dialog.getByRole("heading", { name: "Tab limit reached" }),
      ).toBeVisible();
      await expect(dialog.getByText("Your page was created.")).toBeVisible();
      await makeRoomAndRetry(dialog);
      await expect(page).toHaveURL(new RegExp(`/pages/${createdId}$`));
      expect(createRequests).toBe(1);
    } catch (error) {
      productError = error;
      throw error;
    } finally {
      const cleanupErrors: unknown[] = [];
      if (createdId) {
        try {
          await deleteE2eResource(
            page.request,
            `/api/notes/pages/${createdId}`,
            `Nexus replay Page ${createdId}`,
          );
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      throwE2eCleanupFailures(
        "Nexus Page replay",
        productError,
        cleanupErrors,
      );
    }
  });

  test("replays one created Library after pane-limit recovery", async ({
    page,
  }, testInfo) => {
    test.slow();
    const name = `Nexus replay Library ${randomUUID()}`;
    let createdId: string | null = null;
    let productError: unknown = null;
    let createRequests = 0;
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/libraries"
      ) {
        createRequests += 1;
      }
    });

    try {
      await gotoWithWorkspaceSession(
        page,
        workspaceE2eDeviceId(testInfo, "e2e-nexus-library-replay"),
        workspaceAtPaneLimit(),
        "/libraries",
      );
      const { dialog, input } = await openDesktopNexus(page);
      await input.fill(`/l ${name}`);
      await desktopNexusGroup(dialog, "Results")
        .getByRole("gridcell", { name: /^New Library\b/ })
        .click();
      await expect(
        dialog.getByRole("heading", { name: "New library" }),
      ).toBeVisible();
      await expect(dialog.getByRole("textbox", { name: "Name" })).toHaveValue(
        name,
      );

      const createResponsePromise = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/libraries",
      );
      await dialog.getByRole("button", { name: "Create" }).click();
      const createResponse = await createResponsePromise;
      await expectOk(createResponse, "Create Library through Nexus");
      const created = (await createResponse.json()) as {
        data: { id: string };
      };
      createdId = created.data.id;

      await expect(
        dialog.getByRole("heading", { name: "Tab limit reached" }),
      ).toBeVisible();
      await expect(dialog.getByText("Your library was created.")).toBeVisible();
      await makeRoomAndRetry(dialog);
      await expect(page).toHaveURL(new RegExp(`/libraries/${createdId}$`));
      expect(createRequests).toBe(1);
    } catch (error) {
      productError = error;
      throw error;
    } finally {
      const cleanupErrors: unknown[] = [];
      if (createdId) {
        try {
          await deleteE2eResource(
            page.request,
            `/api/libraries/${createdId}`,
            `Nexus replay Library ${createdId}`,
          );
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      throwE2eCleanupFailures(
        "Nexus Library replay",
        productError,
        cleanupErrors,
      );
    }
  });

  test("routes Browse for a typed query through the canonical Browse owner", async ({
    page,
  }, testInfo) => {
    const query = `frontier systems ${randomUUID()}`;
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-nexus-browse"),
      "/libraries",
    );
    const { dialog, input } = await openDesktopNexus(page);
    await input.fill(query);
    await desktopNexusGroup(dialog, "QueryActions")
      .getByRole("gridcell", {
        name: new RegExp(`^Browse for .${escapeRegExp(query)}.`),
      })
      .click();
    await expect(
      dialog.getByRole("heading", { name: `Browse for “${query}”` }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Articles" }).click();

    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL((url) => {
      return (
        url.pathname === "/browse" &&
        url.searchParams.get("kind") === "WebArticle" &&
        url.searchParams.get("q") === query
      );
    });
  });

  test("projects real canonical Search and Openables responses", async ({
    page,
  }, testInfo) => {
    test.slow();
    const searchSeed = readE2eSeed<NexusSearchSeed>("non-pdf-media.json");
    const pageTitle = `Nexus Openable ${randomUUID()}`;
    const pageId = randomUUID();
    let ownsPage = false;
    let productError: unknown = null;

    try {
      const createdPage = await page.request.post("/api/notes/pages", {
        headers: stateChangingApiHeaders(),
        data: { page_id: pageId, title: pageTitle },
      });
      await expectOk(createdPage, "Create Openables Page fixture");
      ownsPage = true;

      await gotoSinglePaneWorkspace(
        page,
        workspaceE2eDeviceId(testInfo, "e2e-nexus-providers"),
        "/libraries",
      );
      const { dialog, input } = await openDesktopNexus(page);

      const searchResponsePromise = page.waitForResponse(
        (response) =>
          response.request().method() === "GET" &&
          new URL(response.url()).pathname === "/api/search",
      );
      await input.fill(searchSeed.quote_exact);
      const searchResponse = await searchResponsePromise;
      await expectOk(searchResponse, "Nexus canonical Search");
      expect(await searchResponse.text()).toContain(searchSeed.media_id);
      await expect(
        desktopNexusGroup(dialog, "Results")
          .getByRole("gridcell", {
            name: new RegExp(escapeRegExp(searchSeed.quote_exact), "i"),
          })
          .first(),
      ).toBeVisible({ timeout: 15_000 });

      const openablesResponsePromise = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname ===
            "/api/resource-items/openables/search",
      );
      await input.fill(pageTitle);
      const openablesResponse = await openablesResponsePromise;
      await expectOk(openablesResponse, "Nexus Openables");
      expect(await openablesResponse.text()).toContain(pageId);
      await desktopNexusGroup(dialog, "Results")
        .getByRole("gridcell", {
          name: new RegExp(`^${escapeRegExp(pageTitle)}\\b`),
        })
        .click();
      await expect(dialog).toBeHidden();
      await expect(page).toHaveURL(new RegExp(`/pages/${pageId}$`));
    } catch (error) {
      productError = error;
      throw error;
    } finally {
      const cleanupErrors: unknown[] = [];
      if (ownsPage) {
        try {
          await deleteE2eResource(
            page.request,
            `/api/notes/pages/${pageId}`,
            `Nexus Openables Page ${pageId}`,
          );
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      throwE2eCleanupFailures(
        "Nexus Search and Openables",
        productError,
        cleanupErrors,
      );
    }
  });

  test("resumes the one paused shell player session from Continue", async ({
    page,
  }, testInfo) => {
    test.slow();
    const audio = readE2eSeed<NexusAudioSeed>("activity-audio-media.json");
    let productError: unknown = null;
    await page.route(new RegExp(`${escapeRegExp(audio.stream_path)}$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: "audio/wav",
        body: toneWav(audio.duration_seconds),
      }),
    );

    try {
      await resetAndPlaceAudio(page.request, audio.media_id);
      await gotoSinglePaneWorkspace(
        page,
        workspaceE2eDeviceId(testInfo, "e2e-nexus-continue"),
        "/lectern",
      );
      await activeWorkspacePane(page)
        .getByRole("button", { name: `Play ${audio.title}` })
        .click();
      const player = page.getByRole("region", { name: "Media player" });
      const audioElement = page.locator('audio[aria-label="Media player audio"]');
      await expect(player).toBeVisible();
      await expect(audioElement).toHaveJSProperty("paused", false);
      await player.getByRole("button", { name: "Pause media player" }).click();
      await expect(audioElement).toHaveJSProperty("paused", true);

      const { dialog } = await openDesktopNexus(page);
      await expect(
        desktopNexusGroup(dialog, "Continue").getByRole("gridcell", {
          name: new RegExp(`^${escapeRegExp(audio.title)}\\b`),
        }),
      ).toBeVisible();
      await desktopNexusGroup(dialog, "Continue")
        .getByRole("gridcell", {
          name: new RegExp(`^${escapeRegExp(audio.title)}\\b`),
        })
        .click();
      await expect(dialog).toBeHidden();
      await expect(audioElement).toHaveJSProperty("paused", false);
    } catch (error) {
      productError = error;
      throw error;
    } finally {
      const cleanupErrors: unknown[] = [];
      try {
        await removeMediaFromLectern(page.request, audio.media_id);
      } catch (error) {
        cleanupErrors.push(error);
      }
      throwE2eCleanupFailures(
        "Nexus Continue player",
        productError,
        cleanupErrors,
      );
    }
  });
});

test.describe("desktop Nexus performance", () => {
  test("publishes the shared generic Nexus measures", async ({
    page,
  }, testInfo) => {
    await gotoWithWorkspaceSession(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-desktop-nexus-performance"),
      workspaceWithNotesAndSearchPanes(),
      "/notes",
    );
    await page.evaluate(() => {
      for (const name of [
        "nexus-open",
        "nexus-local-find",
        "nexus-openables",
        "nexus-pane-activate",
      ]) {
        performance.clearMeasures(name);
      }
    });

    const { dialog, input } = await openDesktopNexus(page);
    await waitForMeasureCount(page, "nexus-open", 1);

    await input.fill("notes");
    await waitForMeasureCount(page, "nexus-local-find", 1);
    await waitForMeasureCount(page, "nexus-openables", 1);

    await input.fill("");
    await desktopNexusGrid(dialog)
      .getByRole("gridcell", { name: /^Search\b/ })
      .click();
    await expect(dialog).toBeHidden();
    await waitForMeasureCount(page, "nexus-pane-activate", 1);

    for (const name of [
      "nexus-desktop-open-input-ready",
      "nexus-desktop-local-rows",
      "nexus-desktop-pane-activate",
      "nexus-desktop-providers-first-usable",
    ]) {
      expect(await measureCount(page, name)).toBe(0);
    }
  });
});

const PERFORMANCE_SETUP_ITERATIONS = 5;
const PERFORMANCE_SAMPLE_COUNT = 50;
const OPENABLES_SAMPLE_COUNT = 100;
const PERFORMANCE_CPU_SLOWDOWN = 4;
const PERFORMANCE_TEST_TIMEOUT_MS = 180_000;
const NEXUS_INTERACTION_BUDGET_MS = 100;
const NEXUS_OPENABLES_BUDGET_MS = 250;
const SIXTY_HZ_FRAME_MS = 1000 / 60;

function nexusDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: "Nexus" });
}

const NEXUS_TASK_VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 320, height: 568 },
  { width: 844, height: 390 },
  { width: 568, height: 320 },
] as const;

async function expectNexusTaskProjection(
  dialog: Locator,
  viewport: { readonly width: number; readonly height: number },
): Promise<void> {
  await expect(dialog).toBeVisible();
  const readProjection = () =>
    dialog.evaluate((element) => {
      const wrapper = element.parentElement;
      if (!wrapper) {
        throw new Error("Nexus task dialog requires its modal projection.");
      }
      const frame = element.getBoundingClientRect();
      const visualViewport = window.visualViewport;
      const expectedTop = visualViewport?.offsetTop ?? 0;
      const expectedLeft = visualViewport?.offsetLeft ?? 0;
      const expectedWidth = visualViewport?.width ?? window.innerWidth;
      const expectedHeight = visualViewport?.height ?? window.innerHeight;
      const wrapperStyle = getComputedStyle(wrapper);
      const frameStyle = getComputedStyle(element);
      return {
        frame: {
          top: frame.top,
          right: frame.right,
          bottom: frame.bottom,
          left: frame.left,
          width: frame.width,
          height: frame.height,
        },
        expected: {
          top: expectedTop,
          right: expectedLeft + expectedWidth,
          bottom: expectedTop + expectedHeight,
          left: expectedLeft,
          width: expectedWidth,
          height: expectedHeight,
        },
        wrapperBackground: wrapperStyle.backgroundColor,
        wrapperBackdrop: wrapper.getAttribute("data-modal-backdrop"),
        wrapperZIndex: wrapperStyle.zIndex,
        nexusZIndex: getComputedStyle(document.documentElement)
          .getPropertyValue("--z-nexus")
          .trim(),
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        frameBackground: frameStyle.backgroundColor,
      };
    });
  await expect
    .poll(
      async () => {
        const projection = await readProjection();
        return Math.max(
          Math.abs(projection.frame.left - projection.expected.left),
          Math.abs(projection.frame.top - projection.expected.top),
          Math.abs(projection.frame.right - projection.expected.right),
          Math.abs(projection.frame.bottom - projection.expected.bottom),
          Math.abs(projection.frame.width - viewport.width),
          Math.abs(projection.frame.height - viewport.height),
        );
      },
      { message: "Nexus task frame did not converge on the visual viewport" },
    )
    .toBeLessThan(0.5);
  const projection = await readProjection();

  expect(projection.frame.left).toBeCloseTo(projection.expected.left, 0);
  expect(projection.frame.top).toBeCloseTo(projection.expected.top, 0);
  expect(projection.frame.right).toBeCloseTo(projection.expected.right, 0);
  expect(projection.frame.bottom).toBeCloseTo(projection.expected.bottom, 0);
  expect(projection.frame.width).toBeCloseTo(projection.expected.width, 0);
  expect(projection.frame.height).toBeCloseTo(projection.expected.height, 0);
  expect(projection.frame.width).toBeCloseTo(viewport.width, 0);
  expect(projection.frame.height).toBeCloseTo(viewport.height, 0);
  expect(projection.wrapperBackdrop).toBe("true");
  expect(projection.wrapperBackground).toBe("rgba(0, 0, 0, 0)");
  expect(projection.wrapperZIndex).toBe(projection.nexusZIndex);
  expect(projection.bodyBackground).toMatch(/^rgb\(/);
  expect(projection.frameBackground).toBe(projection.bodyBackground);
  await expect(dialog.locator("[data-grabber]")).toHaveCount(0);
}

interface NexusGeometry {
  readonly wrapper: { x: number; y: number; width: number; height: number };
  readonly button: { x: number; y: number; width: number; height: number };
  readonly counter: { x: number; y: number; width: number; height: number };
  readonly counterBlockStart: number;
  readonly counterInlineEnd: number;
  readonly contentBottomPadding: number;
  readonly viewportHeight: number;
}

async function nexusGeometry(
  page: Page,
  paneCount: number,
): Promise<NexusGeometry> {
  const button = page.getByRole("button", {
    name:
      paneCount === 1 ? "Open Nexus, 1 tab" : `Open Nexus, ${paneCount} tabs`,
  });
  await expect(button).toBeVisible();
  const wrapper = page.getByTestId("nexus-wrapper");
  const counter = button.getByText(String(paneCount), { exact: true });
  const content = activeWorkspacePane(page).getByTestId("pane-shell-body");
  await expect(counter).toHaveCount(1);
  const [wrapperElement, buttonElement, counterElement, contentElement] =
    await Promise.all([
      wrapper.elementHandle(),
      button.elementHandle(),
      counter.elementHandle(),
      content.elementHandle(),
    ]);
  if (!wrapperElement || !buttonElement || !counterElement || !contentElement) {
    throw new Error("Nexus geometry requires connected control elements.");
  }
  return page.evaluate(
    ({ wrapperElement, buttonElement, counterElement, contentElement }) => {
      const rect = (element: Element) => {
        const bounds = element.getBoundingClientRect();
        return {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        };
      };
      const buttonRect = buttonElement.getBoundingClientRect();
      const counterRect = counterElement.getBoundingClientRect();
      return {
        wrapper: rect(wrapperElement),
        button: rect(buttonElement),
        counter: rect(counterElement),
        counterBlockStart: counterRect.top - buttonRect.top,
        counterInlineEnd: buttonRect.right - counterRect.right,
        contentBottomPadding: Number.parseFloat(
          getComputedStyle(contentElement).paddingBottom,
        ),
        viewportHeight: window.innerHeight,
      };
    },
    {
      wrapperElement,
      buttonElement,
      counterElement,
      contentElement,
    },
  );
}

function p95(samples: readonly number[]): number {
  const ordered = [...samples].sort((left, right) => left - right);
  return (
    ordered[Math.ceil(ordered.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY
  );
}

async function measureCount(page: Page, name: string): Promise<number> {
  return page.evaluate(
    (measureName) =>
      performance.getEntriesByName(measureName, "measure").length,
    name,
  );
}

async function waitForMeasureCount(
  page: Page,
  name: string,
  count: number,
): Promise<void> {
  await expect
    .poll(() => measureCount(page, name), {
      message: `expected ${count} ${name} user-timing samples`,
    })
    .toBe(count);
}

async function measureDurations(page: Page, name: string): Promise<number[]> {
  return page.evaluate(
    (measureName) =>
      performance
        .getEntriesByName(measureName, "measure")
        .map((entry) => entry.duration),
    name,
  );
}

test.describe("mobile Nexus task", () => {
  test.use({
    viewport: devices["Pixel 7"].viewport,
    userAgent: devices["Pixel 7"].userAgent,
    deviceScaleFactor: devices["Pixel 7"].deviceScaleFactor,
    isMobile: devices["Pixel 7"].isMobile,
    hasTouch: devices["Pixel 7"].hasTouch,
  });

  test("switches, closes, and restores exact panes from one local-first root", async ({
    page,
  }, testInfo) => {
    const panes = [
      makeWorkspacePane("pane-notes", "/notes"),
      makeWorkspacePane("pane-search", "/search"),
      ...Array.from({ length: 4 }, (_, index) =>
        makeWorkspacePane(`pane-library-${index}`, "/libraries"),
      ),
    ];
    await gotoWithWorkspaceSession(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-nexus-tabs"),
      makeWorkspaceState(panes, { activePrimaryPaneId: "pane-notes" }),
      "/notes",
    );

    const trigger = page.getByRole("button", {
      name: "Open Nexus, 6 tabs",
    });
    const paneBody = activeWorkspacePane(page).getByTestId("pane-shell-body");
    await expect
      .poll(() =>
        paneBody.evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).paddingBottom),
        ),
      )
      .toBeGreaterThan(0);
    await expect(trigger).toBeVisible();
    await trigger.tap();

    const dialog = nexusDialog(page);
    await expect(dialog).toBeVisible();
    await expect
      .poll(() =>
        paneBody.evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).paddingBottom),
        ),
      )
      .toBe(0);
    const search = dialog.getByRole("searchbox", { name: "Find anything" });
    await expect(search).toBeFocused();
    await expect(
      dialog.getByRole("button", { name: "Find anything…" }),
    ).toHaveCount(0);
    await expect(dialog.getByRole("heading", { name: "Places" })).toBeVisible();
    await expect(
      dialog.getByRole("heading", { name: "Quick Actions" }),
    ).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Open" })).toBeVisible();

    await dialog.getByRole("button", { name: "Search Open tab" }).tap();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/search$/);
    await expect(
      activeWorkspacePane(page).getByTestId("pane-shell-root"),
    ).toBeFocused();

    await page.getByRole("button", { name: "Open Nexus, 6 tabs" }).tap();
    const openDialog = nexusDialog(page);
    await openDialog.getByRole("button", { name: "Manage tabs…" }).tap();
    await openDialog.getByRole("button", { name: "Close Search" }).tap();
    await expect(
      openDialog.getByRole("heading", { name: "Recently closed" }),
    ).toBeVisible();
    await expect(
      openDialog.getByRole("button", { name: "Search", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Open Nexus, 5 tabs" }),
    ).toBeHidden();

    await openDialog.getByRole("button", { name: "Search", exact: true }).tap();
    await expect(openDialog).toBeHidden();
    await expect(page).toHaveURL(/\/search$/);
    await expect(
      page.getByRole("button", { name: "Open Nexus, 6 tabs" }),
    ).toBeVisible();
  });

  test("covers phone portrait and landscape visual viewports with an opaque task canvas", async ({
    page,
  }, testInfo) => {
    for (const viewport of NEXUS_TASK_VIEWPORTS) {
      await page.setViewportSize(viewport);
      await gotoSinglePaneWorkspace(
        page,
        workspaceE2eDeviceId(
          testInfo,
          `e2e-nexus-task-${viewport.width}x${viewport.height}`,
        ),
        "/libraries",
      );

      const trigger = page.getByRole("button", {
        name: "Open Nexus, 1 tab",
      });
      const wrapper = page.getByTestId("nexus-wrapper");
      const mountedControl = wrapper.locator("button");
      const paneBody = activeWorkspacePane(page).getByTestId("pane-shell-body");
      const closedClearance = await paneBody.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).paddingBottom),
      );
      expect(closedClearance).toBeGreaterThan(0);
      await expect(trigger).toBeVisible();
      await trigger.tap();

      const dialog = nexusDialog(page);
      await expectNexusTaskProjection(dialog, viewport);
      await expect
        .poll(() =>
          paneBody.evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).paddingBottom),
          ),
        )
        .toBe(0);
      await expect(wrapper).toHaveCount(1);
      await expect(mountedControl).toBeHidden();
      await expect(mountedControl).toHaveAttribute("aria-hidden", "true");
      await expect(mountedControl).toHaveAttribute("inert", "");

      const deviceScaleFactor = await page.evaluate(
        () => window.devicePixelRatio,
      );
      const captureTask = async (
        variant: "default" | "reduced-motion" | "forced-colors",
      ) => {
        const artifactName = [
          "nexus-task",
          `${viewport.width}x${viewport.height}-css-px`,
          `dpr-${String(deviceScaleFactor).replace(".", "-")}`,
          variant,
        ].join("-");
        const artifactPath = testInfo.outputPath(`${artifactName}.png`);
        await page.screenshot({
          path: artifactPath,
          animations: "disabled",
        });
        await testInfo.attach(artifactName, {
          path: artifactPath,
          contentType: "image/png",
        });
      };

      await captureTask("default");
      if (viewport.width === 390 && viewport.height === 844) {
        await page.emulateMedia({ reducedMotion: "reduce" });
        expect(
          await page.evaluate(
            () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
          ),
        ).toBe(true);
        await captureTask("reduced-motion");
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.emulateMedia({ forcedColors: "active" });
        expect(
          await page.evaluate(
            () => window.matchMedia("(forced-colors: active)").matches,
          ),
        ).toBe(true);
        await captureTask("forced-colors");
        await page.emulateMedia({ forcedColors: "none" });
      }

      const searchInput = dialog.getByRole("searchbox", {
        name: "Find anything",
      });
      await expect(searchInput).toBeFocused();
      await expect(
        dialog.getByRole("button", { name: "Find anything…" }),
      ).toHaveCount(0);
      const searchScroll = dialog.getByTestId("switchboard-search-scroll");
      const [scrollBox, dialogBox] = await Promise.all([
        searchScroll.boundingBox(),
        dialog.boundingBox(),
      ]);
      if (!scrollBox || !dialogBox) {
        throw new Error("Visible Nexus task and scroll owner require bounds.");
      }
      expect(scrollBox.y).toBeGreaterThanOrEqual(dialogBox.y);
      expect(scrollBox.y + scrollBox.height).toBeLessThanOrEqual(
        dialogBox.y + dialogBox.height + 1,
      );

      const box = await dialog.boundingBox();
      if (!box) throw new Error("Visible Nexus task requires a bounding box.");
      await page.mouse.move(box.x + box.width / 2, box.y + 24);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height - 24);
      await page.mouse.up();
      await expect(dialog).toBeVisible();

      await dialog.getByRole("button", { name: "Done" }).tap();
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeVisible();
      await expect(trigger).toBeFocused();
      await expect
        .poll(() =>
          paneBody.evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).paddingBottom),
          ),
        )
        .toBe(closedClearance);
    }
  });

  test("Nexus row actions dismiss before the task and restore their trigger", async ({
    page,
  }, testInfo) => {
    await gotoWithWorkspaceSession(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-nexus-action-menu-ordering"),
      workspaceWithNotesAndSearchPanes(),
      "/notes",
    );

    await page.getByRole("button", { name: "Open Nexus, 2 tabs" }).tap();
    const nexus = nexusDialog(page);
    const actions = nexus.getByRole("button", {
      name: "Actions for Notes",
    });
    const menu = page.getByRole("menu", { name: "Actions for Notes" });
    const nexusProjection = nexus.locator("..");
    const nexusUrl = page.url();

    await actions.tap();
    await expect(menu).toBeVisible();
    await expect(nexus).toHaveAttribute("aria-modal", "true");
    await expect(nexus).not.toHaveAttribute("inert");
    await expect(nexusProjection).not.toHaveAttribute("data-suspended");
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(nexus).toBeVisible();
    await expect(page).toHaveURL(nexusUrl);
    await expect(actions).toBeFocused();

    await actions.tap();
    await expect(menu).toBeVisible();
    await expect(nexus).toHaveAttribute("aria-modal", "true");
    await expect(nexus).not.toHaveAttribute("inert");
    await expect(nexusProjection).not.toHaveAttribute("data-suspended");
    await page.goBack();
    await expect(menu).toBeHidden();
    await expect(nexus).toBeVisible();
    await expect(page).toHaveURL(nexusUrl);
    await expect(actions).toBeFocused();
  });

  test("browser Back clears typed Root before dismissing blank Root", async ({
    page,
  }, testInfo) => {
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-nexus-back"),
      "/libraries",
    );

    const trigger = page.getByRole("button", {
      name: "Open Nexus, 1 tab",
    });
    await trigger.tap();
    const dialog = nexusDialog(page);
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole("searchbox", { name: "Find anything" });
    await expect(input).toBeFocused();
    await input.fill("stats");

    const urlBeforeBack = page.url();
    await page.goBack();

    await expect(dialog).toBeVisible();
    await expect(input).toHaveValue("");
    await expect(page).toHaveURL(urlBeforeBack);

    await page.goBack();

    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(urlBeforeBack);
    await expect(trigger).toBeFocused();
  });

  test("dirty Add guard confirms browser Back, Escape, and visible Back", async ({
    page,
  }, testInfo) => {
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-nexus-nested-confirmation"),
      "/libraries",
    );

    const trigger = page.getByRole("button", {
      name: "Open Nexus, 1 tab",
    });
    await trigger.tap();
    const nexus = nexusDialog(page);
    await nexus.getByRole("button", { name: "Import" }).tap();
    const links = nexus.getByRole("textbox", { name: "Links" });
    await links.fill("https://example.com/article");

    const confirmation = page.getByRole("dialog", {
      name: "Discard unfinished work?",
    });
    const urlBeforeExit = page.url();

    await page.goBack();
    await expect(confirmation).toBeVisible();
    const suspendedNexus = page.locator('[role="dialog"][aria-label="Nexus"]');
    await expect(suspendedNexus).toHaveAttribute("inert", "");
    await expect(suspendedNexus).not.toHaveAttribute("aria-modal");
    await expect(suspendedNexus.locator("..")).toHaveAttribute(
      "data-suspended",
      "true",
    );
    await expect
      .poll(() =>
        suspendedNexus.evaluate(
          (element) =>
            getComputedStyle(element).backgroundColor !== "rgba(0, 0, 0, 0)",
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        confirmation.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const topmost = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          );
          return topmost !== null && element.contains(topmost);
        }),
      )
      .toBe(true);

    await confirmation.getByRole("button", { name: "Keep working" }).tap();
    await expect(confirmation).toBeHidden();
    await expect(nexus).toBeVisible();
    await expect(nexus).toHaveAttribute("aria-modal", "true");
    await expect(links).toHaveValue("https://example.com/article");
    await expect(page).toHaveURL(urlBeforeExit);

    await page.keyboard.press("Escape");
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole("button", { name: "Keep working" }).tap();
    await expect(confirmation).toBeHidden();
    await expect(nexus).toBeVisible();
    await expect(nexus).toHaveAttribute("aria-modal", "true");
    await expect(links).toHaveValue("https://example.com/article");
    await expect(page).toHaveURL(urlBeforeExit);

    await nexus.getByRole("button", { name: "Back", exact: true }).tap();
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole("button", { name: "Keep working" }).tap();
    await expect(confirmation).toBeHidden();
    await expect(nexus).toBeVisible();
    await expect(nexus).toHaveAttribute("aria-modal", "true");
    await expect(links).toHaveValue("https://example.com/article");
    await expect(page).toHaveURL(urlBeforeExit);

    await nexus.getByRole("button", { name: "Close Add content" }).tap();
    await page
      .getByRole("dialog", { name: "Discard unfinished work?" })
      .getByRole("button", { name: "Discard" })
      .tap();
    await expect(nexus).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(page).toHaveURL(urlBeforeExit);
  });

  test("rotation and mobile-desktop breakpoint changes preserve Root query", async ({
    page,
  }, testInfo) => {
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-nexus-orientation"),
      "/libraries",
    );
    await page.getByRole("button", { name: "Open Nexus, 1 tab" }).tap();
    const nexus = nexusDialog(page);
    await nexus.getByRole("searchbox", { name: "Find anything" }).fill("stats");

    await page.setViewportSize({ width: 568, height: 320 });
    await expectNexusTaskProjection(nexus, { width: 568, height: 320 });
    await expect(
      nexus.getByRole("searchbox", { name: "Find anything" }),
    ).toHaveValue("stats");

    await page.setViewportSize({ width: 1200, height: 800 });
    const desktop = nexusDialog(page);
    await expect(desktop).toBeVisible();
    await expect(
      desktop.getByRole("combobox", { name: "Find anything" }),
    ).toHaveValue("stats");

    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = nexusDialog(page);
    await expectNexusTaskProjection(mobile, { width: 390, height: 844 });
    await expect(
      mobile.getByRole("searchbox", { name: "Find anything" }),
    ).toHaveValue("stats");
  });

  test("autofocused Root retrieves canonical Places without scopes", async ({
    page,
  }, testInfo) => {
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-nexus-find"),
      "/libraries",
    );
    await page.getByRole("button", { name: "Open Nexus, 1 tab" }).tap();

    const dialog = nexusDialog(page);
    const input = dialog.getByRole("searchbox", { name: "Find anything" });
    await expect(input).toBeFocused();

    await input.fill("stats");
    await expect(
      dialog.getByRole("button", { name: /^Stats\b/ }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "All", exact: true }),
    ).toHaveCount(0);
    await expect(dialog.getByRole("heading", { name: "Find" })).toHaveCount(0);

    await dialog.getByRole("button", { name: /^Stats\b/ }).tap();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL((url) => {
      const params = url.searchParams;
      return (
        url.pathname === "/stats" &&
        params.get("view") === "stats" &&
        params.get("period") === "day" &&
        /^\d{4}-\d{2}-\d{2}$/.test(params.get("anchor") ?? "") &&
        [...params.keys()].sort().join(",") === "anchor,period,view"
      );
    });
  });

  test("keeps target, counter, anchor, and obstruction geometry fixed across tab counts", async ({
    page,
  }, testInfo) => {
    for (const rootFontSize of [16, 32] as const) {
      const measurements: NexusGeometry[] = [];
      for (const paneCount of [1, 9, 12] as const) {
        const panes = Array.from({ length: paneCount }, (_, index) =>
          makeWorkspacePane(`pane-${index}`, "/notes"),
        );
        await gotoWithWorkspaceSession(
          page,
          workspaceE2eDeviceId(
            testInfo,
            `e2e-nexus-geometry-${rootFontSize}-${paneCount}`,
          ),
          makeWorkspaceState(panes, {
            activePrimaryPaneId: panes[0]!.id,
          }),
          "/notes",
        );
        await page.evaluate((fontSize) => {
          document.documentElement.style.fontSize = `${fontSize}px`;
        }, rootFontSize);
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            ),
        );
        measurements.push(await nexusGeometry(page, paneCount));
      }

      const [expected, ...rest] = measurements;
      expect(expected).toBeDefined();
      expect(expected!.wrapper.width).toBeCloseTo(48, 1);
      expect(expected!.wrapper.height).toBeCloseTo(48, 1);
      expect(expected!.button.width).toBeCloseTo(48, 1);
      expect(expected!.button.height).toBeCloseTo(48, 1);
      expect(expected!.counterBlockStart).toBeCloseTo(1, 1);
      expect(expected!.counterInlineEnd).toBeCloseTo(1, 1);
      expect(expected!.contentBottomPadding).toBe(
        Math.ceil(expected!.viewportHeight - expected!.wrapper.y),
      );
      for (const measurement of rest) {
        expect(measurement).toEqual(expected);
      }
    }
  });

  test("production user-timing meets the local interaction gates", async ({
    page,
  }, testInfo) => {
    test.setTimeout(PERFORMANCE_TEST_TIMEOUT_MS);
    await gotoWithWorkspaceSession(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-nexus-performance"),
      makeWorkspaceState(
        [
          makeWorkspacePane("pane-notes", "/notes"),
          makeWorkspacePane("pane-libraries", "/libraries"),
        ],
        { activePrimaryPaneId: "pane-notes" },
      ),
      "/notes",
    );
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", {
      rate: PERFORMANCE_CPU_SLOWDOWN,
    });
    try {
      const trigger = page.getByRole("button", {
        name: "Open Nexus, 2 tabs",
      });
      for (
        let iteration = 0;
        iteration < PERFORMANCE_SETUP_ITERATIONS;
        iteration += 1
      ) {
        await trigger.tap();
        await expect(nexusDialog(page)).toBeVisible();
        await waitForMeasureCount(page, "nexus-open", iteration + 1);
        await nexusDialog(page).getByRole("button", { name: "Done" }).tap();
        await expect(nexusDialog(page)).toBeHidden();
      }
      await page.evaluate(() => performance.clearMeasures("nexus-open"));

      for (let sample = 1; sample <= PERFORMANCE_SAMPLE_COUNT; sample += 1) {
        await trigger.tap();
        await expect(nexusDialog(page)).toBeVisible();
        await waitForMeasureCount(page, "nexus-open", sample);
        await nexusDialog(page).getByRole("button", { name: "Done" }).tap();
        await expect(nexusDialog(page)).toBeHidden();
      }
      const openSamples = await measureDurations(page, "nexus-open");

      await trigger.tap();
      const dialog = nexusDialog(page);
      const input = dialog.getByRole("searchbox", { name: "Find anything" });
      await expect(input).toBeFocused();
      for (
        let iteration = 0;
        iteration < PERFORMANCE_SETUP_ITERATIONS;
        iteration += 1
      ) {
        await input.fill(iteration % 2 === 0 ? "notes" : "libraries");
        await waitForMeasureCount(page, "nexus-local-find", iteration + 1);
      }
      await page.evaluate(() => performance.clearMeasures("nexus-local-find"));
      for (let sample = 1; sample <= PERFORMANCE_SAMPLE_COUNT; sample += 1) {
        await input.fill(sample % 2 === 0 ? "notes" : "libraries");
        await waitForMeasureCount(page, "nexus-local-find", sample);
      }
      const findSamples = await measureDurations(page, "nexus-local-find");

      await expect
        .poll(() => measureCount(page, "nexus-openables"), {
          message: "expected the warm openables request to commit",
        })
        .toBeGreaterThan(0);
      await page.evaluate(() => performance.clearMeasures("nexus-openables"));
      for (
        let iteration = 0;
        iteration < PERFORMANCE_SETUP_ITERATIONS;
        iteration += 1
      ) {
        await input.fill(iteration % 2 === 0 ? "n" : "l");
        await waitForMeasureCount(page, "nexus-openables", iteration + 1);
      }
      await page.evaluate(() => performance.clearMeasures("nexus-openables"));
      for (let sample = 1; sample <= OPENABLES_SAMPLE_COUNT; sample += 1) {
        await input.fill(sample % 2 === 0 ? "n" : "l");
        await waitForMeasureCount(page, "nexus-openables", sample);
      }
      const openablesSamples = await measureDurations(page, "nexus-openables");

      await input.fill("");
      await dialog.getByRole("button", { name: "Done" }).tap();

      for (
        let iteration = 0;
        iteration < PERFORMANCE_SETUP_ITERATIONS;
        iteration += 1
      ) {
        await trigger.tap();
        await nexusDialog(page)
          .getByRole("button", { name: /^(Notes|Libraries) Open tab$/ })
          .tap();
        await expect(nexusDialog(page)).toBeHidden();
        await waitForMeasureCount(page, "nexus-pane-activate", iteration + 1);
      }
      await page.evaluate(() =>
        performance.clearMeasures("nexus-pane-activate"),
      );
      for (let sample = 1; sample <= PERFORMANCE_SAMPLE_COUNT; sample += 1) {
        await trigger.tap();
        await nexusDialog(page)
          .getByRole("button", { name: /^(Notes|Libraries) Open tab$/ })
          .tap();
        await expect(nexusDialog(page)).toBeHidden();
        await waitForMeasureCount(page, "nexus-pane-activate", sample);
      }

      const activateSamples = await measureDurations(
        page,
        "nexus-pane-activate",
      );
      const performanceSummary = {
        conditions: {
          browser: "lockfile Chromium",
          cpuSlowdown: PERFORMANCE_CPU_SLOWDOWN,
          device: "Pixel 7",
          setupIterations: PERFORMANCE_SETUP_ITERATIONS,
        },
        measures: {
          "nexus-local-find": {
            budgetMs: SIXTY_HZ_FRAME_MS,
            p95Ms: p95(findSamples),
            samples: findSamples.length,
          },
          "nexus-open": {
            budgetMs: NEXUS_INTERACTION_BUDGET_MS,
            p95Ms: p95(openSamples),
            samples: openSamples.length,
          },
          "nexus-openables": {
            budgetMs: NEXUS_OPENABLES_BUDGET_MS,
            p95Ms: p95(openablesSamples),
            samples: openablesSamples.length,
          },
          "nexus-pane-activate": {
            budgetMs: NEXUS_INTERACTION_BUDGET_MS,
            p95Ms: p95(activateSamples),
            samples: activateSamples.length,
          },
        },
      };
      await testInfo.attach("nexus-performance.json", {
        body: JSON.stringify(performanceSummary, null, 2),
        contentType: "application/json",
      });
      console.info(
        `NEXUS_PERFORMANCE_RESULT ${JSON.stringify(performanceSummary)}`,
      );
      expect(openSamples).toHaveLength(PERFORMANCE_SAMPLE_COUNT);
      expect(findSamples).toHaveLength(PERFORMANCE_SAMPLE_COUNT);
      expect(activateSamples).toHaveLength(PERFORMANCE_SAMPLE_COUNT);
      expect(openablesSamples).toHaveLength(OPENABLES_SAMPLE_COUNT);
      expect(
        p95(openSamples),
        `nexus-open p95: ${p95(openSamples).toFixed(2)}ms`,
      ).toBeLessThan(NEXUS_INTERACTION_BUDGET_MS);
      expect(
        p95(findSamples),
        `nexus-local-find p95: ${p95(findSamples).toFixed(2)}ms`,
      ).toBeLessThan(SIXTY_HZ_FRAME_MS);
      expect(
        p95(activateSamples),
        `nexus-pane-activate p95: ${p95(activateSamples).toFixed(2)}ms`,
      ).toBeLessThan(NEXUS_INTERACTION_BUDGET_MS);
      expect(
        p95(openablesSamples),
        `nexus-openables p95: ${p95(openablesSamples).toFixed(2)}ms`,
      ).toBeLessThan(NEXUS_OPENABLES_BUDGET_MS);
    } finally {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      await cdp.detach();
    }
  });
});
