import { expect, test, type Locator, type Page } from "@playwright/test";
import path from "node:path";
import { deleteE2eResource, throwE2eCleanupFailures } from "./cleanup";
import { evidenceHighlightArticle, openEvidencePane } from "./reader";
import { selectFreshVisibleTextSnippet } from "./selection";
import {
  ACTIVE_WORKSPACE_PANE_SELECTOR,
  activeWorkspacePane,
} from "./workspace";
import {
  FRESH_REAL_MEDIA_FIXTURES,
  gotoRealMediaSinglePane,
  readRealMediaSeed,
  uploadFreshRealMediaFileThroughUi,
} from "./real-media/real-media-seed";

// End-to-end coverage for the universal Link flow
// (docs/cutovers/universal-link-authoring-hard-cutover.md, AC16 + AC24). Two
// tests exercise the two reader families the spec calls out as distinct:
//
//  (a) a PDF fresh selection whose Link source is a *real browser drag* over the
//      PDF.js text layer — true page-space quads, NOT an API-seeded Highlight
//      (AC16). It walks Link -> success toast -> Undo (keeps the materialized
//      Highlight, removes only the Link) -> Remove and opposite-end activation.
//
//  (b) a reflowable (EPUB) fresh selection through the shared LinkTargetDialog:
//      cancel writes nothing (Invariant 6), the confirmed Link shows a
//      Connections row, and re-linking the now-existing Highlight to the same
//      target returns the "Already linked" View state with no Undo (AC15).
//
// Both seed through app APIs + the real-media upload harness, drive the real
// network, and query by role/label only. Tagged @real-media so they run under
// `make test-real-media` (the fixture-backed provider project), never the plain
// `make test-e2e` sweep.

const PDF_FIXTURE_PATH = path.join(
  __dirname,
  "..",
  "..",
  "python",
  "tests",
  "fixtures",
  "pdf",
  "svms.pdf",
);
const EPUB_FIXTURE_PATH = path.join(
  __dirname,
  "..",
  "..",
  "python",
  "tests",
  "fixtures",
  "epub",
  "moby-dick-old.epub",
);

const LINKS_PATHNAME = "/api/resource-graph/links";

// The Link mutation and the two Highlight-create endpoints a Link source can
// touch. Invariant 6 forbids all three before a Link is confirmed.
function isLinkOrHighlightWrite(request: {
  method(): string;
  url(): string;
}): boolean {
  if (request.method() !== "POST") return false;
  const pathname = new URL(request.url()).pathname;
  return (
    pathname === LINKS_PATHNAME ||
    /^\/api\/fragments\/[^/]+\/highlights$/.test(pathname) ||
    /^\/api\/media\/[^/]+\/pdf-highlights$/.test(pathname)
  );
}

/** The toast viewport (`aria-label="Notifications"`); actionable toasts stay put. */
function notifications(page: Page): Locator {
  return page.getByLabel("Notifications");
}

/** A settled toast whose title matches — success titles start "Linked to …",
 * the duplicate title "Already linked to …"; matched case-sensitively so the two
 * never collide (Feedback renders both with `role="status"`). */
function toastByTitle(page: Page, title: RegExp): Locator {
  return notifications(page)
    .locator('[role="status"]')
    .filter({ hasText: title })
    .first();
}

/** Actionable toasts intentionally do not auto-dismiss. Once an assertion has
 * consumed one, close it through the product affordance before driving chrome
 * it may cover. */
async function dismissToast(toast: Locator): Promise<void> {
  await toast.getByRole("button", { name: /^Dismiss / }).click();
  await expect(toast).toBeHidden();
}

/** The Link action lives in the reader selection popup / highlight action bar as
 * a plain button whose accessible name is the "Link…" descriptor
 * (highlightActions.tsx). */
async function clickLinkAction(scope: Locator): Promise<void> {
  const linkButton = scope.getByRole("button", { name: "Link…" });
  await expect(linkButton).toBeVisible({ timeout: 5_000 });
  await linkButton.click();
}

/** Fill the shared LinkTargetDialog with an exact ResourceRef (Target Behavior
 * item 2: the dialog "accepts text or an exact ResourceRef") so the target is a
 * single, unambiguous resource — no dependence on hybrid ranking or fixture
 * titles — and return its one option row. */
