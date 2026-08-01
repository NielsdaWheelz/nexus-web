import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  gotoSinglePaneWorkspace,
  gotoWithWorkspaceSession,
  makeWorkspacePane,
  makeWorkspaceState,
  makeWorkspaceVisit,
  workspaceE2eDeviceId,
  workspacePaneButton,
} from "./workspace";

const FIXED_DESTINATION_LABELS = [
  "Lectern",
  "Libraries",
  "Browse",
  "Podcasts",
  "Chats",
  "Notes",
  "Stats",
  "Atlas",
  "Oracle",
] as const;

interface SeededMedia {
  media_id: string;
}

function readSeededMedia(): SeededMedia {
  return JSON.parse(
    readFileSync(
      path.join(__dirname, "..", ".seed", "epub-media.json"),
      "utf-8",
    ),
  ) as SeededMedia;
}

function primaryNavigation(page: Page): Locator {
  return page.getByRole("navigation", { name: "Primary" });
}

async function expectSeparateHitTargets(
  left: Locator,
  right: Locator,
): Promise<void> {
  const leftBox = await left.boundingBox();
  const rightBox = await right.boundingBox();
  expect(leftBox, "Home must have a rendered hit target").not.toBeNull();
  expect(rightBox, "Expand must have a rendered hit target").not.toBeNull();
  if (!leftBox || !rightBox) {
    return;
  }
  const horizontalOverlap =
    Math.min(leftBox.x + leftBox.width, rightBox.x + rightBox.width) -
    Math.max(leftBox.x, rightBox.x);
  const verticalOverlap =
    Math.min(leftBox.y + leftBox.height, rightBox.y + rightBox.height) -
    Math.max(leftBox.y, rightBox.y);
  expect(
    horizontalOverlap <= 0 || verticalOverlap <= 0,
    `Home and Expand overlap: home=${JSON.stringify(leftBox)} expand=${JSON.stringify(rightBox)}`,
  ).toBe(true);
}

test.describe("app navigation", () => {
  test("desktop renders the fixed order and keeps Libraries active while reading", async ({
    page,
  }, testInfo) => {
    const media = readSeededMedia();
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-app-nav-reader"),
      `/media/${media.media_id}`,
    );

    const navigation = primaryNavigation(page);
    await expect(navigation).toBeVisible();
    await expect(navigation.getByRole("link")).toHaveCount(10);
    expect(
      await navigation
        .getByRole("link")
        .evaluateAll((links) =>
          links.map((link) => link.getAttribute("aria-label")),
        ),
    ).toEqual(["Nexus — Home", ...FIXED_DESTINATION_LABELS]);
    await expect(
      navigation.getByRole("link", { name: "Libraries" }),
    ).toHaveAttribute("aria-current", "page");
    await expect(navigation.getByText("Library", { exact: true })).toHaveCount(
      0,
    );
    await expect(navigation.getByText("Tools", { exact: true })).toHaveCount(0);
  });

  test("desktop navigation follows, restores, forks, and preserves native gestures", async ({
    page,
  }, testInfo) => {
    await gotoWithWorkspaceSession(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-app-nav-activation"),
      makeWorkspaceState(
        [
          makeWorkspacePane("pane-libraries", "/libraries"),
          makeWorkspacePane("pane-podcasts", "/podcasts", {
            visibility: "minimized",
          }),
        ],
        { activePrimaryPaneId: "pane-libraries" },
      ),
      "/libraries",
    );

    const navigation = primaryNavigation(page);
    const paneWraps = page.locator("[data-pane-id]");
    await expect(paneWraps).toHaveCount(2);
    await expect(
      workspacePaneButton(page, /^Podcasts\b.*Minimized\. Restore\./),
    ).toBeVisible();

    await navigation.getByRole("link", { name: "Podcasts" }).click();
    await expect(page).toHaveURL(/\/podcasts$/);
    await expect(paneWraps).toHaveCount(2);
    await expect(workspacePaneButton(page, /^Podcasts\b/)).toHaveAttribute(
      "aria-current",
      "page",
    );

    await navigation.getByRole("link", { name: "Libraries" }).click();
    await expect(page).toHaveURL(/\/libraries$/);
    await expect(paneWraps).toHaveCount(2);

    await navigation
      .getByRole("link", { name: "Libraries" })
      .click({ modifiers: ["Shift"] });
    await expect(paneWraps).toHaveCount(3);
    await expect(workspacePaneButton(page, /^Libraries\b/)).toHaveCount(2);

    const [nativePage] = await Promise.all([
      page.context().waitForEvent("page"),
      navigation
        .getByRole("link", { name: "Notes" })
        .click({ modifiers: ["ControlOrMeta"] }),
    ]);
    await nativePage.waitForURL(/\/notes$/, {
      waitUntil: "domcontentloaded",
    });
    await expect(page).toHaveURL(/\/libraries$/);
    await expect(paneWraps).toHaveCount(3);
    await nativePage.close();

    await page.getByRole("button", { name: "Collapse navigation" }).click();
    const home = navigation.getByRole("link", { name: "Nexus — Home" });
    const expand = page.getByRole("button", { name: "Expand navigation" });
    await expectSeparateHitTargets(home, expand);

    await home.click();
    await expect(page).toHaveURL(/\/lectern$/);
    await expect(paneWraps).toHaveCount(3);
    await expand.click();
    await expect(
      page.getByRole("button", { name: "Collapse navigation" }),
    ).toBeVisible();
  });
});

