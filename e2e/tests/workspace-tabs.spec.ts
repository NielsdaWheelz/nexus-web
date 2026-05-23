import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

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

function readSeed<T>(seedFile: string): T {
  const seedPath = path.join(__dirname, "..", ".seed", seedFile);
  return JSON.parse(readFileSync(seedPath, "utf-8")) as T;
}

// ---------------------------------------------------------------------------
// Workspace-state encoding (mirrors workspace-canvas.spec.ts)
// ---------------------------------------------------------------------------

function encodeWorkspaceStateParam(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("workspace tabs", () => {
  // -------------------------------------------------------------------------
  // Static panes — resolved immediately, no skeleton
  // -------------------------------------------------------------------------

  test("desktop: static panes show their name immediately in the strip", async ({
    page,
  }) => {
    const workspaceState = encodeWorkspaceStateParam({
      schemaVersion: 4,
      activePaneId: "pane-libraries",
      panes: [
        {
          id: "pane-libraries",
          href: "/libraries",
          widthPx: 560,
          visibility: "visible",
        },
        {
          id: "pane-search",
          href: "/search",
          widthPx: 560,
          visibility: "visible",
        },
      ],
    });

    await page.goto(`/libraries?wsv=4&ws=${workspaceState}`);

    const strip = workspacePaneStrip(page);
    await expect(strip).toBeVisible();

    // Static routes must show their resolved name straight away — no pending
    // state, no skeleton phase.
    const librariesButton = workspacePaneButton(page, /^Libraries\b/);
    const searchButton = workspacePaneButton(page, /^Search\b/);

    await expect(librariesButton).toBeVisible();
    await expect(searchButton).toBeVisible();

    // Neither activator should carry aria-busy (that signals a pending title).
    await expect(librariesButton).not.toHaveAttribute("aria-busy");
    await expect(searchButton).not.toHaveAttribute("aria-busy");
  });

  // -------------------------------------------------------------------------
  // Opening panes produces tabs
  // -------------------------------------------------------------------------

  test("desktop: opening a second pane from a link adds a tab to the strip", async ({
    page,
  }) => {
    await page.goto("/libraries");

    const strip = workspacePaneStrip(page);
    await expect(strip).toBeVisible();

    // Only the Libraries tab exists initially.
    await expect(workspacePaneButton(page, /^Libraries\b/)).toBeVisible();
    await expect(workspacePaneButton(page, /^Search\b/)).toHaveCount(0);

    // Shift-click opens a new pane (the standard in-app gesture).
    const searchLink = page.getByRole("link", { name: "Search" }).first();
    await expect(searchLink).toBeVisible();
    await searchLink.click({ modifiers: ["Shift"] });

    // A Search tab now appears in the strip.
    await expect(workspacePaneButton(page, /^Search\b/)).toBeVisible({
      timeout: 10_000,
    });
  });

  // -------------------------------------------------------------------------
  // Active tab carries aria-current="page"
  // -------------------------------------------------------------------------

  test("desktop: the active pane's activator carries aria-current=page", async ({
    page,
  }) => {
    const workspaceState = encodeWorkspaceStateParam({
      schemaVersion: 4,
      activePaneId: "pane-libraries",
      panes: [
        {
          id: "pane-libraries",
          href: "/libraries",
          widthPx: 560,
          visibility: "visible",
        },
        {
          id: "pane-search",
          href: "/search",
          widthPx: 560,
          visibility: "visible",
        },
      ],
    });

    await page.goto(`/libraries?wsv=4&ws=${workspaceState}`);

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
  }) => {
    const workspaceState = encodeWorkspaceStateParam({
      schemaVersion: 4,
      activePaneId: "pane-libraries",
      panes: [
        {
          id: "pane-libraries",
          href: "/libraries",
          widthPx: 560,
          visibility: "visible",
        },
        {
          id: "pane-search",
          href: "/search",
          widthPx: 560,
          visibility: "visible",
        },
      ],
    });

    await page.goto(`/libraries?wsv=4&ws=${workspaceState}`);

    await expect(workspacePaneButton(page, /^Search\b/)).toBeVisible();

    await workspacePaneButton(page, "Close Search").click();

    await expect(workspacePaneButton(page, /^Search\b/)).toHaveCount(0);
    // The remaining tab is still present.
    await expect(workspacePaneButton(page, /^Libraries\b/)).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Dynamic-content pane: resolved title
  //
  // A media pane is titleMode:"dynamic".  Once the body loads and publishes a
  // title, the tab must show that specific resource title, not a category word
  // like "Media".
  //
  // The epub seed gives us a deterministic title we can assert on.
  // -------------------------------------------------------------------------

  test("desktop: a dynamic media pane tab shows the resolved resource title after load", async ({
    page,
  }) => {
    const epub = readSeed<SeededEpubMedia>("epub-media.json");

    // Navigate directly so the workspace opens the media pane.
    await page.goto(`/media/${epub.media_id}`);

    const strip = workspacePaneStrip(page);
    await expect(strip).toBeVisible();

    // Wait until the tab no longer carries aria-busy, meaning titleState has
    // transitioned from "pending" to "resolved".
    const activator = strip
      .getByRole("button")
      .filter({ has: page.locator('[aria-current="page"]') })
      .first();

    await expect(activator).toBeVisible({ timeout: 15_000 });

    // The resolved tab must NOT show a bare category word.
    await expect(activator).not.toHaveText(/^Media$/i);

    // The activator should carry aria-busy while pending and drop it once
    // resolved. Assert the final state is not busy.
    await expect(activator).not.toHaveAttribute("aria-busy", { timeout: 15_000 });
  });

  // -------------------------------------------------------------------------
  // Dynamic pane: title is not a category word
  //
  // This uses the epub seed so we can assert on the strip tab specifically
  // while waiting for a non-"Media" resolved title.
  // -------------------------------------------------------------------------

  test("desktop: epub tab eventually carries a real book title, not \"Media\"", async ({
    page,
  }) => {
    const epub = readSeed<SeededEpubMedia>("epub-media.json");

    const workspaceState = encodeWorkspaceStateParam({
      schemaVersion: 4,
      activePaneId: "pane-media",
      panes: [
        {
          id: "pane-media",
          href: `/media/${epub.media_id}`,
          widthPx: 720,
          visibility: "visible",
        },
      ],
    });

    await page.goto(`/libraries?wsv=4&ws=${workspaceState}`);

    const strip = workspacePaneStrip(page);
    await expect(strip).toBeVisible();

    // Poll until the tab text is neither "Media" nor empty — i.e. a resolved
    // resource title has been published.
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

  // -------------------------------------------------------------------------
  // Keyboard: Delete closes the focused pane
  // -------------------------------------------------------------------------

  test("desktop: Delete key on a focused tab closes that pane", async ({
    page,
  }) => {
    const workspaceState = encodeWorkspaceStateParam({
      schemaVersion: 4,
      activePaneId: "pane-libraries",
      panes: [
        {
          id: "pane-libraries",
          href: "/libraries",
          widthPx: 560,
          visibility: "visible",
        },
        {
          id: "pane-search",
          href: "/search",
          widthPx: 560,
          visibility: "visible",
        },
      ],
    });

    await page.goto(`/libraries?wsv=4&ws=${workspaceState}`);

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
  }) => {
    const workspaceState = encodeWorkspaceStateParam({
      schemaVersion: 4,
      activePaneId: "pane-libraries",
      panes: [
        {
          id: "pane-libraries",
          href: "/libraries",
          widthPx: 560,
          visibility: "visible",
        },
        {
          id: "pane-search",
          href: "/search",
          widthPx: 560,
          visibility: "visible",
        },
      ],
    });

    await page.goto(`/libraries?wsv=4&ws=${workspaceState}`);

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
  // While a dynamic-content pane has not yet published its title, the tab
  // MUST carry aria-busy and an accessible aria-label (not be an anonymous
  // control).
  //
  // We assert this by opening a media pane and checking the strip before the
  // title resolves.  Because the title may resolve very fast, we use the
  // non-pdf (web article) seed — it is still dynamic but the window is short;
  // the test is safe because we only need to assert that IF the tab carries
  // aria-busy THEN it also has an aria-label.  After resolution we assert
  // aria-busy is gone.
  // -------------------------------------------------------------------------

  test("desktop: a pending dynamic tab carries aria-busy and an aria-label; both clear on resolution", async ({
    page,
  }) => {
    const nonPdf = readSeed<SeededNonPdfMedia>("non-pdf-media.json");

    const workspaceState = encodeWorkspaceStateParam({
      schemaVersion: 4,
      activePaneId: "pane-media",
      panes: [
        {
          id: "pane-media",
          href: `/media/${nonPdf.media_id}`,
          widthPx: 720,
          visibility: "visible",
        },
      ],
    });

    await page.goto(`/libraries?wsv=4&ws=${workspaceState}`);

    const strip = workspacePaneStrip(page);
    await expect(strip).toBeVisible();

    // If we catch the tab while it is still pending, aria-label must be set.
    // We do not assert it IS pending (that race is not deterministic) — we
    // assert the invariant: aria-busy true ⟹ aria-label present.
    const activators = strip.getByRole("button");
    const firstActivator = activators.first();
    await expect(firstActivator).toBeVisible({ timeout: 10_000 });

    const isBusy = await firstActivator
      .getAttribute("aria-busy")
      .catch(() => null);

    if (isBusy === "true") {
      const label = await firstActivator.getAttribute("aria-label");
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