async function searchExactTarget(page: Page, ref: string): Promise<Locator> {
  const dialog = page.getByRole("dialog", { name: "Link" });
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  const combobox = dialog.getByRole("combobox", { name: "Link search" });
  await combobox.fill(ref);
  const listbox = dialog.getByRole("listbox", { name: "Link targets" });
  const option = listbox.getByRole("option").first();
  await expect(option).toBeVisible({ timeout: 10_000 });
  return option;
}

/** Confirm a target and await the single `/resource-graph/links` POST it fires,
 * returning the parsed CreateLinkOut so the caller can assert `created`, harvest
 * `created_source_ref` (the materialized Highlight), and drive Undo by
 * `connection.edge_id`. */
async function confirmTarget(page: Page, option: Locator): Promise<{
  created: boolean;
  createdSourceRef: string | null;
  linkId: string;
}> {
  const [response] = await Promise.all([
    page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        new URL(res.url()).pathname === LINKS_PATHNAME,
      { timeout: 20_000 },
    ),
    option.click(),
  ]);
  const body = await response.text();
  expect(
    response.ok(),
    `Link create failed with ${response.status()} ${response.statusText()}: ${body}`,
  ).toBeTruthy();
  const data = (
    JSON.parse(body) as {
      data: {
        created: boolean;
        created_source_ref: string | null;
        connection: { edge_id: string };
      };
    }
  ).data;
  return {
    created: data.created,
    createdSourceRef: data.created_source_ref,
    linkId: data.connection.edge_id,
  };
}

async function navigateToPdfSelectionPage(page: Page): Promise<number> {
  const targetPageNumber =
    FRESH_REAL_MEDIA_FIXTURES.pdfSvms.selectionPageNumber;
  const controls = activeWorkspacePane(page).getByRole("toolbar", {
    name: "PDF controls",
  });
  await expect(controls).toBeVisible({ timeout: 15_000 });
  const status = controls.locator('[aria-label^="Page "]');
  await expect(status).toBeVisible({ timeout: 15_000 });

  const readCurrentPage = async () => {
    const label = (await status.getAttribute("aria-label")) ?? "";
    const match = /^Page (\d+) of (\d+)$/.exec(label);
    expect(match, `Expected a PDF page status, received "${label}"`).toBeTruthy();
    return Number(match?.[1] ?? 0);
  };

  for (let attempt = 0; attempt < 25; attempt += 1) {
    const currentPageNumber = await readCurrentPage();
    if (currentPageNumber === targetPageNumber) {
      return targetPageNumber;
    }
    const direction =
      currentPageNumber < targetPageNumber ? "Next page" : "Previous page";
    await controls.getByRole("button", { name: direction }).click();
    await expect
      .poll(readCurrentPage, { timeout: 10_000 })
      .toBe(currentPageNumber + (direction === "Next page" ? 1 : -1));
  }
  throw new Error(`Could not navigate PDF reader to page ${targetPageNumber}.`);
}

/** Drag-select a fresh, unique run of text in the fixture's deterministic PDF
 * page. Page 1 repeats text-layer material, so the public reader controls move
 * to the declared unique-text page before a genuine mouse drag over PDF.js
 * spans. */
async function selectFreshPdfText(
  page: Page,
  mediaId: string,
): Promise<{ selectedText: string; pageNumber: number }> {
  const activePane = activeWorkspacePane(page);
  const pageNumber = await navigateToPdfSelectionPage(page);
  await expect(
    activePane
      .locator('[aria-label="PDF document"] .textLayer')
      .filter({ hasText: /\S/ })
      .first(),
  ).toBeVisible({ timeout: 15_000 });

  const textLayerSelector = `${ACTIVE_WORKSPACE_PANE_SELECTOR} .page[data-page-number="${pageNumber}"] .textLayer`;
  const textLayer = page
    .locator(textLayerSelector)
    .filter({ hasText: /\S/ })
    .first();
  await expect(textLayer).toBeVisible({ timeout: 15_000 });
  await expect(textLayer).toBeInViewport({ ratio: 0.25, timeout: 15_000 });

  const existing = await page.request.get(
    `/api/media/${mediaId}/pdf-highlights?page_number=${pageNumber}&mine_only=false`,
  );
  expect(existing.ok()).toBeTruthy();
  const existingExacts = (
    (await existing.json()) as {
      data: { highlights: Array<{ exact?: string | null }> };
    }
  ).data.highlights.flatMap((highlight) =>
    highlight.exact ? [highlight.exact] : [],
  );

  const selectedText = await selectFreshVisibleTextSnippet(
    page,
    textLayerSelector,
    existingExacts,
  );
  return { selectedText, pageNumber };
}

