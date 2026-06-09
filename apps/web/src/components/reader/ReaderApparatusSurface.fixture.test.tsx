import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ReaderApparatusSurface from "./ReaderApparatusSurface";
import {
  readerApparatusOmittedSurfacePayloadFixtures,
  readerApparatusRowPayloadFixtures,
  type ReaderApparatusFixtureEntry,
  type ReaderApparatusPayloadFixture,
} from "@/lib/reader/__fixtures__/reader-apparatus";
import {
  assertReaderApparatusResponse,
  buildReaderApparatusRows,
} from "@/lib/reader/apparatus";

function renderPayloadSurface(
  payload: ReaderApparatusPayloadFixture,
  options: { isMobile?: boolean; pdfActivePage?: number | null } = {},
) {
  const apparatus = assertReaderApparatusResponse(payload.apparatus);
  const rows = buildReaderApparatusRows(apparatus);
  const onActivateRow = vi.fn();
  const onHoverItem = vi.fn();
  const contentElement = document.createElement("div");
  contentElement.dataset.readerApparatusFixtureContent = "true";
  contentElement.style.position = "absolute";
  contentElement.style.left = "0";
  contentElement.style.top = "0";
  contentElement.style.width = "640px";
  const mountedItemIds = new Set<string>();
  const mountedPdfPages = new Set<number>();
  const mountItem = (itemId: string, label: string | null) => {
    if (mountedItemIds.has(itemId)) return;
    mountedItemIds.add(itemId);
    const element = document.createElement("span");
    element.dataset.readerApparatusItemId = itemId;
    element.textContent = label ?? itemId;
    contentElement.append(element);
  };
  const mountPdfPage = (pageNumber: number) => {
    if (mountedPdfPages.has(pageNumber)) return;
    mountedPdfPages.add(pageNumber);
    const pageElement = document.createElement("div");
    pageElement.className = "page";
    pageElement.dataset.pageNumber = String(pageNumber);
    pageElement.dataset.nexusPageScale = "1";
    pageElement.dataset.nexusPageViewportWidth = "612";
    pageElement.dataset.nexusPageViewportHeight = "792";
    pageElement.dataset.nexusPageDpiScale = "1";
    pageElement.dataset.nexusPageRotation = "0";
    pageElement.style.position = "relative";
    pageElement.style.width = "612px";
    pageElement.style.height = "792px";
    contentElement.append(pageElement);
  };

  for (const row of rows) {
    mountItem(row.id, row.marker.label);
    if (row.marker.locator?.type === "pdf_page_geometry") {
      mountPdfPage(row.marker.locator.page_number);
    }
    for (const target of row.targets) {
      mountItem(target.stable_key, target.label);
      if (target.locator?.type === "pdf_page_geometry") {
        mountPdfPage(target.locator.page_number);
      }
    }
  }
  document.body.append(contentElement);
  fixtureContentElements.push(contentElement);

  render(
    <ReaderApparatusSurface
      rows={rows}
      capabilities={apparatus.capabilities}
      contentRef={{ current: contentElement }}
      activeItemId={null}
      hoveredItemId={null}
      onActivateRow={onActivateRow}
      onHoverItem={onHoverItem}
      isMobile={options.isMobile ?? true}
      pdfActivePage={options.pdfActivePage ?? null}
    />,
  );

  return { apparatus, rows, onActivateRow, onHoverItem };
}

function fixtureEntry(fixtureId: string): ReaderApparatusFixtureEntry {
  const entry = [
    ...readerApparatusRowPayloadFixtures,
    ...readerApparatusOmittedSurfacePayloadFixtures,
  ].find((candidate) => candidate.fixtureId === fixtureId);
  if (!entry) {
    throw new Error(`Missing reader apparatus fixture ${fixtureId}`);
  }
  return entry;
}

let readerApparatusTargetWarnings: unknown[][] = [];
let consoleWarnSpy: { mockRestore: () => void } | null = null;
let fixtureContentElements: HTMLElement[] = [];

