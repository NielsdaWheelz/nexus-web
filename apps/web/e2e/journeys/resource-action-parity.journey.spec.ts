import type { Locator, Page } from "playwright/test";
import { ARTICLE_TITLE, captureCanonicalArticle } from "../articleFixture";
import {
  expect,
  gotoWithStrictCsp,
  signIn,
  test,
  webOrigin,
} from "../fixtures";
import { matchesResponse, pageRequest } from "../request";
import { READY_WEB_ARTICLE_PLAN } from "../resourceActionProductOracle";

test.use({ journeyId: "resource-action-parity" });

// The one canonical dropdown is keyed only by its resource + viewer, so its
// trigger's accessible name differs per surface (presentation only) while the
// menuitem SET it opens is identical everywhere. These are the surface triggers.
const ROW_TRIGGER = `More actions for ${ARTICLE_TITLE}`;
const NEXUS_TRIGGER = `Actions for ${ARTICLE_TITLE}`;
const PODCAST_TITLE = "Houston We Have a Podcast";
// The mobile pane bar renders the same canonical dropdown under the bare label
// "Actions" (presentation only) — MobilePaneBar.tsx passes label="Actions".
const MOBILE_PANE_TRIGGER = "Actions";
const DESKTOP_VIEWPORT = { width: 1_280, height: 900 } as const;
// Far below any plausible mobile breakpoint (max-width lives well above phone
// widths), so a fresh load renders the mobile pane chrome.
const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;

// Independent, product-reviewed literals. The oracle imports no production
// catalog/planner, so one shared implementation cannot make every surface agree
// on the same missing, renamed, or reordered action.
interface ResourceMenuSignatureItem {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly groupStart: boolean;
  readonly control:
    | { readonly kind: "Command"; readonly checked: null }
    | { readonly kind: "Toggle"; readonly checked: boolean };
  readonly availability:
    | { readonly kind: "Available"; readonly reason: null }
    | { readonly kind: "Blocked"; readonly reason: string };
  readonly tone: "default" | "danger";
}

function lucideDomIdentity(icon: string): string {
  return icon
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .replace(/([A-Za-z])([0-9])/g, "$1-$2")
    .toLowerCase();
}

// This exact, hand-reviewed ready-article signature is independent of the
// production catalog/planner. It pins every semantic that ActionMenu exposes:
// identity/copy/icon, group boundaries, control state, availability, and tone.
const EXPECTED_CANONICAL_MENU: readonly ResourceMenuSignatureItem[] =
  READY_WEB_ARTICLE_PLAN.map((action, index, plan) => ({
    id: action.id,
    label: action.label,
    icon: lucideDomIdentity(action.icon),
    groupStart: index > 0 && plan[index - 1]?.group !== action.group,
    control:
      action.id === "ResourceOperation.Media.Consumption" ||
      action.id === "RelationshipAction.LecternMembership"
        ? { kind: "Toggle", checked: false }
        : { kind: "Command", checked: null },
    availability: { kind: "Available", reason: null },
    tone: action.tone,
  }));

// Scope/Taxonomy guard: these are real, live control labels that belong to OTHER
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
 * Open a resource dropdown, read its ordered public semantic signature, and
 * dismiss it. Confirmation and intent are deliberately absent: they are not DOM
 * semantics and are pinned independently by pure contract tests.
 */