async function pdfHighlightIds(
  page: Page,
  mediaId: string,
  pageNumber: number,
): Promise<string[]> {
  const response = await page.request.get(
    `/api/media/${mediaId}/pdf-highlights?page_number=${pageNumber}&mine_only=true`,
  );
  expect(response.ok()).toBeTruthy();
  return (
    (await response.json()) as {
      data: { highlights: Array<{ id: string }> };
    }
  ).data.highlights.map((highlight) => highlight.id);
}

function refId(ref: string | null): string {
  if (!ref) throw new Error("Expected a created_source_ref for a fresh selection");
  return ref.slice(ref.indexOf(":") + 1);
}

test("@real-media PDF text-layer drag links to a target, undo keeps the highlight, remove and opposite-end activation resolve", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const seed = readRealMediaSeed();
  // Cross-document target: a distinct, pre-seeded, always-ready EPUB. Addressed
  // by exact ResourceRef so it resolves to exactly one resource option.
  const targetMediaId: string = seed.fixtures.epub.media_id;
  const targetRef = `media:${targetMediaId}`;

  const upload = await uploadFreshRealMediaFileThroughUi({
    page,
    artifactPath: PDF_FIXTURE_PATH,
    filename: "svms-universal-linking.pdf",
    mimeType: "application/pdf",
    expectedSizeBytes: FRESH_REAL_MEDIA_FIXTURES.pdfSvms.sizeBytes,
    seededMediaId: seed.fixtures.pdf.media_id,
    artifactSalt: "universal-linking-pdf",
  });
  const mediaId = upload.media_id;

  let productError: unknown = null;
  try {
    await gotoRealMediaSinglePane(page, `/media/${mediaId}`);
    const targetTitle = (
      (await (await page.request.get(`/api/media/${targetMediaId}`)).json()) as {
        data: { title: string };
      }
    ).data.title;

    // --- Link from a real PDF text-layer drag (AC16) ---------------------
    const { pageNumber: selectionPageNumber } = await selectFreshPdfText(
      page,
      mediaId,
    );
    const selectionActions = page.getByRole("group", {
      name: /selection actions/i,
    });
    await expect(selectionActions).toBeVisible({ timeout: 5_000 });
    await clickLinkAction(selectionActions);

    const firstOption = await searchExactTarget(page, targetRef);
    const firstLink = await confirmTarget(page, firstOption);
    expect(firstLink.created).toBe(true);
    const materializedHighlightId = refId(firstLink.createdSourceRef);

    await expect(
      toastByTitle(page, /Linked to /),
      "a created Link surfaces the Linked toast with Undo",
    ).toBeVisible({ timeout: 10_000 });
    const linkedToast = toastByTitle(page, /Linked to /);
    await expect(linkedToast.getByRole("button", { name: "Undo" })).toBeVisible();

    // The fresh selection materialized exactly one durable Highlight (invariant 6:
    // it is written only because the Link confirmed).
    expect(
      await pdfHighlightIds(page, mediaId, selectionPageNumber),
    ).toContain(materializedHighlightId);

    // --- Undo removes only the Link; the Highlight survives (AC10, invariant 8) --
    const [undoResponse] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.request().method() === "DELETE" &&
          new URL(res.url()).pathname === `${LINKS_PATHNAME}/${firstLink.linkId}`,
        { timeout: 15_000 },
      ),
      linkedToast.getByRole("button", { name: "Undo" }).click(),
    ]);
    expect(undoResponse.ok()).toBeTruthy();
    expect(
      await pdfHighlightIds(page, mediaId, selectionPageNumber),
      "Undo deletes the Link but keeps the authored Highlight",
    ).toContain(materializedHighlightId);

    // --- A second Link, then opposite-end activation + Remove -------------
    const { selectedText: secondSelectedText } = await selectFreshPdfText(
      page,
      mediaId,
    );
    await expect(selectionActions).toBeVisible({ timeout: 5_000 });
    await clickLinkAction(selectionActions);
    const secondOption = await searchExactTarget(page, targetRef);
    const secondLink = await confirmTarget(page, secondOption);
    expect(secondLink.created).toBe(true);
    const secondLinkedToast = toastByTitle(page, /Linked to /);
    await expect(secondLinkedToast).toBeVisible({ timeout: 10_000 });
    await dismissToast(secondLinkedToast);

    const evidence = await openEvidencePane(page);
    const secondHighlightRow = evidenceHighlightArticle(
      evidence,
      secondSelectedText,
    );
    await secondHighlightRow
      .getByRole("button", { name: "1 linked object" })
      .click();
    const targetButton = secondHighlightRow.getByRole("button", {
      name: `Open target in reader for ${targetTitle}`,
    });
    const removeButton = secondHighlightRow.getByRole("button", {
      name: `Remove connection to ${targetTitle}`,
    });
    await expect(
      removeButton,
      "the confirmed Link renders one Connections row with a Remove control",
    ).toBeVisible({ timeout: 10_000 });

    // Opposite-end activation opens the target document in the reader (AC16/AC17:
    // each reader row activates the opposite endpoint).
    await expect(targetButton).toBeEnabled();
    await targetButton.click();
    await expect
      .poll(() => page.url(), { timeout: 15_000 })
      .toContain(targetMediaId);

    // Back to the source reader; Remove deletes the Link (AC10).
    await gotoRealMediaSinglePane(page, `/media/${mediaId}`);
    const evidenceAgain = await openEvidencePane(page);
    const secondHighlightRowAgain = evidenceHighlightArticle(
      evidenceAgain,
      secondSelectedText,
    );
    await secondHighlightRowAgain
      .getByRole("button", { name: "1 linked object" })
      .click();
    const removeAgain = secondHighlightRowAgain.getByRole("button", {
      name: `Remove connection to ${targetTitle}`,
    });
    await expect(removeAgain).toBeVisible({ timeout: 10_000 });
    const [removeResponse] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.request().method() === "DELETE" &&
          new URL(res.url()).pathname.startsWith(`${LINKS_PATHNAME}/`),
        { timeout: 15_000 },
      ),
      removeAgain.click(),
    ]);
    expect(removeResponse.ok()).toBeTruthy();
    await expect(removeAgain).toHaveCount(0, { timeout: 10_000 });
    // Removing the Link never touches the authored Highlights.
    expect(
      await pdfHighlightIds(page, mediaId, selectionPageNumber),
    ).toContain(materializedHighlightId);
  } catch (error) {
    productError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    try {
      // Deleting the uploaded media removes its Highlights, passage anchors, and
      // every Link edge touching it via the explicit owner cleanup; the shared
      // seeded target media is never deleted.
      await deleteE2eResource(
        page.request,
        `/api/media/${mediaId}`,
        "universal-linking PDF upload media",
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
    throwE2eCleanupFailures("universal-linking PDF", productError, cleanupErrors);
  }
});

