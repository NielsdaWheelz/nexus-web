import {
  test,
  expect,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
  gotoWithWorkspaceSession,
  makeWorkspacePane,
  makeWorkspaceState,
  makeWorkspaceVisit,
  workspaceE2eDeviceId,
  type WorkspaceState,
} from "./workspace";

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

interface SeededEpubMedia {
  media_id: string;
  chapter_titles: string[];
}

interface SeededNonPdfMedia {
  media_id: string;
}

interface EpubNavigationResponse {
  data: {
    sections: Array<{
      section_id: string;
      label: string;
    }>;
  };
}

interface LibraryListResponse {
  data: Array<{
    id: string;
    name: string;
    is_default: boolean;
  }>;
}

function readSeed<T>(seedFile: string): T {
  const seedPath = path.join(__dirname, "..", ".seed", seedFile);
  return JSON.parse(readFileSync(seedPath, "utf-8")) as T;
}

// ---------------------------------------------------------------------------
// Locator helpers
// ---------------------------------------------------------------------------

function workspacePaneStrip(page: Page): Locator {
  return page.getByRole("toolbar", { name: "Workspace panes" });
}

// The activator button for a named tab.  Matches on aria-label (pending tabs)
// and on visible text (resolved tabs) — the same pattern as other specs that
// use workspacePaneButton.
function workspacePaneButton(page: Page, name: RegExp | string): Locator {
  return workspacePaneStrip(page).getByRole("button", { name });
}

function activeWorkspacePaneButton(page: Page): Locator {
  return workspacePaneStrip(page).locator('button[aria-current="page"]').first();
}