async function readResourceMenu(
  page: Page,
  trigger: Locator,
  surface: string,
  expectedCount?: number,
): Promise<readonly ResourceMenuSignatureItem[]> {
  await expect(
    trigger,
    `${surface}: the canonical resource dropdown trigger never became available.`,
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    trigger,
    `${surface}: the canonical resource dropdown stayed unavailable.`,
  ).toBeEnabled({ timeout: 15_000 });
  await trigger.click();
  const menu = page.getByRole("menu");
  await expect(menu, `${surface}: the resource dropdown did not open.`).toBeVisible();
  const menuItems = menu
    .getByRole("menuitem")
    .or(menu.getByRole("menuitemcheckbox"));
  await expect(
    menuItems.first(),
    `${surface}: the resource dropdown opened with no menuitems.`,
  ).toBeVisible();
  if (expectedCount !== undefined) {
    await expect(
      menuItems,
      `${surface}: the resource dropdown did not settle on ${expectedCount} actions.`,
    ).toHaveCount(expectedCount);
  }
  const signature = await menuItems.evaluateAll((elements) =>
    elements.map((element) => {
      const id = element.getAttribute("data-action-id");
      const tone = element.getAttribute("data-action-tone");
      const availabilityKind = element.getAttribute(
        "data-action-availability",
      );
      const iconClass = Array.from(
        element.querySelector("svg")?.classList ?? [],
      ).find((name) => name.startsWith("lucide-"));
      if (
        id === null ||
        iconClass === undefined ||
        (availabilityKind !== "Available" &&
          availabilityKind !== "Blocked")
      ) {
        throw new Error(
          `Incomplete resource-action semantics for ${id ?? "unknown action"}.`,
        );
      }
      let semanticTone: "default" | "danger";
      if (tone === "default") semanticTone = "default";
      else if (tone === "danger") semanticTone = "danger";
      else throw new Error(`${id} omitted its semantic tone.`);

      const role = element.getAttribute("role");
      const checked = element.getAttribute("aria-checked");
      const control =
        role === "menuitemcheckbox"
          ? checked === "true" || checked === "false"
            ? { kind: "Toggle" as const, checked: checked === "true" }
            : (() => {
                throw new Error(`${id} toggle omitted aria-checked.`);
              })()
          : { kind: "Command" as const, checked: null };
      const descriptionIds =
        element.getAttribute("aria-describedby")?.split(/\s+/) ?? [];
      const reason = descriptionIds
        .map((descriptionId) =>
          document.getElementById(descriptionId)?.textContent?.trim(),
        )
        .filter((copy): copy is string => Boolean(copy))
        .join(" ");
      const ariaBlocked = element.getAttribute("aria-disabled") === "true";
      if ((availabilityKind === "Blocked") !== ariaBlocked) {
        throw new Error(`${id} availability disagrees with aria-disabled.`);
      }
      if (availabilityKind === "Blocked" && reason.length === 0) {
        throw new Error(`${id} blocked availability omitted its reason.`);
      }

      return {
        id,
        label: (element as HTMLElement).innerText.trim(),
        icon: iconClass
          .slice("lucide-".length)
          .replace(/([A-Za-z])([0-9])/g, "$1-$2")
          .toLowerCase(),
        groupStart:
          element.parentElement?.previousElementSibling?.getAttribute("role") ===
          "separator",
        control,
        availability:
          availabilityKind === "Blocked"
            ? { kind: "Blocked" as const, reason }
            : { kind: "Available" as const, reason: null },
        tone: semanticTone,
      };
    }),
  );
  await page.keyboard.press("Escape");
  await expect(
    menu,
    `${surface}: the resource dropdown did not dismiss on Escape.`,
  ).toBeHidden();
  return signature;
}

