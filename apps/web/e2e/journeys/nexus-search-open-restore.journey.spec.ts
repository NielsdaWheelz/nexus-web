import { randomUUID } from "node:crypto";
import type { Page } from "playwright/test";
import {
  expect,
  gotoWithStrictCsp,
  signIn,
  test,
  webOrigin,
} from "../fixtures";
import { pageRequest } from "../request";

test.use({ journeyId: "nexus-search-open-restore" });

// A "no other pane may write the browser title" claim needs an observation
// window. This one is bounded to ~30 committed frames and samples real state
// every frame; it never sleeps and never waits for a deadline to pass.
const TITLE_OBSERVATION_FRAMES = 30;

interface WorkspacePane {
  id: string;
  currentVisit: { id: string; href: string };
  primaryWidthPx: number;
  visibility: "visible";
  history: { back: []; forward: [] };
  attachedSecondaryPaneId: null;
}

interface WorkspaceState {
  activePrimaryPaneId: string;
  primaryPaneOrder: string[];
  primaryPanesById: Record<string, WorkspacePane>;
  secondaryPanesById: Record<string, never>;
}

function workspaceState(): WorkspaceState {
  const pane = (href: string): WorkspacePane => {
    const id = `pane-${randomUUID()}`;
    return {
      id,
      currentVisit: { id: randomUUID(), href },
      primaryWidthPx: 560,
      visibility: "visible",
      history: { back: [], forward: [] },
      attachedSecondaryPaneId: null,
    };
  };
  const notes = pane("/notes");
  const search = pane("/search");
  return {
    activePrimaryPaneId: notes.id,
    primaryPaneOrder: [notes.id, search.id],
    primaryPanesById: { [notes.id]: notes, [search.id]: search },
    secondaryPanesById: {},
  };
}

function workspacePaneButton(page: Page, name: RegExp) {
  return page
    .getByRole("toolbar", { name: "Workspace panes" })
    .getByRole("button", { name });
}

/** Every distinct browser title committed across a bounded window of frames. */
async function observedDocumentTitles(
  page: Page,
  frames: number,
): Promise<string[]> {
  return page.evaluate(async (count) => {
    const observed: string[] = [];
    for (let frame = 0; frame < count; frame += 1) {
      if (observed[observed.length - 1] !== document.title) {
        observed.push(document.title);
      }
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    }
    return observed;
  }, frames);
}

/**
 * The accessible name of the focused pane landmark, or a description of the
 * element that actually holds focus so a failure names where focus escaped to.
 */
async function focusedPaneLandmarkName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement)) {
      return "focus is on no element";
    }
    if (focused.dataset.paneFocusLandmark !== "true") {
      const identity = focused
        .getAttributeNames()
        .filter((name) => name.startsWith("data-"))
        .sort()
        .join(" ");
      return `focus is on <${focused.tagName.toLowerCase()} ${identity}>, which is not a pane landmark`;
    }
    return (focused.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .filter((id) => id.length > 0)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  });
}

