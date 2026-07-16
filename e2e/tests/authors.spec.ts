import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { stateChangingApiHeaders } from "./api";
import {
  activeWorkspacePane,
  gotoSinglePaneWorkspace,
  workspaceE2eDeviceId,
} from "./workspace";

// The lightweight author-deduplication cutover (§7 / AC 21, 29, 30) removes the
// `/authors` directory root and the fixed Authors nav peer: "Go to Authors" now
// lives slot-less in the Launcher/keybindings and lands on `/search?kinds=people`.
// These journeys assert that surface, the retained author detail page, the
// media-author editor, and the hard 404s left behind by the removed routes.

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readMediaSeedId(name: string): string {
  const seedPath = path.join(__dirname, "..", ".seed", name);
  const seed = JSON.parse(readFileSync(seedPath, "utf-8")) as { media_id: string };
  return seed.media_id;
}

// PUT the author surface directly through the BFF (transport-only proxy). The
// state-changing CSRF Origin header the proxy requires is supplied exactly as the
// workspace-session seeding does; page.request rides the page context's auth
// cookies. Returns the decoded camelCase MediaAuthors payload.
interface SeededAuthor {
  contributorHandle: string;
  displayName: string;
  creditedName: string;
}
interface MediaAuthorsResult {
  authorMode: "automatic" | "manual";
  authors: SeededAuthor[];
  canEditAuthors: boolean;
}

async function putMediaAuthors(
  page: Page,
  mediaId: string,
  body: Record<string, unknown>,
): Promise<MediaAuthorsResult> {
  const response = await page.request.put(`/api/media/${mediaId}/authors`, {
    headers: stateChangingApiHeaders(),
    data: body,
  });
  expect(
    response.ok(),
    `PUT /api/media/${mediaId}/authors failed: ${response.status()} ${(
      await response.text()
    ).slice(0, 400)}`,
  ).toBeTruthy();
  const json = (await response.json()) as { data: MediaAuthorsResult };
  return json.data;
}

async function seedManualAuthor(
  page: Page,
  mediaId: string,
  displayName: string,
): Promise<SeededAuthor> {
  const result = await putMediaAuthors(page, mediaId, {
    clientMutationId: randomUUID(),
    mode: "manual",
    authors: [{ creditedName: displayName, binding: { kind: "new", displayName } }],
  });
  const seeded = result.authors[0];
  expect(seeded, `expected one seeded author for ${mediaId}`).toBeTruthy();
  return seeded!;
}

async function resetAuthorsToAutomatic(page: Page, mediaId: string): Promise<void> {
  await putMediaAuthors(page, mediaId, {
    clientMutationId: randomUUID(),
    mode: "automatic",
  });
}