describe("ReaderApparatusSurface real API payload fixtures", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserverMock {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    readerApparatusTargetWarnings = [];
    const originalWarn = console.warn;
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation((...args) => {
      if (args[0] === "reader_apparatus_target_missing") {
        readerApparatusTargetWarnings.push(args);
        return;
      }
      originalWarn(...args);
    });
  });

  afterEach(() => {
    const warnings = readerApparatusTargetWarnings;
    consoleWarnSpy?.mockRestore();
    consoleWarnSpy = null;
    for (const element of fixtureContentElements) {
      element.remove();
    }
    fixtureContentElements = [];
    expect(warnings).toEqual([]);
  });

  it.each(readerApparatusRowPayloadFixtures)(
    "renders $fixtureId sidecar rows from the generated backend payload",
    (entry) => {
      const { rows } = renderPayloadSurface(entry.payload);

      expect(rows).toHaveLength(entry.expectedRowCount);
      expect(screen.getByRole("heading", { name: "Citations" })).toBeVisible();
      expect(screen.getAllByRole("button")).toHaveLength(entry.expectedRowCount);

      for (const needle of entry.bodyNeedles) {
        expect(
          screen.getAllByText((content) => content.includes(needle)).length,
          `${entry.fixtureId} body needle ${needle}`,
        ).toBeGreaterThan(0);
      }
    },
  );

  it.each(readerApparatusRowPayloadFixtures)(
    "aligns desktop rows for $fixtureId without missing-target warnings",
    async (entry) => {
      const { rows } = renderPayloadSurface(entry.payload, { isMobile: false });

      await waitFor(() => {
        expect(screen.getAllByRole("button").length).toBe(rows.length);
      });
      await new Promise((resolve) => window.setTimeout(resolve, 200));

      expect(readerApparatusTargetWarnings).toEqual([]);
    },
  );

  it.each(readerApparatusOmittedSurfacePayloadFixtures)(
    "renders $fixtureId as an empty Citations surface when mounted directly",
    (entry) => {
      const { rows } = renderPayloadSurface(entry.payload);

      expect(rows).toEqual([]);
      expect(screen.getByRole("heading", { name: "Citations" })).toBeVisible();
      expect(screen.getByText("No citations in this context.")).toBeVisible();
      expect(screen.queryByRole("button")).not.toBeInTheDocument();

      for (const needle of entry.bodyNeedles) {
        expect(
          screen.queryByText((content) => content.includes(needle)),
        ).not.toBeInTheDocument();
      }
    },
  );

  it("renders Distill bibliography and footnote rows from a backend payload", () => {
    const distillGpPayload = fixtureEntry("html-distill-gp-full").payload;
    const { rows, onActivateRow } = renderPayloadSurface(distillGpPayload);

    expect(rows).toHaveLength(13);
    expect(
      screen.getByText("13 source-authored notes and references in this context."),
    ).toBeVisible();
    expect(
      screen.getAllByText(/Gaussian Processes in Machine Learning/).length,
    ).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByRole("button", { name: /Reference/ })[0]);
    expect(onActivateRow).toHaveBeenCalledWith(rows[0]);
  });

  it("renders target-only Numinous margin notes without hover previews", () => {
    const numinousPayload = fixtureEntry("html-numinous-ttft-full").payload;
    const { rows, onHoverItem } = renderPayloadSurface(numinousPayload);

    expect(rows).toHaveLength(40);
    expect(screen.getByText(/Douglas Engelbart, Augmenting Human Intellect/)).toBeVisible();
    const marginNoteButton = screen.getAllByRole("button", { name: /Margin note/ })[0];

    fireEvent.mouseEnter(marginNoteButton);
    expect(onHoverItem).toHaveBeenCalledWith(rows[0].id);
  });

  it("renders large MediaWiki footnote and works-cited payloads", () => {
    const wikipediaWasteLandPayload = fixtureEntry("html-wikipedia-waste-land-full").payload;
    const { rows } = renderPayloadSurface(wikipediaWasteLandPayload);

    expect(rows).toHaveLength(445);
    expect(screen.getAllByText(/Ackroyd 1984/).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /Footnote|Reference/ }).length).toBe(
      445,
    );
  });

  it("renders Standard Ebooks EPUB endnotes from a backend payload", () => {
    const standardEbooksJamesPayload = fixtureEntry(
      "epub-standardebooks-james-pragmatism",
    ).payload;
    const { rows } = renderPayloadSurface(standardEbooksJamesPayload);

    expect(rows).toHaveLength(13);
    expect(screen.getByText(/Morrison I\. Swift/)).toBeVisible();
    expect(screen.getAllByRole("button", { name: /Endnote/ })).toHaveLength(13);
  });

  it("renders PDF native-link bibliography rows with page context", () => {
    const attentionPdfPayload = fixtureEntry("pdf-attention-native-link-graph").payload;
    const { rows } = renderPayloadSurface(attentionPdfPayload, { pdfActivePage: 2 });

    expect(rows).toHaveLength(76);
    expect(screen.getByText("Page 2")).toBeVisible();
    expect(screen.getAllByText(/Long short-term memory/).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /Reference/ })).toHaveLength(76);
  });

  it("renders synthetic legal PDF footnote rows from a backend payload", () => {
    const lawReviewPdfPayload = fixtureEntry("pdf-law-review-footnotes").payload;
    const { rows } = renderPayloadSurface(lawReviewPdfPayload, { pdfActivePage: 1 });

    expect(rows).toHaveLength(10);
    expect(screen.getByText("Page 1")).toBeVisible();
    expect(screen.getByText(/First legal footnote body/)).toBeVisible();
    expect(screen.getAllByRole("button", { name: /Footnote/ })).toHaveLength(10);
  });
});