test("canonical resources yield identical dropdown semantics across surfaces and reconcile a real mutation", async ({
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
  const oracle = await readResourceMenu(
    page,
    rowTrigger,
    "library row",
    EXPECTED_CANONICAL_MENU.length,
  );

  // INDEPENDENT ORACLE FIRST: the row menu must equal the spec-derived literal
  // exactly. This is the sensitivity anchor — it catches a mid-list drop/reorder
  // /leak that a surface-vs-surface comparison alone would miss (both surfaces
  // render the same implementation). Every `toEqual(oracle)` below then proves
  // the OTHER surfaces match this same, now-independently-verified set. It also
  // pins AC3: Open is retained and promoted to the top, with the exact plan's
  // sole danger action last.
  expect(
    oracle,
    `The library-row canonical dropdown diverged from the spec-derived resource action set (AC1/AC3). got=${JSON.stringify(oracle)} expected=${JSON.stringify(EXPECTED_CANONICAL_MENU)}`,
  ).toEqual(EXPECTED_CANONICAL_MENU);

  // ---- Scope/Taxonomy: non-resource controls stay outside this dropdown -----
  // Reader settings, pane options, pane navigation, and global nav live on their
  // own owners; a real regression folding any of them into the resource menu is
  // what the taxonomy split forbids. (A bare "Refresh" check would be vacuous —
  // no such menuitem exists, and "Refresh source" IS a legit resource action.)
  for (const label of NON_RESOURCE_LABELS) {
    expect(
      oracle.map((action) => action.label),
      `The non-resource control "${label}" leaked into the canonical resource dropdown (Scope/Taxonomy).`,
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
  const nexusItems = await readResourceMenu(
    page,
    nexusTrigger,
    "Nexus result row",
    oracle.length,
  );
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
  const paneItems = await readResourceMenu(
    page,
    paneOptions,
    "media pane header",
    oracle.length,
  );
  expect(
    paneItems,
    "the media pane header Options dropdown diverged from the row's canonical dropdown (AC1/AC4).",
  ).toEqual(oracle);
  // Scope/Taxonomy positive: the pane's own navigation is a dedicated control OUTSIDE the
  // resource dropdown — it is not folded into the canonical menu.
  await expect(
    page.getByRole("button", { name: "Go back in this pane" }),
    "the pane navigation control was missing as a dedicated affordance (Scope/Taxonomy).",
  ).toBeVisible();

  // ---- SURFACE 4 (Browse negative): a NON-ACQUIRED preview has NO menu -------
  // A canonical resource dropdown is a standing representation of an ACQUIRED
  // resource; a Browse preview of a not-yet-acquired result has no owned
  // ResourceRef, so the Scope/Taxonomy contract requires the acquisition control
  // and NO resource dropdown. Observe the deterministic recorded PodcastIndex
  // fixture before subscribing, while it has no canonical ResourceRef.
  await gotoWithStrictCsp(page, "/browse?kind=Podcast&q=Houston+We+Have+a+Podcast");
  const browseResult = page.getByRole("link", {
    name: PODCAST_TITLE,
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
      "a canonical resource dropdown leaked onto a NON-ACQUIRED Browse preview (Scope/Taxonomy).",
    ).toHaveCount(0);
  }

  // ---- SURFACE 5 (Browse positive): the ACQUIRED Podcast has the menu -------
  // Subscribe through the real acquisition boundary, read the canonical
  // Podcast in its pane, then re-run the same discovery. Browse must now project
  // an InNexus row for that exact Podcast and expose the byte-for-byte same
  // public menu signature — including the checked subscription toggle.
  const subscribeResponsePromise = page.waitForResponse((response) =>
    matchesResponse(
      response,
      webOrigin,
      "POST",
      "/api/podcasts/subscriptions",
    ),
  );
  await page.getByRole("button", { name: "Subscribe", exact: true }).click();
  const subscribeResponse = await subscribeResponsePromise;
  const subscribeText = await subscribeResponse.text();
  expect(
    subscribeResponse.ok(),
    `Podcast subscription failed: ${subscribeResponse.status()} ${subscribeText.slice(0, 500)}`,
  ).toBeTruthy();
  await expect(page).toHaveURL(/\/podcasts\/[0-9a-f-]{36}$/i);

  const podcastPaneSignature = await readResourceMenu(
    page,
    page.getByRole("button", { name: "Options", exact: true }),
    "acquired Podcast pane header",
  );
  expect(
    podcastPaneSignature.find(
      (action) =>
        action.id === "RelationshipAction.PodcastSubscription",
    ),
    "The acquired Podcast pane did not expose its subscribed toggle state.",
  ).toEqual(
    expect.objectContaining({
      label: "Unsubscribe",
      control: { kind: "Toggle", checked: true },
      availability: { kind: "Available", reason: null },
    }),
  );

  await gotoWithStrictCsp(
    page,
    "/browse?kind=Podcast&q=Houston+We+Have+a+Podcast",
  );
  await expect(
    page.getByRole("link", { name: PODCAST_TITLE, exact: true }),
    "The acquired Podcast disappeared from its Browse result set.",
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByText("Podcast Index · In Nexus", { exact: true }),
    "Browse did not reproject the subscribed Podcast as an acquired InNexus resource.",
  ).toBeVisible();
  const acquiredBrowseSignature = await readResourceMenu(
    page,
    page.getByRole("button", {
      name: `More actions for ${PODCAST_TITLE}`,
      exact: true,
    }),
    "acquired Podcast Browse row",
    podcastPaneSignature.length,
  );
  expect(
    acquiredBrowseSignature,
    "The acquired Podcast Browse row diverged from the same Podcast's pane menu (AC1/AC5).",
  ).toEqual(podcastPaneSignature);

  // Specialist surfaces (Connections, Evidence, chat context refs) also render
  // the ONE canonical ResourceActionMenu, under a `Actions for <title>` trigger
  // paired with a SEPARATE ContextEdgeMenu for the edge command. That specialist
  // parity + Scope/Taxonomy split is proven at the component level against the real
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
  const mobileRowItems = await readResourceMenu(
    page,
    mobileRowTrigger,
    "mobile library row",
    oracle.length,
  );
  expect(
    mobileRowItems,
    "the mobile row dropdown diverged from the desktop canonical dropdown (AC1 breakpoint parity).",
  ).toEqual(oracle);

  // Mobile PANE: the mobile pane bar carries the SAME canonical resource dropdown
  // ("Actions") that every other surface renders — and we read its menuitems and
  // match the oracle DIRECTLY, not merely structurally. On a fresh /media load the
  // top chrome is in its Visible (interactive, non-inert) phase and opening the
  // dropdown acquires the "action-menu" visible-lock that pins the chrome open.
  // Pointer activation is deliberate: the 390px mobile pane header must keep
  // every separate chrome control, including this canonical dropdown, inside
  // the interactive viewport. Keyboard reachability is covered independently
  // by ActionMenu's exhaustive responsive behavior proof.
  await gotoWithStrictCsp(page, `/media/${mediaId}`);
  const mobilePaneItems = await readResourceMenu(
    page,
    page.getByRole("button", { name: MOBILE_PANE_TRIGGER, exact: true }),
    "mobile pane bar",
    oracle.length,
  );
  expect(
    mobilePaneItems,
    "the mobile pane Actions dropdown diverged from the desktop canonical dropdown (AC1/AC4 breakpoint parity).",
  ).toEqual(oracle);
  // Scope/Taxonomy: the reader's own view menu ("Reader settings") and the pane's own
  // options ("Pane options") stay SEPARATE controls on the bar — never folded
  // into the resource dropdown that we just read above.
  await expect(
    page.getByRole("button", { name: /Pane options/ }),
    "the mobile pane's own options menu was folded into the resource dropdown (Scope/Taxonomy).",
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reader settings" }),
    "the mobile reader's view menu was folded into the resource dropdown (Scope/Taxonomy).",
  ).toBeVisible();

  // The mobile secondary sheet is a second standing header for this SAME media
  // ref. Open it through the public pane-options disclosure and compare the
  // secondary header's Actions dropdown against the desktop/mobile oracle.
  await page.getByRole("button", { name: /Pane options/ }).click();
  await page
    .getByRole("menuitem", { name: "Show Companion", exact: true })
    .click();
  const secondarySheet = page.getByTestId("mobile-secondary-host");
  await expect(
    secondarySheet,
    "The mobile Companion secondary sheet did not open.",
  ).toBeVisible();
  const secondaryHeaderSignature = await readResourceMenu(
    page,
    secondarySheet.getByRole("button", {
      name: MOBILE_PANE_TRIGGER,
      exact: true,
    }),
    "mobile secondary-sheet header",
    oracle.length,
  );
  expect(
    secondaryHeaderSignature,
    "The mobile secondary-sheet Actions dropdown diverged from the same media's canonical menu (AC1/AC4 breakpoint parity).",
  ).toEqual(oracle);
  await expect(
    secondarySheet,
    "Dismissing the resource dropdown also dismissed its owning secondary sheet.",
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
  const activeMediaPane = page.getByRole("region", {
    name: ARTICLE_TITLE,
    exact: true,
  });
  const optionsAfter = activeMediaPane.getByRole("button", {
    name: "Options",
    exact: true,
  });
  await expect(optionsAfter).toBeVisible({ timeout: 20_000 });
  await expect(optionsAfter).toBeEnabled({ timeout: 20_000 });
  await optionsAfter.click();
  const openMenu = page.getByRole("menu");
  await expect(openMenu).toBeVisible();
  const addToLectern = openMenu.getByRole("menuitemcheckbox", {
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
        (
          await readResourceMenu(
            page,
            optionsAfter,
            "media pane after mutation",
            oracle.length,
          )
        ).some((action) => action.label === "Remove from Lectern"),
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
  const reconciledItems = await readResourceMenu(
    page,
    reconciledRow,
    "library row after mutation",
    oracle.length,
  );
  expect(
    reconciledItems.map((action) => action.label),
    `The row representation of media ${mediaId} did not reconcile to the removal verb after Add-to-Lectern (AC7/AC8).`,
  ).toContain("Remove from Lectern");
  expect(
    reconciledItems.map((action) => action.label),
    "the stale Add-to-Lectern verb survived in another representation after the mutation.",
  ).not.toContain("Add to Lectern");
});
