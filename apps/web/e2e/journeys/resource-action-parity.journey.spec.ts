import type { Locator, Page } from "playwright/test";
import { ARTICLE_TITLE, captureCanonicalArticle } from "../articleFixture";
import {
  expect,
  gotoWithStrictCsp,
  signIn,
  test,
  webOrigin,
} from "../fixtures";
import { pageRequest } from "../request";

test.use({ journeyId: "resource-action-parity" });

// The one canonical dropdown is keyed only by its resource + viewer, so its
// trigger's accessible name differs per surface (presentation only) while the
// menuitem SET it opens is identical everywhere. These are the surface triggers.
const ROW_TRIGGER = `More actions for ${ARTICLE_TITLE}`;
const NEXUS_TRIGGER = `Actions for ${ARTICLE_TITLE}`;
// The mobile pane bar renders the same canonical dropdown under the bare label
// "Actions" (presentation only) — MobilePaneBar.tsx passes label="Actions".
const MOBILE_PANE_TRIGGER = "Actions";
const DESKTOP_VIEWPORT = { width: 1_280, height: 900 } as const;
// Far below any plausible mobile breakpoint (max-width lives well above phone
// widths), so a fresh load renders the mobile pane chrome.
const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;

// INDEPENDENT ORACLE (spec-derived, NOT read from any live menu). The captured
// NASA web article is a ready, web-scheme media in the viewer's default library
// on the Web platform, pinned below to a stable InProgress reading state. For
// that parity key the catalog + planner project exactly these menuitems, in this
// order: core (Open, Share, Chat), then the resource operations (with an
// InProgress article offering both "Mark as finished" and "Reset progress"),
// then the global relationships, with the sole danger action (Remove media)
// hoisted to the very end (AC5/AC6). Comparing the live row menu to THIS literal
// — rather than to itself — is what makes the cross-surface `toEqual(oracle)`
// checks below a real mid-list regression net: a dropped, reordered, or leaked
// action anywhere in the list fails here first, instead of passing vacuously
// because every surface renders the same code.
const EXPECTED_CANONICAL_MENU: readonly string[] = [
  "Open",
  "Share…",
  "Chat about this resource",
  "Open source",
  "Refresh source",
  "Re-enrich metadata",
  "Edit authors…",
  "Mark as finished",
  "Reset progress",
  "Libraries…",
  "Add to Lectern",
  "Remove media",
];

// AC4 taxonomy guard: these are real, live control labels that belong to OTHER
// owners (the reader view menu, the pane options menu, pane navigation, global
// nav). None is a resource action, so none may ever appear inside the canonical
// resource dropdown. A regression that folded any of them back into the resource
// menu is exactly what the taxonomy split forbids.
const NON_RESOURCE_LABELS: readonly string[] = [
  "Reader settings",
  "Pane options",
  "Go back in this pane",
  "Go forward",
  "Add content",
];

/**
 * Open a resource dropdown, read its ordered menuitem labels, and dismiss it.
 * Every surface renders the SAME `ResourceActionMenu`/catalog projection, so the
 * returned array is the parity signature: labels, in catalog order, danger last.
 */
async function readResourceMenu(
  page: Page,
  trigger: Locator,
  surface: string,
  openWith: "click" | "keyboard" = "click",
): Promise<string[]> {
  await expect(
    trigger,
    `${surface}: the canonical resource dropdown trigger never became available.`,
  ).toBeVisible({ timeout: 15_000 });
  if (openWith === "keyboard") {
    // Keyboard activation opens the SAME portaled menu without a viewport-bound
    // pointer click. ActionMenu's trigger opens on Enter/Space/ArrowDown, so this
    // reaches a trigger that is laid out (visible + enabled) but positioned
    // outside the narrow mobile viewport — a click there cannot be driven, focus
    // + Enter can. AC10 keeps this keyboard path a first-class affordance.
    await trigger.focus();
    await page.keyboard.press("Enter");
  } else {
    await trigger.click();
  }
  const menu = page.getByRole("menu");
  await expect(menu, `${surface}: the resource dropdown did not open.`).toBeVisible();
  await expect(
    menu.getByRole("menuitem").first(),
    `${surface}: the resource dropdown opened with no menuitems.`,
  ).toBeVisible();
  const labels = (await menu.getByRole("menuitem").allInnerTexts())
    .map((label) => label.trim())
    .filter((label) => label.length > 0);
  await page.keyboard.press("Escape");
  await expect(
    menu,
    `${surface}: the resource dropdown did not dismiss on Escape.`,
  ).toBeHidden();
  return labels;
}