test.describe("mobile app navigation", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("renders pane-only chrome and routes every global job through Nexus", async ({
    page,
  }, testInfo) => {
    await gotoWithWorkspaceSession(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-app-nav-mobile"),
      makeWorkspaceState(
        [
          makeWorkspacePane("pane-libraries", "/libraries", {
            history: {
              back: [makeWorkspaceVisit("/notes")],
              forward: [makeWorkspaceVisit("/search")],
            },
          }),
          makeWorkspacePane("pane-podcasts", "/podcasts"),
        ],
        { activePrimaryPaneId: "pane-libraries" },
      ),
      "/libraries",
    );

    await expect(primaryNavigation(page)).toBeHidden();
    const activeMobilePane = page.locator('[data-pane-id][data-active="true"]');
    await expect(activeMobilePane).toHaveCount(1);
    await expect(activeMobilePane).toHaveAttribute("data-mobile", "true");
    await expect(
      page.getByRole("button", { name: "Go back" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Go forward" })).toHaveCount(
      0,
    );
    await page.getByRole("button", { name: "Pane options" }).tap();
    await expect(
      page.getByRole("menuitem", { name: "Go forward" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    await expect(page.getByRole("button", { name: /^Add/ })).toHaveCount(0);

    await page.getByRole("button", { name: "Open Nexus, 2 tabs" }).tap();
    const sheet = page.getByRole("dialog", { name: "Nexus" });
    await expect(
      sheet
        .getByRole("region", { name: "Quick Actions" })
        .getByRole("button", { name: "Today Place" }),
    ).toBeVisible();
    const places = sheet.getByRole("region", { name: "Places" });
    expect(
      await places
        .getByRole("button")
        .evaluateAll((buttons) =>
          buttons.map((button) =>
            button.innerText.replace(/\s+/g, " ").trim(),
          ),
        ),
    ).toEqual([
      "Lectern Place",
      "Libraries Place",
      "Browse Place",
      "Podcasts Place",
      "Chats Place",
      "Notes Place",
    ]);
    await expect(places.getByRole("button", { name: "Stats" })).toHaveCount(0);
    await expect(places.getByRole("button", { name: "Atlas" })).toHaveCount(0);
    await expect(places.getByRole("button", { name: "Oracle" })).toHaveCount(0);

    await places.getByRole("button", { name: "Chats" }).tap();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(/\/conversations$/);
    await expect(activeMobilePane).toHaveCount(1);
    await expect(activeMobilePane).toHaveAttribute("data-active", "true");
    await expect(activeMobilePane).toHaveAttribute("data-mobile", "true");
    await expect(
      page.getByRole("button", {
        name: "Open Nexus, 2 tabs",
      }),
    ).toBeVisible();
  });

  test("refreshes Libraries by pull or menu while cancelling non-refresh gestures", async ({
    page,
  }, testInfo) => {
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-app-nav-mobile-refresh"),
      "/libraries",
    );

    const pane = page.locator('[data-pane-id][data-active="true"]');
    const scrollport = pane.getByTestId("pane-shell-body");
    await expect(scrollport).toHaveAttribute(
      "data-pane-refresh-eligible",
      "true",
    );
    await scrollport.evaluate((node) => {
      node.scrollTop = 0;
    });
    const contentBefore = await scrollport.innerText();
    const urlBefore = page.url();
    const paneOptions = page.getByRole("button", { name: "Pane options" });
    await paneOptions.focus();
    await expect(paneOptions).toBeFocused();
    const box = await scrollport.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    const client = await page.context().newCDPSession(page);
    const x = Math.round(box.x + box.width / 2);
    const contentTopInset = await scrollport.evaluate((node) =>
      Number.parseFloat(getComputedStyle(node).paddingTop),
    );
    const startY = Math.round(
      box.y +
        Math.min(
          box.height - 200,
          Math.max(contentTopInset + 24, box.height / 4),
        ),
    );

    let refreshRequestCount = 0;
    let observeFirstRefresh!: () => void;
    let releaseFirstRefresh!: () => void;
    let observeSecondRefresh!: () => void;
    let releaseSecondRefresh!: () => void;
    const firstRefreshObserved = new Promise<void>((resolve) => {
      observeFirstRefresh = resolve;
    });
    const firstRefreshGate = new Promise<void>((resolve) => {
      releaseFirstRefresh = resolve;
    });
    const secondRefreshObserved = new Promise<void>((resolve) => {
      observeSecondRefresh = resolve;
    });
    const secondRefreshGate = new Promise<void>((resolve) => {
      releaseSecondRefresh = resolve;
    });
    await page.route(/\/api\/libraries(?:\?.*)?$/, async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      refreshRequestCount += 1;
      if (refreshRequestCount === 1) {
        observeFirstRefresh();
        await firstRefreshGate;
      } else if (refreshRequestCount === 2) {
        observeSecondRefresh();
        await secondRefreshGate;
      }
      await route.continue();
    });

    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x, y: startY, id: 10 },
        { x: x + 24, y: startY, id: 11 },
      ],
    });
    await expect(pane.getByTestId("pane-refresh-indicator")).toHaveAttribute(
      "data-refresh-state",
      "Idle",
    );
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });

    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y: startY, id: 1 }],
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: startY + 80, id: 1 }],
    });
    await expect(pane.getByTestId("pane-refresh-indicator")).toHaveAttribute(
      "data-refresh-state",
      "Pulling",
    );
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect(pane.getByTestId("pane-refresh-indicator")).toHaveAttribute(
      "data-refresh-state",
      "Idle",
    );

    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y: startY, id: 2 }],
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x + 100, y: startY + 20, id: 2 }],
    });
    await expect(pane.getByTestId("pane-refresh-indicator")).toHaveAttribute(
      "data-refresh-state",
      "Idle",
    );
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    expect(refreshRequestCount).toBe(0);
    await expect(paneOptions).toBeFocused();

    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y: startY, id: 3 }],
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: startY + 180, id: 3 }],
    });
    await expect(pane.getByTestId("pane-refresh-indicator")).toHaveAttribute(
      "data-refresh-state",
      "Armed",
    );
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });

    await firstRefreshObserved;
    const progress = pane.getByRole("progressbar", {
      name: "Refreshing 0 of 1",
    });
    await expect(progress).toBeAttached();
    await expect(progress).toHaveAttribute("aria-valuemin", "0");
    await expect(progress).toHaveAttribute("aria-valuenow", "0");
    await expect(progress).toHaveAttribute("aria-valuemax", "1");
    const liveRegion = pane.locator('[aria-live="polite"]');
    await expect(liveRegion).toHaveAttribute("aria-atomic", "true");
    await expect(liveRegion).toHaveText("");

    releaseFirstRefresh();
    await expect(liveRegion).toHaveText("Libraries refreshed");
    await expect(paneOptions).toBeFocused();

    await paneOptions.tap();
    const refreshOption = page.getByRole("menuitem", { name: "Refresh" });
    await expect(refreshOption).toBeVisible();
    await refreshOption.tap();
    await secondRefreshObserved;
    await expect(
      pane.getByRole("progressbar", { name: "Refreshing 0 of 1" }),
    ).toBeAttached();
    releaseSecondRefresh();
    await expect(liveRegion).toHaveText("Libraries refreshed");
    expect(refreshRequestCount).toBe(2);
    await expect(paneOptions).toBeFocused();

    expect(page.url()).toBe(urlBefore);
    expect(await scrollport.innerText()).toContain(contentBefore);
    expect(await scrollport.evaluate((node) => node.scrollTop)).toBe(0);
  });
});
