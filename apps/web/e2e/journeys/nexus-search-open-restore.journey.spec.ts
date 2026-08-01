import { randomUUID } from "node:crypto";
import type { Page } from "playwright/test";
import {
  expect,
  gotoWithStrictCsp,
  signIn,
  test,
  webOrigin,
} from "../fixtures";

test.use({ journeyId: "nexus-search-open-restore" });

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
  const seedResponse = await page.request.put("/api/me/workspace-session", {
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

  await expect
    .poll(
      async () => {
        const response = await page.request.get("/api/me/workspace-session");
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
});
