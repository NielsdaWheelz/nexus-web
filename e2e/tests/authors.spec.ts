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

interface TitledMediaSeed {
  media_id: string;
  title: string;
}

function readMediaSeedJson(name: string): unknown {
  const seedPath = path.join(__dirname, "..", ".seed", name);
  return JSON.parse(readFileSync(seedPath, "utf-8")) as unknown;
}

function readMediaSeedId(name: string): string {
  return (readMediaSeedJson(name) as { media_id: string }).media_id;
}

function readTitledMediaSeed(name: string): TitledMediaSeed {
  return readMediaSeedJson(name) as TitledMediaSeed;
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

interface MediaAuthorSnapshot {
  authorMode: "automatic" | "manual";
  authors: Array<{
    contributorHandle: string | null;
    creditedName: string;
    displayName: string;
  }>;
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
  const [seeded] = await seedManualAuthors(page, mediaId, [displayName]);
  expect(seeded, `expected one seeded author for ${mediaId}`).toBeTruthy();
  return seeded!;
}

async function seedManualAuthors(
  page: Page,
  mediaId: string,
  displayNames: readonly string[],
): Promise<SeededAuthor[]> {
  const result = await putMediaAuthors(page, mediaId, {
    clientMutationId: randomUUID(),
    mode: "manual",
    authors: displayNames.map((displayName) => ({
      creditedName: displayName,
      binding: { kind: "new", displayName },
    })),
  });
  expect(result.authors).toHaveLength(displayNames.length);
  return result.authors;
}

async function resetAuthorsToAutomatic(
  page: Page,
  mediaId: string,
): Promise<void> {
  await putMediaAuthors(page, mediaId, {
    clientMutationId: randomUUID(),
    mode: "automatic",
  });
}

async function readMediaAuthorSnapshot(
  page: Page,
  mediaId: string,
): Promise<MediaAuthorSnapshot> {
  const response = await page.request.get(`/api/media/${mediaId}`);
  expect(
    response.ok(),
    `GET /api/media/${mediaId} failed while snapshotting authors: ${response.status()}`,
  ).toBeTruthy();
  const payload = (await response.json()) as {
    data: {
      author_mode?: "automatic" | "manual" | null;
      contributors?: Array<{
        contributor_handle?: string | null;
        contributor_display_name?: string | null;
        credited_name: string;
        role: string;
      }>;
    };
  };
  return {
    authorMode: payload.data.author_mode === "manual" ? "manual" : "automatic",
    authors: (payload.data.contributors ?? [])
      .filter((credit) => credit.role === "author")
      .map((credit) => ({
        contributorHandle: credit.contributor_handle ?? null,
        creditedName: credit.credited_name,
        displayName: credit.contributor_display_name ?? credit.credited_name,
      })),
  };
}

async function restoreMediaAuthorSnapshot(
  page: Page,
  mediaId: string,
  snapshot: MediaAuthorSnapshot,
): Promise<void> {
  await putMediaAuthors(page, mediaId, {
    clientMutationId: randomUUID(),
    mode: "manual",
    authors: snapshot.authors.map((author) => ({
      creditedName: author.creditedName,
      binding: author.contributorHandle
        ? {
            kind: "existing",
            contributorHandle: author.contributorHandle,
          }
        : { kind: "new", displayName: author.displayName },
    })),
  });
  if (snapshot.authorMode === "automatic") {
    await resetAuthorsToAutomatic(page, mediaId);
  }
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
      return (
        url.pathname === "/search" && url.searchParams.get("kinds") === "people"
      );
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
    const targetMedia = readTitledMediaSeed("pdf-media.json");
    const targetMediaId = targetMedia.media_id;
    await seedManualAuthor(page, pickerMediaId, existingName);
    // Start the target from a known automatic baseline.
    await resetAuthorsToAutomatic(page, targetMediaId);

    await gotoSinglePaneWorkspace(
      page,
      workspaceE2eDeviceId(testInfo, "e2e-author-editor"),
      `/media/${targetMediaId}`,
    );
    const pane = activeWorkspacePane(page);
    await expect(
      pane.getByRole("heading", { level: 1, name: targetMedia.title }),
    ).toBeVisible({ timeout: 20_000 });
    const paneStrip = page.getByRole("toolbar", { name: "Workspace panes" });
    await expect(
      paneStrip.getByTitle(targetMedia.title, { exact: true }),
    ).toHaveCount(1);

    // Author administration lives only in pane Options. The menu handoff keeps
    // the exact trigger as the editor's explicit return-focus target.
    const optionsTrigger = pane.getByRole("button", { name: "Options" });
    await expect(optionsTrigger).toBeVisible({ timeout: 20_000 });
    await optionsTrigger.click();
    const openEditor = page.getByRole("menuitem", {
      name: /^(Edit authors|Add author)/,
    });
    await expect(openEditor).toBeVisible();
    await openEditor.click();

    const editor = page.getByRole("dialog", { name: "Edit authors" });
    await expect(editor).toBeVisible();
    expect(
      await editor.evaluate((dialog) =>
        dialog.contains(document.activeElement),
      ),
    ).toBe(true);

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
    const createSearch = editor.getByRole("combobox", {
      name: "Search authors",
    });
    await createSearch.fill(newName);
    const createOption = editor.getByRole("option", {
      name: /as a new author/,
    });
    await expect(createOption).toBeVisible({ timeout: 15_000 });
    await createOption.click();

    // Save the manual author slice.
    await editor.getByRole("button", { name: "Save" }).click();
    await expect(editor).toBeHidden();
    await expect(optionsTrigger).toBeFocused();
    await expect(
      paneStrip.getByTitle(targetMedia.title, { exact: true }),
    ).toHaveCount(1);
    await expect(paneStrip.getByText(existingName, { exact: true })).toHaveCount(0);
    await expect(paneStrip.getByText(newName, { exact: true })).toHaveCount(0);

    // Persistent chrome stays compact and non-focusable; complete linked credits
    // remain inspectable through the dedicated Credits overlay.
    await expect(pane.getByText("Authors edited manually")).toHaveCount(0);
    const compactCredits = pane.locator('[data-resource-credits="true"]');
    await expect(
      compactCredits.getByText(existingName, { exact: true }),
    ).toHaveCount(1);
    await expect(
      compactCredits.getByText(newName, { exact: true }),
    ).toHaveCount(1);
    await expect(compactCredits.locator("a, button")).toHaveCount(0);
    await optionsTrigger.click();
    await page.getByRole("menuitem", { name: "Credits…" }).click();
    const credits = page.getByRole("dialog", { name: "Credits" });
    await expect(credits).toBeVisible();
    expect(
      await credits.evaluate((dialog) =>
        dialog.contains(document.activeElement),
      ),
    ).toBe(true);
    await expect(credits.getByText(existingName)).toBeVisible();
    await expect(credits.getByText(newName)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(credits).toBeHidden();
    await expect(optionsTrigger).toBeFocused();

    // Reopen and reset to automatic; assert the confirmation toast copy.
    await optionsTrigger.click();
    await page.getByRole("menuitem", { name: /^Edit authors/ }).click();
    const reopened = page.getByRole("dialog", { name: "Edit authors" });
    await expect(reopened).toBeVisible();
    await reopened
      .getByRole("button", { name: "Reset to automatic authors" })
      .click();
    await expect(reopened).toBeHidden();
    await expect(
      page.getByText(
        "Automatic author updates will resume on the next refresh.",
      ),
    ).toBeVisible();
    await expect(optionsTrigger).toBeFocused();

    // Leave shared seed media as we found them.
    await resetAuthorsToAutomatic(page, pickerMediaId);
    await resetAuthorsToAutomatic(page, targetMediaId);
  });

  test("media author editor returns focus to the mobile Options trigger", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 667 });
    const mediaId = readMediaSeedId("pdf-media.json");
    const retentionMediaId = readMediaSeedId("reader-document-map-media.json");
    const token = `${testInfo.workerIndex}-${Date.now()}`;
    const displayNames = Array.from(
      { length: 20 },
      (_, index) =>
        `Mobile Credit ${String(index + 1).padStart(2, "0")} ${token} — Extended Attribution`,
    );
    const originalAuthors = await readMediaAuthorSnapshot(page, mediaId);
    const retentionSnapshot = await readMediaAuthorSnapshot(
      page,
      retentionMediaId,
    );
    const retainedAuthors = [...retentionSnapshot.authors];
    const retainedHandles = new Set(
      retainedAuthors.flatMap((author) =>
        author.contributorHandle ? [author.contributorHandle] : [],
      ),
    );
    let requiresRetentionPublication = false;
    for (const author of originalAuthors.authors) {
      if (
        author.contributorHandle &&
        !retainedHandles.has(author.contributorHandle)
      ) {
        retainedAuthors.push(author);
        retainedHandles.add(author.contributorHandle);
        requiresRetentionPublication = true;
      }
    }
    expect(
      retainedAuthors.length,
      "temporary author-retention slice must fit the PUT contract",
    ).toBeLessThanOrEqual(20);
    let retentionPrepared = false;

    try {
      if (requiresRetentionPublication) {
        // Existing bindings are selectable only while the contributor remains
        // visible. Replacing this media's sole credit can make its prior handle
        // invisible (or prune it), so retain those canonical identities on a
        // second owned seed until the target snapshot has been restored.
        await restoreMediaAuthorSnapshot(page, retentionMediaId, {
          authorMode: "manual",
          authors: retainedAuthors,
        });
        retentionPrepared = true;
      }
      await seedManualAuthors(page, mediaId, displayNames);

      await gotoSinglePaneWorkspace(
        page,
        workspaceE2eDeviceId(testInfo, "e2e-author-editor-mobile-focus"),
        `/media/${mediaId}`,
      );

      const pane = activeWorkspacePane(page);
      const paneId = await pane.getAttribute("data-pane-id");
      expect(paneId).toBeTruthy();
      const mobileChrome = page.locator(`[data-pane-chrome-for="${paneId}"]`);
      await expect(mobileChrome).toHaveCount(1);
      const optionsTrigger = mobileChrome.getByRole("button", {
        name: "Pane options",
        exact: true,
      });
      await expect(optionsTrigger).toHaveCount(1, { timeout: 20_000 });
      const compactCredits = mobileChrome.locator(
        '[data-resource-credits="true"]',
      );
      for (const displayName of displayNames) {
        await expect(
          compactCredits.getByText(displayName, { exact: true }),
        ).toHaveCount(1);
      }
      await expect(compactCredits.locator("a, button")).toHaveCount(0);
      await optionsTrigger.click();
      const editAuthors = page.getByRole("menuitem", {
        name: /^Edit authors/,
      });
      await expect(editAuthors).toHaveCount(1);
      await editAuthors.click();

      const editor = page.getByRole("dialog", { name: "Edit authors" });
      await expect(editor).toBeVisible();
      expect(
        await editor.evaluate((dialog) =>
          dialog.contains(document.activeElement),
        ),
      ).toBe(true);
      await page.keyboard.press("Escape");
      await expect(editor).toBeHidden();
      await expect(optionsTrigger).toBeFocused();

      await optionsTrigger.click();
      const creditsItem = page.getByRole("menuitem", {
        name: "Credits…",
        exact: true,
      });
      await expect(creditsItem).toHaveCount(1);
      await creditsItem.click();
      const credits = page.getByRole("dialog", {
        name: "Credits",
        exact: true,
      });
      await expect(credits).toBeVisible();
      const lastCredit = credits.getByText(displayNames.at(-1)!, {
        exact: true,
      });
      await expect(lastCredit).toHaveCount(1);
      expect(
        await credits.evaluate((dialog) =>
          dialog.contains(document.activeElement),
        ),
      ).toBe(true);

      const creditsScrollOwner = credits.locator(
        '[data-resource-credits-complete="true"]',
      );
      await expect(creditsScrollOwner).toHaveCount(1);
      const scrollGeometry = await creditsScrollOwner.evaluate((owner) => {
        const overflowY = getComputedStyle(owner).overflowY;
        const geometry = {
          clientHeight: owner.clientHeight,
          overflowY,
          scrollHeight: owner.scrollHeight,
        };
        owner.scrollTop = owner.scrollHeight;
        return geometry;
      });
      expect(scrollGeometry.overflowY).toBe("auto");
      expect(scrollGeometry.scrollHeight).toBeGreaterThan(
        scrollGeometry.clientHeight,
      );
      await expect(lastCredit).toBeInViewport();

      await page.keyboard.press("Escape");
      await expect(credits).toBeHidden();
      await expect(optionsTrigger).toBeFocused();
    } finally {
      await restoreMediaAuthorSnapshot(page, mediaId, originalAuthors);
      if (retentionPrepared) {
        await restoreMediaAuthorSnapshot(
          page,
          retentionMediaId,
          retentionSnapshot,
        );
      }
    }
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