test("Nexus finds and opens a place whose workspace survives a fresh document", async ({
  page,
  journeyUser,
}) => {
  await signIn(page, journeyUser);
  const deviceId = `nexus-test-${randomUUID()}`;
  await page.context().addCookies([
    {
      name: "nx_device",
      value: deviceId,
      url: webOrigin,
      httpOnly: true,
      sameSite: "Lax",
      secure: false,
    },
  ]);
  const api = pageRequest(page, webOrigin);
  const seedResponse = await api.put("/api/me/workspace-session", {
    headers: { origin: webOrigin },
    data: { state: workspaceState() },
  });
  expect(
    seedResponse.ok(),
    `Workspace seed failed at the BFF boundary: ${seedResponse.status()} ${await seedResponse.text()}`,
  ).toBeTruthy();

  await gotoWithStrictCsp(page, "/");
  await expect(workspacePaneButton(page, /^Notes\b/)).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(workspacePaneButton(page, /^Search\b/)).toBeVisible();
  await expect(page).toHaveURL(/\/notes$/);

  await expect(
    page,
    `Restored workspace for device ${deviceId} did not project its active Notes pane as the browser title "Notes · Nexus".`,
  ).toHaveTitle("Notes · Nexus", { timeout: 15_000 });

  // Losing the title to a late metadata write is a race, so watching frames
  // only catches it on a slow enough machine. The served document is the
  // deterministic half of the same claim: the workspace renders the title it
  // owns, so the document ends at the active pane's identity. Assigning the
  // title imperatively instead leaves only the inherited metadata title here —
  // the very element whose re-application after hydration renamed the tab.
  const restoredDocument = await (await api.get("/notes")).text();
  const restoredTitles = [
    ...restoredDocument.matchAll(/<title[^>]*>([^<]*)<\/title>/g),
  ].map((match) => match[1]);
  expect(
    restoredTitles.at(-1),
    `The document the server sends device ${deviceId} must end at the active pane's title, not at an app-name title element that outlives it. Received ${JSON.stringify(restoredTitles)}.`,
  ).toBe("Notes · Nexus");

  await expect(
    page.getByRole("region", { name: "Search", exact: true }),
    `Device ${deviceId} did not mount its inactive Search pane, so the browser-title race with the active Notes pane could not be observed.`,
  ).toBeVisible({ timeout: 15_000 });
  expect(
    await observedDocumentTitles(page, TITLE_OBSERVATION_FRAMES),
    `Across ${TITLE_OBSERVATION_FRAMES} frames the browser title for device ${deviceId} must stay exactly "Notes · Nexus": only the active pane may write it, and the visible but inactive Search pane must never race it.`,
  ).toEqual(["Notes · Nexus"]);

  await page
    .getByRole("button", { name: "Search or ask anything" })
    .click();
  const nexus = page.getByRole("dialog", { name: "Nexus" });
  const input = nexus.getByRole("combobox", { name: "Find anything" });
  await expect(input).toBeFocused();
  await input.fill("stats");
  const stats = nexus.getByRole("gridcell", { name: /^Stats\b/ });
  await expect(
    stats,
    `Nexus did not project the canonical Stats place for workspace device ${deviceId}.`,
  ).toBeVisible();
  await stats.click();
  await expect(
    page,
    `Nexus did not immediately project the opened Stats place into its canonical URL for device ${deviceId}.`,
  ).toHaveURL((url) => {
    const params = url.searchParams;
    return (
      url.pathname === "/stats" &&
      params.get("view") === "stats" &&
      params.get("period") === "day" &&
      /^\d{4}-\d{2}-\d{2}$/.test(params.get("anchor") ?? "") &&
      [...params.keys()].sort().join(",") === "anchor,period,view"
    );
  });
  const statsUrl = new URL(page.url());
  const statsHref = `${statsUrl.pathname}${statsUrl.search}`;

  await expect(
    page,
    `Opening Stats in device ${deviceId}'s active pane did not move the browser title to "Stats · Nexus".`,
  ).toHaveTitle("Stats · Nexus", { timeout: 15_000 });

  await expect
    .poll(
      async () => {
        const response = await api.get("/api/me/workspace-session");
        if (!response.ok()) return null;
        const payload = (await response.json()) as {
          data?: { own?: { state?: WorkspaceState } | null };
        };
        const state = payload.data?.own?.state;
        return state?.primaryPanesById[state.activePrimaryPaneId]?.currentVisit.href;
      },
      {
        message: `Expected device ${deviceId} to persist the exact Nexus-opened Stats query ${statsHref}.`,
        timeout: 15_000,
      },
    )
    .toBe(statsHref);

  await gotoWithStrictCsp(page, "/");
  await expect(
    page,
    `Fresh document for device ${deviceId} did not restore the exact persisted Stats query ${statsHref}.`,
  ).toHaveURL(statsUrl.toString());
  await expect(workspacePaneButton(page, /^Stats\b/)).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(workspacePaneButton(page, /^Search\b/)).toBeVisible();

  await expect(
    page,
    `Fresh document for device ${deviceId} restored the Stats pane but not its browser title "Stats · Nexus".`,
  ).toHaveTitle("Stats · Nexus", { timeout: 15_000 });

  // Leave and re-enter the Stats pane by keyboard. Stats publishes no body route
  // heading and holds no focusable row, so the return has nothing to fall back
  // to except the pane landmark named by the canonical title.
  await page
    .getByRole("button", { name: "Search or ask anything" })
    .click();
  await expect(input).toBeFocused();
  await input.fill("notes");
  const notes = nexus.getByRole("gridcell", { name: /^Notes\b/ });
  await expect(
    notes,
    `Nexus did not project the canonical Notes place for workspace device ${deviceId}.`,
  ).toBeVisible();
  await expect
    .poll(
      async () => {
        const [activeDescendant, notesCellId] = await Promise.all([
          input.getAttribute("aria-activedescendant"),
          notes.getAttribute("id"),
        ]);
        return activeDescendant === notesCellId
          ? "Notes"
          : `active descendant ${activeDescendant}`;
      },
      {
        message: `Nexus did not make the Notes place the keyboard-active entry for device ${deviceId}, so pressing Enter would leave the Stats pane for a different place.`,
        timeout: 10_000,
      },
    )
    .toBe("Notes");
  await input.press("Enter");
  await expect(
    page,
    `Keyboard activation in Nexus did not leave ${statsHref} for the Notes place in device ${deviceId}'s active pane.`,
  ).toHaveURL(/\/notes$/);
  await expect(
    page,
    `Navigating device ${deviceId}'s active pane to Notes did not move the browser title to "Notes · Nexus".`,
  ).toHaveTitle("Notes · Nexus", { timeout: 15_000 });

  await page
    .getByRole("button", { name: "Go back in this pane", disabled: false })
    .press("Enter");
  await expect(
    page,
    `Keyboard return in device ${deviceId}'s active pane did not restore ${statsHref}.`,
  ).toHaveURL(statsUrl.toString());
  await expect
    .poll(() => focusedPaneLandmarkName(page), {
      message: `Keyboard return to ${statsHref} in device ${deviceId}'s workspace must hand focus to that pane's landmark, whose accessible name is the canonical title "Stats".`,
      timeout: 15_000,
    })
    .toBe("Stats");
});