test("@real-media reflowable Link: cancel writes nothing, a Connections row appears, and a duplicate is Already linked with no Undo", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const seed = readRealMediaSeed();
  const targetMediaId: string = seed.fixtures.pdf.media_id;
  const targetRef = `media:${targetMediaId}`;
  const htmlRenderer = `${ACTIVE_WORKSPACE_PANE_SELECTOR} [data-testid="html-renderer"]`;

  const upload = await uploadFreshRealMediaFileThroughUi({
    page,
    artifactPath: EPUB_FIXTURE_PATH,
    filename: "moby-dick-old-universal-linking.epub",
    mimeType: "application/epub+zip",
    expectedSizeBytes: FRESH_REAL_MEDIA_FIXTURES.epubMobyDickOld.sizeBytes,
    seededMediaId: seed.fixtures.epub.media_id,
    artifactSalt: "universal-linking-epub",
  });
  const mediaId = upload.media_id;

  let productError: unknown = null;
  try {
    await gotoRealMediaSinglePane(page, `/media/${mediaId}`);
    const targetTitle = (
      (await (await page.request.get(`/api/media/${targetMediaId}`)).json()) as {
        data: { title: string };
      }
    ).data.title;
    // The EPUB's first spine entry is intentionally a cover-only section. Use
    // the reader's public navigation control to enter the fixture's stable prose
    // chapter before exercising text selection; a cover is a valid cold-open
    // state and must not be mistaken for a missing reader.
    const sectionSelect = activeWorkspacePane(page).getByRole("combobox", {
      name: "Select section",
    });
    await expect(sectionSelect).toBeVisible({ timeout: 15_000 });
    const proseSection = sectionSelect.getByRole("option", {
      name: FRESH_REAL_MEDIA_FIXTURES.epubMobyDickOld.selectionSectionLabel,
      exact: true,
    });
    await expect(proseSection).toHaveCount(1, { timeout: 10_000 });
    const proseSectionId = await proseSection.getAttribute("value");
    expect(proseSectionId).toBeTruthy();
    await sectionSelect.selectOption(proseSectionId!);
    await expect(sectionSelect).toHaveValue(proseSectionId!);

    const reader = page.locator(htmlRenderer).filter({ hasText: /\S/ }).first();
    await expect(reader).toBeVisible({ timeout: 15_000 });
    await reader.scrollIntoViewIfNeeded();

    // --- Cancel writes nothing (Invariant 6) -----------------------------
    let writeCount = 0;
    const countWrites = (request: { method(): string; url(): string }) => {
      if (isLinkOrHighlightWrite(request)) writeCount += 1;
    };
    page.on("request", countWrites);
    try {
      await selectFreshVisibleTextSnippet(page, htmlRenderer, []);
      const selectionActions = page.getByRole("group", {
        name: /selection actions/i,
      });
      await expect(selectionActions).toBeVisible({ timeout: 5_000 });
      await clickLinkAction(selectionActions);
      const dialog = page.getByRole("dialog", { name: "Link" });
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden({ timeout: 5_000 });
      // Give any errant debounced write a chance to fire before asserting none did.
      await page.waitForTimeout(750);
      expect(
        writeCount,
        "opening and cancelling the Link dialog must perform zero writes",
      ).toBe(0);
    } finally {
      page.off("request", countWrites);
    }

    // --- Fresh selection -> confirmed Link -> Connections row ------------
    const linkedSelectionText = await selectFreshVisibleTextSnippet(
      page,
      htmlRenderer,
      [],
    );
    const selectionActions = page.getByRole("group", {
      name: /selection actions/i,
    });
    await expect(selectionActions).toBeVisible({ timeout: 5_000 });
    await clickLinkAction(selectionActions);
    const option = await searchExactTarget(page, targetRef);
    const link = await confirmTarget(page, option);
    expect(link.created).toBe(true);
    const highlightId = refId(link.createdSourceRef);
    const linkedToast = toastByTitle(page, /Linked to /);
    await expect(linkedToast).toBeVisible({ timeout: 10_000 });
    await dismissToast(linkedToast);

    const evidence = await openEvidencePane(page);
    const linkedHighlightRow = evidenceHighlightArticle(
      evidence,
      linkedSelectionText,
    );
    await linkedHighlightRow
      .getByRole("button", { name: "1 linked object" })
      .click();
    await expect(
      linkedHighlightRow.getByRole("button", {
        name: `Remove connection to ${targetTitle}`,
      }),
      "the confirmed neutral Link folds into one Connections row",
    ).toBeVisible({ timeout: 10_000 });

    // --- Duplicate from the now-existing Highlight is Already linked (AC15) ---
    // The durable Highlight must paint without a reload, and its canonical
    // Evidence-row action must compute existing-link dedupe for the same
    // `highlight:` source.
    const paintedHighlight = page
      .locator(`${htmlRenderer} [data-active-highlight-ids~="${highlightId}"]`)
      .first();
    await expect(paintedHighlight).toBeVisible({ timeout: 10_000 });
    await linkedHighlightRow
      .getByRole("button", { name: "Highlight actions" })
      .click();
    await page.getByRole("menuitem", { name: "Link…" }).click();

    const dialog = page.getByRole("dialog", { name: "Link" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog.getByRole("combobox", { name: "Link search" }).fill(targetRef);
    const listbox = dialog.getByRole("listbox", { name: "Link targets" });
    const linkedOption = listbox
      .getByRole("option")
      .filter({ hasText: "Linked" })
      .first();
    await expect(
      linkedOption,
      "an already-linked target keeps a non-color-only Linked state (AC15)",
    ).toBeVisible({ timeout: 10_000 });
    const duplicate = await confirmTarget(page, linkedOption);
    expect(duplicate.created).toBe(false);

    const dupToast = toastByTitle(page, /Already linked to /);
    await expect(dupToast).toBeVisible({ timeout: 10_000 });
    await expect(
      dupToast.getByRole("button", { name: "View connection" }),
    ).toBeVisible();
    await expect(
      dupToast.getByRole("button", { name: "Undo" }),
      "a duplicate offers View, never Undo (AC15)",
    ).toHaveCount(0);
  } catch (error) {
    productError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    try {
      await deleteE2eResource(
        page.request,
        `/api/media/${mediaId}`,
        "universal-linking EPUB upload media",
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
    throwE2eCleanupFailures("universal-linking reflowable", productError, cleanupErrors);
  }
});