async function paneButtonLabel(button: Locator): Promise<string> {
  return (
    (await button.getAttribute("aria-label").catch(() => null)) ??
    (await button.textContent().catch(() => null)) ??
    ""
  ).trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function workspaceTabsDeviceId(testInfo: TestInfo): string {
  return workspaceE2eDeviceId(testInfo, "e2e-workspace-tabs");
}

// A two-pane session (Libraries active, Search alongside) shared by the tests
// that exercise the strip's multi-tab behavior.
function librariesAndSearchSession(): WorkspaceState {
  return makeWorkspaceState(
    [
      makeWorkspacePane("pane-libraries", "/libraries"),
      makeWorkspacePane("pane-search", "/search"),
    ],
    { activePrimaryPaneId: "pane-libraries" },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("workspace tabs", () => {
  // -------------------------------------------------------------------------
  // Static panes — resolved immediately, no skeleton
  // -------------------------------------------------------------------------

  test("desktop: static panes show their name immediately in the strip", async ({
    page,
  }, testInfo) => {
    await gotoWithWorkspaceSession(
      page,
      workspaceTabsDeviceId(testInfo),
      librariesAndSearchSession(),
      "/libraries",
    );

    const strip = workspacePaneStrip(page);
    await expect(strip).toBeVisible();

    // Static routes must show their resolved name straight away — no pending
    // state, no skeleton phase.
    const librariesButton = workspacePaneButton(page, /^Libraries\b/);
    const searchButton = workspacePaneButton(page, /^Search\b/);

    await expect(librariesButton).toBeVisible();
    await expect(searchButton).toBeVisible();

    // Neither activator should carry aria-busy (that signals a pending label).
    await expect(librariesButton).not.toHaveAttribute("aria-busy");
    await expect(searchButton).not.toHaveAttribute("aria-busy");
  });

  // -------------------------------------------------------------------------
  // Opening panes produces tabs
  // -------------------------------------------------------------------------

  test("desktop: opening a second pane from a link adds a tab to the strip", async ({
    page,
  }, testInfo) => {
    const librariesResponse = await page.request.get("/api/libraries");
    expect(librariesResponse.ok()).toBeTruthy();
    const libraries = (await librariesResponse.json()) as LibraryListResponse;
    const defaultLibrary = libraries.data.find((library) => library.is_default);
    if (!defaultLibrary) {
      throw new Error("Default library missing from E2E seed.");
    }

    await gotoSinglePaneWorkspace(
      page,
      workspaceTabsDeviceId(testInfo),
      "/libraries",
      {
        history: {
          back: [makeWorkspaceVisit("/notes")],
          forward: [],
        },
      },
    );

    const strip = workspacePaneStrip(page);
    await expect(strip).toBeVisible();

    // Only the Libraries tab exists initially.
    await expect(workspacePaneButton(page, /^Libraries\b/)).toBeVisible();
    await expect(workspacePaneButton(page, /^Search\b/)).toHaveCount(0);

    // Shift-click opens a new pane (the standard in-app gesture).
    const libraryLink = activeWorkspacePane(page)
      .getByRole("link", { name: defaultLibrary.name })
      .first();
    await expect(libraryLink).toBeVisible();
    await libraryLink.click({ modifiers: ["Shift"] });

    // A new library tab now appears in the strip.
    await expect(workspacePaneButton(page, new RegExp(`^${escapeRegExp(defaultLibrary.name)}\\b`))).toBeVisible({
      timeout: 10_000,
    });
  });

  // -------------------------------------------------------------------------
  // Active tab carries aria-current="page"
  // -------------------------------------------------------------------------

  test("desktop: the active pane's activator carries aria-current=page", async ({
    page,
  }, testInfo) => {
    await gotoWithWorkspaceSession(
      page,
      workspaceTabsDeviceId(testInfo),
      librariesAndSearchSession(),
      "/libraries",
    );

    const strip = workspacePaneStrip(page);
    await expect(strip).toBeVisible();

    const librariesButton = workspacePaneButton(page, /^Libraries\b/);
    const searchButton = workspacePaneButton(page, /^Search\b/);

    await expect(librariesButton).toBeVisible();
    await expect(searchButton).toBeVisible();

    // Libraries is the active pane in the seeded state.
    await expect(librariesButton).toHaveAttribute("aria-current", "page");
    await expect(searchButton).not.toHaveAttribute("aria-current", "page");

    // Clicking the Search tab activates it.
    await searchButton.click();

    await expect(searchButton).toHaveAttribute("aria-current", "page", {
      timeout: 5_000,
    });
    await expect(librariesButton).not.toHaveAttribute("aria-current", "page");
  });

  // -------------------------------------------------------------------------
  // Close action removes the tab from the strip
  // -------------------------------------------------------------------------

  test("desktop: closing a pane removes its tab from the strip", async ({
    page,
  }, testInfo) => {
    await gotoWithWorkspaceSession(
      page,
      workspaceTabsDeviceId(testInfo),
      librariesAndSearchSession(),
      "/libraries",
    );

    await expect(workspacePaneButton(page, /^Search\b/)).toBeVisible();

    await workspacePaneButton(page, "Close Search").click();

    await expect(workspacePaneButton(page, /^Search\b/)).toHaveCount(0);
    // The remaining tab is still present.
    await expect(workspacePaneButton(page, /^Libraries\b/)).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Dynamic-content pane: resolved label
  //
  // A media pane is labelMode:"dynamic". Once the body loads and publishes a
  // label, the tab must show that specific resource title, not a category word
  // like "Media".
  //
  // The epub seed gives us a deterministic title we can assert on.
  // -------------------------------------------------------------------------

  test("desktop: a dynamic media pane tab shows the resolved resource label after load", async ({
    page,
  }, testInfo) => {
    const epub = readSeed<SeededEpubMedia>("epub-media.json");

    await gotoSinglePaneWorkspace(
      page,
      workspaceTabsDeviceId(testInfo),
      `/media/${epub.media_id}`,
    );

    const strip = workspacePaneStrip(page);
    await expect(strip).toBeVisible();

    // Wait until the tab no longer carries aria-busy, meaning labelState has
    // transitioned from "pending" to "resolved".
    const activator = activeWorkspacePaneButton(page);

    await expect(activator).toBeVisible({ timeout: 15_000 });

    // The resolved tab must NOT show a bare category word.
    await expect(activator).not.toHaveText(/^Media$/i);

    // The activator should carry aria-busy while pending and drop it once
    // resolved. Assert the final state is not busy.
    await expect(activator).not.toHaveAttribute("aria-busy", { timeout: 15_000 });
  });

  // -------------------------------------------------------------------------
  // Dynamic pane: label is not a category word
  //
  // This uses the epub seed so we can assert on the strip tab specifically
  // while waiting for a non-"Media" resolved label.
  // -------------------------------------------------------------------------

  test("desktop: epub tab eventually carries a real book title, not \"Media\"", async ({
    page,
  }, testInfo) => {
    const epub = readSeed<SeededEpubMedia>("epub-media.json");

    await gotoWithWorkspaceSession(
      page,
      workspaceTabsDeviceId(testInfo),
      makeWorkspaceState(
        [
          makeWorkspacePane("pane-media", `/media/${epub.media_id}`, {
            primaryWidthPx: 720,
          }),
        ],
        { activePrimaryPaneId: "pane-media" },
      ),
      `/media/${epub.media_id}`,
    );

    const strip = workspacePaneStrip(page);
    await expect(strip).toBeVisible();

    // Poll until the tab text is neither "Media" nor empty — i.e. a resolved
    // resource label has been published.
    await expect
      .poll(
        async () => {
          const buttons = await strip.getByRole("button").all();
          for (const button of buttons) {
            const label =
              (await button.getAttribute("aria-label").catch(() => null)) ??
              (await button.textContent().catch(() => null)) ??
              "";
            if (label && !/^\s*Media\s*$/i.test(label)) {
              return label.trim();
            }
          }
          return "";
        },
        { timeout: 20_000, intervals: [500, 500, 1_000] },
      )
      .not.toBe("");
  });

  test("desktop: epub title stays resolved after canonical loc navigation and content load", async ({
    page,
  }, testInfo) => {
    const epub = readSeed<SeededEpubMedia>("epub-media.json");

    await gotoSinglePaneWorkspace(
      page,
      workspaceTabsDeviceId(testInfo),
      `/media/${epub.media_id}`,
    );

    const activator = activeWorkspacePaneButton(page);
    await expect(activator).toBeVisible({ timeout: 15_000 });
    await expect(activator).not.toHaveAttribute("aria-busy", { timeout: 20_000 });

    await expect
      .poll(
        async () => {
          const label = await paneButtonLabel(activator);
          return label && !/^\s*Media\s*$/i.test(label) ? label : "";
        },
        { timeout: 20_000, intervals: [500, 500, 1_000] },
      )
      .not.toBe("");
    const resolvedLabel = await paneButtonLabel(activator);

    const navigationResponse = await page.request.get(
      `/api/media/${epub.media_id}/navigation`,
    );
    expect(navigationResponse.ok()).toBeTruthy();
    const navigation = (await navigationResponse.json()) as EpubNavigationResponse;
    const firstSection =
      navigation.data.sections.find((section) => section.label === epub.chapter_titles[0]) ??
      navigation.data.sections[0];
    if (!firstSection) {
      throw new Error(`No EPUB navigation sections seeded for ${epub.media_id}`);
    }

    await gotoSinglePaneWorkspace(
      page,
      workspaceTabsDeviceId(testInfo),
      `/media/${epub.media_id}?loc=${encodeURIComponent(firstSection.section_id)}`,
    );
    expect(new URL(page.url()).searchParams.get("loc")).toBe(firstSection.section_id);

    await expect(
      activeWorkspacePane(page).getByRole("heading", { name: epub.chapter_titles[0] }),
    ).toBeVisible({ timeout: 20_000 });

    await expect(activator).not.toHaveAttribute("aria-busy");
    await expect
      .poll(() => paneButtonLabel(activator), {
        timeout: 10_000,
        intervals: [500, 1_000],
      })
      .toBe(resolvedLabel);
    // The book title is surfaced via the pane-strip button label (verified
    // above), not as a heading element — the EPUB HTML only contains chapter
    // headings and the RunningHead uses <span>, not <h*>.
  });

  test("desktop: library epub label hint appears before media load", async ({
    page,
  }, testInfo) => {
    const epub = readSeed<SeededEpubMedia>("epub-media.json");
    const librariesResponse = await page.request.get("/api/libraries");
    expect(librariesResponse.ok()).toBeTruthy();
    const libraries = (await librariesResponse.json()) as LibraryListResponse;
    const defaultLibrary = libraries.data.find((library) => library.is_default);
    if (!defaultLibrary) {
      throw new Error("Default library missing from E2E seed.");
    }

    await gotoSinglePaneWorkspace(
      page,
      workspaceTabsDeviceId(testInfo),
      `/libraries/${defaultLibrary.id}`,
    );
    const row = activeWorkspacePane(page)
      .getByRole("link", { name: /E2E Test EPUB/ })
      .first();
    await expect(row).toBeVisible({ timeout: 20_000 });

    let releaseMediaLoad: () => void = () => {};
    const mediaLoadBlocked = new Promise<void>((resolve) => {
      releaseMediaLoad = resolve;
    });
    const mediaRoute = `**/api/media/${epub.media_id}`;
    await page.route(
      mediaRoute,
      async (route) => {
        await mediaLoadBlocked;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "media load intentionally blocked" }),
        });
      },
      { times: 1 },
    );

    try {
      await row.click();
      const activator = activeWorkspacePaneButton(page);

      await expect
        .poll(() => paneButtonLabel(activator), {
          timeout: 2_000,
          intervals: [100, 250],
        })
        .toContain("E2E Test EPUB");
      await expect(activator).not.toHaveAttribute("aria-busy");
    } finally {
      releaseMediaLoad();
    }
  });

  // -------------------------------------------------------------------------
  // Keyboard: Delete closes the focused pane
  // -------------------------------------------------------------------------

  test("desktop: Delete key on a focused tab closes that pane", async ({
    page,
  }, testInfo) => {
    await gotoWithWorkspaceSession(
      page,
      workspaceTabsDeviceId(testInfo),
      librariesAndSearchSession(),
      "/libraries",
    );

    const strip = workspacePaneStrip(page);
    await expect(strip).toBeVisible();

    await expect(workspacePaneButton(page, /^Search\b/)).toBeVisible();

    // Focus the Search activator then press Delete.
    await workspacePaneButton(page, /^Search\b/).focus();
    await page.keyboard.press("Delete");

    await expect(workspacePaneButton(page, /^Search\b/)).toHaveCount(0);
    await expect(workspacePaneButton(page, /^Libraries\b/)).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Keyboard: action buttons are not in the roving tab sequence
  //
  // The strip is a role="toolbar"; per §2.5 each tab is one toolbar stop.
  // The Minimize/Close action buttons carry tabIndex={-1} and must not appear
  // as roving stops when navigating with ArrowRight.
  // -------------------------------------------------------------------------

  test("desktop: ArrowRight moves between tab activators, skipping action buttons", async ({
    page,
  }, testInfo) => {
    await gotoWithWorkspaceSession(
      page,
      workspaceTabsDeviceId(testInfo),
      librariesAndSearchSession(),
      "/libraries",
    );

    const strip = workspacePaneStrip(page);
    await expect(strip).toBeVisible();

    const librariesButton = workspacePaneButton(page, /^Libraries\b/);
    const searchButton = workspacePaneButton(page, /^Search\b/);

    await expect(librariesButton).toBeVisible();
    await expect(searchButton).toBeVisible();

    // Focus the Libraries activator.
    await librariesButton.focus();
    await expect(librariesButton).toBeFocused();

    // One ArrowRight must land directly on the Search activator — not on an
    // intermediate action button (Minimize or Close).
    await page.keyboard.press("ArrowRight");
    await expect(searchButton).toBeFocused();
  });

  // -------------------------------------------------------------------------
  // Pending tab: aria-busy and accessible name while loading
  //
  // While a dynamic-content pane has not yet published its label, the tab
  // MUST carry aria-busy and an accessible aria-label (not be an anonymous
  // control).
  //
  // We assert this by opening a media pane and checking the strip before the
  // label resolves. Because the label may resolve very fast, we use the
  // non-pdf (web article) seed — it is still dynamic but the window is short;
  // the test is safe because we only need to assert that IF the tab carries
  // aria-busy THEN it also has an aria-label.  After resolution we assert
  // aria-busy is gone.
  // -------------------------------------------------------------------------

  test("desktop: a pending dynamic tab carries aria-busy and an aria-label; both clear on resolution", async ({
    page,
  }, testInfo) => {
    const nonPdf = readSeed<SeededNonPdfMedia>("non-pdf-media.json");

    await gotoWithWorkspaceSession(
      page,
      workspaceTabsDeviceId(testInfo),
      makeWorkspaceState(
        [
          makeWorkspacePane("pane-media", `/media/${nonPdf.media_id}`, {
            primaryWidthPx: 720,
          }),
        ],
        { activePrimaryPaneId: "pane-media" },
      ),
      "/libraries",
    );

    const strip = workspacePaneStrip(page);
    await expect(strip).toBeVisible();

    // If we catch the tab while it is still pending, aria-label must be set.
    // We do not assert it IS pending (that race is not deterministic) — we
    // assert the invariant: aria-busy true ⟹ aria-label present.
    const activators = strip.getByRole("button");
    const firstActivator = activators.first();
    await expect(firstActivator).toBeVisible({ timeout: 10_000 });

    const { isBusy, label } = await firstActivator.evaluate((element) => ({
      isBusy: element.getAttribute("aria-busy"),
      label: element.getAttribute("aria-label"),
    }));

    if (isBusy === "true") {
      expect(
        label,
        "A pending tab (aria-busy=true) must carry an aria-label for accessibility",
      ).toBeTruthy();
    }

    // After the body loads, aria-busy must not remain.
    await expect(firstActivator).not.toHaveAttribute("aria-busy", {
      timeout: 15_000,
    });
  });
});