test("one seeded resource yields the identical canonical dropdown on every surface and reconciles a real mutation across representations", async ({
  page,
  journeyUser,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await signIn(page, journeyUser);
  const api = pageRequest(page, webOrigin);

  // The viewer's default Library is where a captured resource publishes, giving
  // us the collection ROW surface for the same media the pane/Nexus surfaces open.
  const meResponse = await api.get("/api/me");
  const meText = await meResponse.text();
  expect(
    meResponse.ok(),
    `Default Library lookup for ${journeyUser.id} failed: ${meResponse.status()} ${meText.slice(0, 500)}`,
  ).toBeTruthy();
  const defaultLibraryId = (
    JSON.parse(meText) as { data: { default_library_id: string } }
  ).data.default_library_id;

  // Seed exactly ONE canonical media resource through the real capture stack.
  const mediaId = await captureCanonicalArticle(page, "resource-action-parity");
  await expect
    .poll(
      async () => {
        const response = await api.get(`/api/media/${mediaId}`);
        if (!response.ok()) return `http-${response.status()}`;
        const media = (await response.json()) as {
          data: { processing_status: string; retrieval_status: string | null };
        };
        return `${media.data.processing_status}:${media.data.retrieval_status}`;
      },
      {
        message: `Expected seeded media ${mediaId} to become routeable before comparing its dropdown across surfaces.`,
        timeout: 30_000,
      },
    )
    .toBe("ready_for_reading:ready");

  // ---- Pin the CONSUMPTION fact before ANY surface read ---------------------
  // AC1 parity holds for one facts revision. Reading a web article records a
  // reader-engagement row, which the snapshot projects as InProgress and which
  // also switches on the "Reset progress" resource action. That write is what the
  // reader UI performs asynchronously on open, so if it landed mid-journey a later
  // surface would legitimately read a DIFFERENT facts revision than the oracle and
  // fail parity for a non-regression reason. Do it deterministically up front
  // through the SAME real endpoint the reader uses (PUT reader-state), keeping
  // total progression far below the 0.95 finished threshold, then wait for the
  // AUTHORITATIVE action-snapshot to project InProgress. Every surface below then
  // reads this one stable fact — only an explicit Mark-as-finished (never invoked
  // here) could move it on, and the reader opens below only GREATEST() this low
  // progression, so it cannot drift.
  const mediaRef = `media:${mediaId}`;
  const readerState = await api.put(`/api/media/${mediaId}/reader-state`, {
    headers: { origin: webOrigin },
    data: {
      locator: {
        kind: "web",
        target: { fragment_id: "p0" },
        locations: {
          text_offset: 0,
          progression: 0.02,
          total_progression: 0.02,
          position: 1,
        },
        text: { quote: null, quote_prefix: null, quote_suffix: null },
      },
      base_revision: 0,
    },
  });
  const readerStateText = await readerState.text();
  expect(
    readerState.ok(),
    `Recording reading progress for media ${mediaId} failed: ${readerState.status()} ${readerStateText.slice(0, 500)}`,
  ).toBeTruthy();
  await expect
    .poll(
      async () => {
        const response = await api.post(
          "/api/resource-items/action-snapshots/resolve",
          { headers: { origin: webOrigin }, data: { refs: [mediaRef] } },
        );
        if (!response.ok()) return `http-${response.status()}`;
        const snapshot = (
          JSON.parse(await response.text()) as {
            data: {
              snapshots: {
                capabilities: { kind: string; state?: string }[];
              }[];
            };
          }
        ).data.snapshots[0];
        const consumption = snapshot?.capabilities.find(
          (capability) => capability.kind === "Consumption",
        );
        return consumption?.state ?? "absent";
      },
      {
        message: `Recorded reading progress did not project media ${mediaId} onto a stable InProgress consumption fact before comparing its dropdown across surfaces.`,
        timeout: 20_000,
      },
    )
    .toBe("InProgress");

  // ---- SURFACE 1 (oracle): the collection/library ROW -----------------------
  await gotoWithStrictCsp(page, `/libraries/${defaultLibraryId}`);
  await expect(
    page.getByRole("link", { name: ARTICLE_TITLE, exact: true }),
    `Seeded media ${mediaId} was ready but absent from default Library ${defaultLibraryId}.`,
  ).toBeVisible({ timeout: 15_000 });
  const rowTrigger = page.getByRole("button", { name: ROW_TRIGGER, exact: true });
  const oracle = await readResourceMenu(page, rowTrigger, "library row");

  // INDEPENDENT ORACLE FIRST: the row menu must equal the spec-derived literal
  // exactly. This is the sensitivity anchor — it catches a mid-list drop/reorder
  // /leak that a surface-vs-surface comparison alone would miss (both surfaces
  // render the same implementation). Every `toEqual(oracle)` below then proves
  // the OTHER surfaces match this same, now-independently-verified set. It also
  // pins AC5/AC6: Open promoted to the top, and the sole danger action last.
  expect(
    oracle,
    `The library-row canonical dropdown diverged from the spec-derived resource action set (AC1/AC5/AC6). got=${JSON.stringify(oracle)} expected=${JSON.stringify(EXPECTED_CANONICAL_MENU)}`,
  ).toEqual(EXPECTED_CANONICAL_MENU);

  // ---- AC4: non-resource controls are NOT in the resource dropdown ----------
  // Reader settings, pane options, pane navigation, and global nav live on their
  // own owners; a real regression folding any of them into the resource menu is
  // what the taxonomy split forbids. (A bare "Refresh" check would be vacuous —
  // no such menuitem exists, and "Refresh source" IS a legit resource action.)
  for (const label of NON_RESOURCE_LABELS) {
    expect(
      oracle,
      `The non-resource control "${label}" leaked into the canonical resource dropdown (AC4).`,
    ).not.toContain(label);
  }

  // ---- SURFACE 2: the NEXUS search-result row overflow ----------------------
  // Opened from the Library (the media is NOT the active tab), so Nexus projects
  // it as a canonical resource openable whose overflow IS the shared resource
  // dropdown — not an already-open place whose overflow only manages the tab.
  // The title lookup that surfaces the row is a SYNCHRONOUS Postgres query — the
  // openables search (POST /api/resource-items/openables/search) matches
  // media.title via inline FTS/ILIKE with no async embedding/index build gating
  // visibility — so the trigger's bounded toBeVisible (in readResourceMenu) only
  // has to absorb the ~80ms client debounce, never a background indexer.
  await page.getByRole("button", { name: "Search or ask anything" }).click();
  const nexus = page.getByRole("dialog", { name: "Nexus" });
  const nexusInput = nexus.getByRole("combobox", { name: "Find anything" });
  await expect(nexusInput).toBeFocused();
  await nexusInput.fill("Water on the Moon");
  const nexusTrigger = nexus.getByRole("button", { name: NEXUS_TRIGGER, exact: true });
  const nexusItems = await readResourceMenu(page, nexusTrigger, "Nexus result row");
  expect(
    nexusItems,
    `the Nexus result-row overflow diverged from the row's canonical dropdown (AC1). nexus=${JSON.stringify(nexusItems)} oracle=${JSON.stringify(oracle)}`,
  ).toEqual(oracle);

  // ---- SURFACE 3: the media PANE header "Options" ---------------------------
  // Navigating to the pane replaces the primary pane and tears down the open
  // Nexus dialog, so no explicit dialog dismissal is required here.
  await gotoWithStrictCsp(page, `/media/${mediaId}`);
  const paneOptions = page.getByRole("button", { name: "Options", exact: true });
  await expect(
    paneOptions,
    `Media pane for ${mediaId} never published its canonical resource dropdown.`,
  ).toBeVisible({ timeout: 20_000 });
  const paneItems = await readResourceMenu(page, paneOptions, "media pane header");
  expect(
    paneItems,
    "the media pane header Options dropdown diverged from the row's canonical dropdown (AC1).",
  ).toEqual(oracle);
  // AC4 positive: the pane's own navigation is a dedicated control OUTSIDE the
  // resource dropdown — it is not folded into the canonical menu.
  await expect(
    page.getByRole("button", { name: "Go back in this pane" }),
    "the pane navigation control was missing as a dedicated affordance (AC4).",
  ).toBeVisible();

  // ---- SURFACE 4 (Browse negative): a NON-ACQUIRED preview has NO menu -------
  // AC12 names Browse. A canonical resource dropdown is a standing representation
  // of an ACQUIRED resource; a Browse preview of a not-yet-acquired result has no
  // owned ResourceRef, so it must render the acquisition control and NO resource
  // dropdown at all. We reach the deterministic recorded PodcastIndex fixture and
  // STOP before subscribing, so the podcast stays non-acquired.
  await gotoWithStrictCsp(page, "/browse?kind=Podcast&q=Houston+We+Have+a+Podcast");
  const browseResult = page.getByRole("link", {
    name: "Houston We Have a Podcast",
    exact: true,
  });
  await expect(
    browseResult,
    "Deterministic Podcast discovery did not expose the Browse fixture result.",
  ).toBeVisible({ timeout: 20_000 });
  await browseResult.click();
  await expect(page).toHaveURL(/\/browse\/preview\?target=/);
  // Page loaded (still non-acquired: the acquisition CTA is present, not an Open).
  await expect(
    page.getByRole("button", { name: "Subscribe", exact: true }),
    "the non-acquired Browse preview never rendered its acquisition control.",
  ).toBeVisible({ timeout: 20_000 });
  // No canonical resource dropdown of ANY surface flavour is present. "Options"
  // and "Actions" are the exact resource-dropdown trigger names, and every row
  // /Nexus/specialist flavour is "More actions…"/"Actions for …"; none may exist
  // on a non-acquired preview.
  for (const missingTrigger of [
    page.getByRole("button", { name: "Options", exact: true }),
    page.getByRole("button", { name: "Actions", exact: true }),
    page.getByRole("button", { name: /^(?:More actions|Actions for)\b/ }),
  ]) {
    await expect(
      missingTrigger,
      "a canonical resource dropdown leaked onto a NON-ACQUIRED Browse preview (AC4/AC12).",
    ).toHaveCount(0);
  }

  // Specialist surfaces (Connections, Evidence, chat context refs) also render
  // the ONE canonical ResourceActionMenu, under a `Actions for <title>` trigger
  // paired with a SEPARATE ContextEdgeMenu for the edge command. That specialist
  // parity + AC4 taxonomy split is proven at the component level against the real
  // runtime/planner/catalog by ConversationContextRefsSurface.browser.test.tsx
  // (resource dropdown holds Open/Chat/… and NOT the edge command; the edge
  // control holds the edge command and NOT any resource action). Seeding a live
  // edge purely to re-open the same dropdown on Connections/Evidence here would
  // add a second resource + resource_edge for no additional signal, so this
  // real-stack journey instead adds the cheap Browse negative above.

  // ---- MOBILE parity (desktop/mobile identity) ------------------------------
  await page.setViewportSize(MOBILE_VIEWPORT);

  // Mobile ROW: the same CollectionRow renders the same canonical dropdown.
  await gotoWithStrictCsp(page, `/libraries/${defaultLibraryId}`);
  const mobileRowTrigger = page.getByRole("button", { name: ROW_TRIGGER, exact: true });
  const mobileRowItems = await readResourceMenu(page, mobileRowTrigger, "mobile library row");
  expect(
    mobileRowItems,
    "the mobile row dropdown diverged from the desktop canonical dropdown (AC1 breakpoint parity).",
  ).toEqual(oracle);

  // Mobile PANE: the mobile pane bar carries the SAME canonical resource dropdown
  // ("Actions") that every other surface renders — and we read its menuitems and
  // match the oracle DIRECTLY, not merely structurally. On a fresh /media load the
  // top chrome is in its Visible (interactive, non-inert) phase and opening the
  // dropdown acquires the "action-menu" visible-lock that pins the chrome open.
  // We open it via KEYBOARD, not a click, for a concrete layout reason: on the
  // reader the bar packs three 48px controls (Reader settings, Pane options,
  // Actions) into a single 48px grid column (.topBarControls, justify-content:
  // center), so the rightmost "Actions" trigger overflows past the 390px viewport
  // and stays "outside of the viewport" — Playwright cannot scroll a
  // horizontally-overflowed fixed-header control into view, so a pointer click
  // cannot be driven, but focus + Enter opens the identical menu deterministically.
  await gotoWithStrictCsp(page, `/media/${mediaId}`);
  const mobilePaneItems = await readResourceMenu(
    page,
    page.getByRole("button", { name: MOBILE_PANE_TRIGGER, exact: true }),
    "mobile pane bar",
    "keyboard",
  );
  expect(
    mobilePaneItems,
    "the mobile pane Actions dropdown diverged from the desktop canonical dropdown (AC1 breakpoint parity).",
  ).toEqual(oracle);
  // AC4: the reader's own view menu ("Reader settings") and the pane's own
  // options ("Pane options") stay SEPARATE controls on the bar — never folded
  // into the resource dropdown that we just read above.
  await expect(
    page.getByRole("button", { name: /Pane options/ }),
    "the mobile pane's own options menu was folded into the resource dropdown (AC4).",
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reader settings" }),
    "the mobile reader's view menu was folded into the resource dropdown (AC4).",
  ).toBeVisible();

  // ---- AC7/AC8: invoke a real mutation, reconcile across representations -----
  // Add-to-Lectern is a non-AI relationship mutation; it dispatches through the
  // resource-action runtime to its existing domain owner. This journey proves
  // SERVER RECONCILIATION + SEQUENTIAL AGREEMENT ACROSS REPRESENTATIONS: the
  // effect lands in the authoritative domain owner, the acting pane re-resolves
  // to the flipped verb, and a fresh row load (a distinct representation) then
  // re-resolves to the SAME flipped verb — no stale client snapshot survives.
  // (The LIVE simultaneous busy/verb flip across two CO-MOUNTED representations
  // from a single invocation is owned by the runtime's global keyed busy store
  // and proven at the component level — ResourceActionMenu.browser.test.tsx keeps
  // an in-flight action busy + aria-disabled on reopen, and
  // canonicalResourceMenuNexusPlayer.browser.test.tsx renders two surfaces off one
  // canonical plan. This e2e does not co-mount two representations, so it makes no
  // single-invocation simultaneous-flip claim.)
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await gotoWithStrictCsp(page, `/media/${mediaId}`);
  const optionsAfter = page.getByRole("button", { name: "Options", exact: true });
  await expect(optionsAfter).toBeVisible({ timeout: 20_000 });
  await optionsAfter.click();
  const openMenu = page.getByRole("menu");
  await expect(openMenu).toBeVisible();
  const addToLectern = openMenu.getByRole("menuitem", {
    name: "Add to Lectern",
    exact: true,
  });
  await expect(
    addToLectern,
    "the seeded media offered no Add-to-Lectern verb to invoke.",
  ).toBeVisible();
  await addToLectern.click();
  await expect(openMenu, "the dropdown did not close after invoking a mutation.").toBeHidden();

  // Same representation (this pane) reconciles: the relationship verb flips.
  await expect
    .poll(
      async () =>
        (await readResourceMenu(page, optionsAfter, "media pane after mutation")).includes(
          "Remove from Lectern",
        ),
      {
        message: `Add-to-Lectern on media ${mediaId} did not reconcile the pane dropdown to its removal verb.`,
        timeout: 15_000,
      },
    )
    .toBe(true);

  // A DIFFERENT representation agrees: the row dropdown shows the flipped verb,
  // proving the effect executed in the authoritative domain owner (not a stale
  // client snapshot) and that representations reach the same state (sequential
  // agreement; AC7/AC8).
  await gotoWithStrictCsp(page, `/libraries/${defaultLibraryId}`);
  const reconciledRow = page.getByRole("button", { name: ROW_TRIGGER, exact: true });
  const reconciledItems = await readResourceMenu(page, reconciledRow, "library row after mutation");
  expect(
    reconciledItems,
    `The row representation of media ${mediaId} did not reconcile to the removal verb after Add-to-Lectern (AC7/AC8).`,
  ).toContain("Remove from Lectern");
  expect(
    reconciledItems,
    "the stale Add-to-Lectern verb survived in another representation after the mutation.",
  ).not.toContain("Add to Lectern");
});