test.describe("author journeys", () => {
  test("Go to Authors opens People-scoped search with no blank lookup", async ({
    page,
  }) => {
    // Record every client contributor/search lookup: a blank People landing must
    // fire none of them before the user types (AC 29). Registered before any
    // navigation so nothing slips through; SSR loaders run server-side and are
    // invisible to page.route, so this scopes exactly to the client surface.
    const lookups: string[] = [];
    await page.route("**/api/contributors**", async (route) => {
      lookups.push(new URL(route.request().url()).pathname);
      await route.continue();
    });
    await page.route("**/api/search**", async (route) => {
      lookups.push(new URL(route.request().url()).pathname);
      await route.continue();
    });

    // Reach the destination the way the product does: the Launcher "Go to
    // Authors" command (derived slot-less from the shared destination registry).
    await page.goto("/libraries?launcher=1");
    const launcher = page.getByRole("dialog", { name: "Launcher" });
    await expect(launcher).toBeVisible();
    const launcherInput = launcher.getByRole("combobox", {
      name: "Search, add, or ask",
    });
    await launcherInput.fill("Authors");
    const authorsCommand = launcher
      .getByRole("listbox")
      .getByRole("option", { name: "Authors", exact: true });
    await expect(authorsCommand).toBeVisible();
    await authorsCommand.click();

    // Lands on the People-scoped search surface.
    await page.waitForURL((url) => {
      return url.pathname === "/search" && url.searchParams.get("kinds") === "people";
    });

    // Everything recorded so far was the Launcher's OWN typeahead: `fill("Authors")`
    // drives the palette's `/api/search` query, which is not the landing behavior AC 29
    // constrains. Reset the recorder now that we have navigated so the assertion below
    // scopes strictly to the blank People surface. A regressed landing fetches from a
    // post-mount effect that runs after this navigation commit, so it is still caught.
    lookups.length = 0;

    const searchPane = activeWorkspacePane(page);
    const kinds = searchPane.getByRole("group", { name: "Result kinds" });
    await expect(
      kinds.getByRole("button", { name: "People", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      kinds.getByRole("button", { name: "Documents", exact: true }),
    ).toHaveAttribute("aria-pressed", "false");

    // The search box is present, usable, and owns focus on this landing (AC 29). The
    // SSR input renders `disabled` until hydration (so its `autoFocus` is inert); the
    // fix is coordinated — SearchPaneBody focuses the box on the mount flip in response
    // to a Launcher-set request, and the Launcher suppresses its own return-focus on a
    // navigating close so it doesn't yank focus back to <body>.
    const searchInput = searchPane.getByLabel("Search content");
    await expect(searchInput).toBeEnabled();
    await expect(searchInput).toBeFocused();

    // The cutover's core AC-29 guarantee: after landing + hydration (awaited above
    // via the pressed chip and the enabled input), the blank People surface has fired
    // NO contributor-directory / search lookup of its own before the user types.
    expect(lookups).toEqual([]);

    // Typing is what drives the first lookup — proving the interception is live
    // (so the empty assertion above is a real signal, not a dead route).
    await searchInput.fill("someone");
    await expect
      .poll(() => lookups.some((p) => p.startsWith("/api/search")))
      .toBe(true);
  });

  test("/authors root is 404", async ({ page }) => {
    const response = await page.goto("/authors");
    expect(response?.status()).toBe(404);
  });

  test("author detail renders under the Authors standing head", async ({
    page,
  }, testInfo) => {
    // Seed a contributor by asserting one author onto a seeded media, then read
    // the freshly minted handle straight off the PUT response.
    const mediaId = readMediaSeedId("youtube-media.json");
    const displayName = `Ada Lovelace ${testInfo.workerIndex}-${Date.now()}`;
    const seeded = await seedManualAuthor(page, mediaId, displayName);

    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-author-detail"),
      `/authors/${seeded.contributorHandle}`,
    );

    const pane = activeWorkspacePane(page);
    // Standing head furniture stays "Authors" on the detail page (AC 29). The
    // running head renders the section label verbatim (uppercased only by CSS).
    await expect(pane.locator('[data-running-head="true"]')).toContainText(
      /authors/i,
    );
    await expect(
      pane.getByRole("heading", { level: 1, name: displayName }),
    ).toBeVisible();

    await resetAuthorsToAutomatic(page, mediaId);
  });

  test("media author editor: add existing + create new, then reset to automatic", async ({
    page,
  }, testInfo) => {
    const token = `${testInfo.workerIndex}-${Date.now()}`;
    const existingName = `Grace Hopper ${token}`;
    const newName = `Ada Lovelace ${token}`;

    // Seed a visible existing contributor on a different media so the picker can
    // find it, then drive the editor on the target media through the real UI.
    const pickerMediaId = readMediaSeedId("non-pdf-media.json");
    const targetMediaId = readMediaSeedId("pdf-media.json");
    await seedManualAuthor(page, pickerMediaId, existingName);
    // Start the target from a known automatic baseline.
    await resetAuthorsToAutomatic(page, targetMediaId);

    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-author-editor"),
      `/media/${targetMediaId}`,
    );
    const pane = activeWorkspacePane(page);

    // The byline exposes the edit affordance (creator capability → canEditAuthors).
    const openEditor = pane.getByRole("button", { name: /^(Edit authors|Add author)$/ });
    await expect(openEditor).toBeVisible({ timeout: 20_000 });
    await openEditor.click();

    const editor = page.getByRole("dialog", { name: "Edit authors" });
    await expect(editor).toBeVisible();

    // Add an existing author via the search combobox.
    await editor.getByRole("button", { name: "Add author" }).click();
    const search = editor.getByRole("combobox", { name: "Search authors" });
    await search.fill(existingName);
    const existingOption = editor
      .getByRole("option", { name: new RegExp(escapeRegExp(existingName)) })
      .first();
    await expect(existingOption).toBeVisible({ timeout: 15_000 });
    await existingOption.click();

    // Create a brand-new author from a name with no match.
    await editor.getByRole("button", { name: "Add author" }).click();
    const createSearch = editor.getByRole("combobox", { name: "Search authors" });
    await createSearch.fill(newName);
    const createOption = editor.getByRole("option", { name: /as a new author/ });
    await expect(createOption).toBeVisible({ timeout: 15_000 });
    await createOption.click();

    // Save the manual byline.
    await editor.getByRole("button", { name: "Save" }).click();
    await expect(editor).toBeHidden();

    // Byline reflects the saved manual authors + the manual-mode marker.
    await expect(pane.getByText("Authors edited manually")).toBeVisible();
    await expect(pane.getByText(existingName)).toBeVisible();
    await expect(pane.getByText(newName)).toBeVisible();

    // Reopen and reset to automatic; assert the confirmation toast copy.
    await pane.getByRole("button", { name: "Edit authors" }).click();
    const reopened = page.getByRole("dialog", { name: "Edit authors" });
    await expect(reopened).toBeVisible();
    await reopened
      .getByRole("button", { name: "Reset to automatic authors" })
      .click();
    await expect(reopened).toBeHidden();
    await expect(
      page.getByText("Automatic author updates will resume on the next refresh."),
    ).toBeVisible();

    // Leave shared seed media as we found them.
    await resetAuthorsToAutomatic(page, pickerMediaId);
    await resetAuthorsToAutomatic(page, targetMediaId);
  });

  test("removed contributor routes 404 through the BFF", async ({ page }) => {
    // The former collection root and a reconciliation lane are gone; the surviving
    // [handle] proxy short-circuits their reserved segments to 404 (AC 30).
    const directory = await page.request.get("/api/contributors/directory");
    expect(directory.status()).toBe(404);
    const reconciliation = await page.request.get(
      "/api/contributors/reconciliation-candidates",
    );
    expect(reconciliation.status()).toBe(404);
  });
});
