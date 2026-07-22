import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  gotoSinglePaneWorkspace,
  gotoWithWorkspaceSession,
  makeWorkspacePane,
  makeWorkspaceState,
  workspaceE2eDeviceId,
  workspacePaneButton,
} from "./workspace";

const FIXED_DESTINATION_LABELS = [
  "Lectern",
  "Libraries",
  "Podcasts",
  "Chats",
  "Notes",
  "Atlas",
  "Oracle",
] as const;

interface SeededMedia {
  media_id: string;
}

function readSeededMedia(): SeededMedia {
  return JSON.parse(
    readFileSync(path.join(__dirname, "..", ".seed", "epub-media.json"), "utf-8"),
  ) as SeededMedia;
}

function primaryNavigation(page: Page): Locator {
  return page.getByRole("navigation", { name: "Primary" });
}

async function expectSeparateHitTargets(left: Locator, right: Locator): Promise<void> {
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
    await expect(navigation.getByRole("link")).toHaveCount(8);
    expect(
      await navigation.getByRole("link").evaluateAll((links) =>
        links.map((link) => link.getAttribute("aria-label")),
      ),
    ).toEqual(["Nexus — Home", ...FIXED_DESTINATION_LABELS]);
    await expect(navigation.getByRole("link", { name: "Libraries" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(navigation.getByText("Library", { exact: true })).toHaveCount(0);
    await expect(navigation.getByText("Tools", { exact: true })).toHaveCount(0);
  });

  test("desktop navigation restores exact panes, preserves native gestures, and separates Home from Expand", async ({
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
    await expect(workspacePaneButton(page, /^Podcasts\b.*Minimized\. Restore\./)).toBeVisible();

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

    const [nativePage] = await Promise.all([
      page.context().waitForEvent("page"),
      navigation.getByRole("link", { name: "Notes" }).click({ modifiers: ["Control"] }),
    ]);
    await nativePage.waitForLoadState("domcontentloaded");
    await expect(nativePage).toHaveURL(/\/notes$/);
    await expect(page).toHaveURL(/\/libraries$/);
    await expect(paneWraps).toHaveCount(2);
    await nativePage.close();

    await page.getByRole("button", { name: "Collapse navigation" }).click();
    const home = navigation.getByRole("link", { name: "Nexus — Home" });
    const expand = page.getByRole("button", { name: "Expand navigation" });
    await expectSeparateHitTargets(home, expand);

    await home.click();
    await expect(page).toHaveURL(/\/lectern$/);
    await expect(paneWraps).toHaveCount(3);
    await expand.click();
    await expect(page.getByRole("button", { name: "Collapse navigation" })).toBeVisible();
  });
});

test.describe("mobile app navigation", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("projects the desktop destination order and pane activation contract", async ({
    page,
  }, testInfo) => {
    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-app-nav-mobile"),
      "/libraries",
    );

    await page.getByRole("button", { name: "Open navigation" }).click();
    const sheet = page.getByRole("dialog", { name: "Navigation" });
    await expect(sheet).toBeVisible();
    expect(
      await sheet.getByRole("link").evaluateAll((links) =>
        links.map((link) => link.textContent?.trim()),
      ),
    ).toEqual(["Nexus", ...FIXED_DESTINATION_LABELS, "Settings"]);
    await expect(sheet.getByRole("link", { name: "Libraries" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await sheet.getByRole("link", { name: "Chats" }).click();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(/\/conversations$/);
    await expect(page.locator("[data-pane-id]")).toHaveCount(2);
  });
});
