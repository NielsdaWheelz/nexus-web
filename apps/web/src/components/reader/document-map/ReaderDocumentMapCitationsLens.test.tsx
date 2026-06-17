import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ReaderDocumentMapCitationsLens from "./ReaderDocumentMapCitationsLens";
import type {
  ReaderApparatusCapabilities,
  ReaderApparatusItem,
  ReaderApparatusRow,
} from "@/lib/reader/apparatus";

const capabilities = {
  has_inline_markers: true,
  has_sidecar_items: true,
  supports_hover_preview: true,
  supports_jump_to_marker: true,
  supports_jump_to_target: true,
  has_probable_items: false,
} satisfies ReaderApparatusCapabilities;

const row = {
  id: "marker-1",
  marker: {
    stable_key: "marker-1",
    kind: "footnote_ref",
    label: "1",
    body_text: null,
    body_html_sanitized: null,
    locator: {
      type: "web_text_offsets",
      media_id: "media-1",
      fragment_id: "fragment-1",
      start_offset: 5,
      end_offset: 6,
      media_kind: "web_article",
      text_quote_selector: { exact: "1" },
    },
    locator_status: "exact",
    confidence: "exact",
    extraction_method: "dpub_aria",
    source_ref: {},
    sort_key: "000000.marker",
  },
  targets: [
    {
      stable_key: "note-1",
      kind: "footnote",
      label: "1",
      body_text: "The source-authored note.",
      body_html_sanitized: null,
      locator: {
        type: "web_text_offsets",
        media_id: "media-1",
        fragment_id: "fragment-1",
        start_offset: 20,
        end_offset: 44,
        media_kind: "web_article",
        text_quote_selector: { exact: "The source-authored note." },
      },
      locator_status: "exact",
      confidence: "exact",
      extraction_method: "dpub_aria",
      source_ref: {},
      sort_key: "000000.target",
    },
  ],
  edges: [
    {
      stable_key: "marker-1->note-1",
      from_stable_key: "marker-1",
      to_stable_key: "note-1",
      relation: "points_to_note",
      confidence: "exact",
      extraction_method: "dpub_aria",
      source_ref: {},
      sort_key: "000000.edge",
    },
  ],
  target: {
    stable_key: "note-1",
    kind: "footnote",
    label: "1",
    body_text: "The source-authored note.",
    body_html_sanitized: null,
    locator: {
      type: "web_text_offsets",
      media_id: "media-1",
      fragment_id: "fragment-1",
      start_offset: 20,
      end_offset: 44,
      media_kind: "web_article",
      text_quote_selector: { exact: "The source-authored note." },
    },
    locator_status: "exact",
    confidence: "exact",
    extraction_method: "dpub_aria",
    source_ref: {},
    sort_key: "000000.target",
  },
  edge: {
    stable_key: "marker-1->note-1",
    from_stable_key: "marker-1",
    to_stable_key: "note-1",
    relation: "points_to_note",
    confidence: "exact",
    extraction_method: "dpub_aria",
    source_ref: {},
    sort_key: "000000.edge",
  },
  sort_key: "000000.marker",
} satisfies ReaderApparatusRow;

describe("ReaderDocumentMapCitationsLens", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserverMock {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });

  it("renders source-authored citation rows and activates them", () => {
    const onActivateRow = vi.fn();
    const contentElement = document.createElement("div");
    render(
      <ReaderDocumentMapCitationsLens
        rows={[row]}
        capabilities={capabilities}
        contentRef={{ current: contentElement }}
        activeItemId={null}
        hoveredItemId={null}
        onActivateRow={onActivateRow}
        onHoverItem={vi.fn()}
        isMobile
      />,
    );

    expect(screen.getByRole("heading", { name: "Citations" })).toBeVisible();
    expect(screen.getByText("The source-authored note.")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /Footnote/ }));
    expect(onActivateRow).toHaveBeenCalledWith(row);
  });

  it("renders every target body for a multi-reference row", () => {
    const multiReferenceRow = {
      ...row,
      marker: {
        ...row.marker,
        kind: "bibliography_ref",
        label: "[1, 2]",
      },
      targets: [
        {
          ...row.target,
          stable_key: "reference-1",
          kind: "bibliography_entry",
          label: "[1]",
          body_text: "[1] Alpha Paper.",
        },
        {
          ...row.target,
          stable_key: "reference-2",
          kind: "bibliography_entry",
          label: "[2]",
          body_text: "[2] Beta Paper.",
        },
      ],
      target: {
        ...row.target,
        stable_key: "reference-1",
        kind: "bibliography_entry",
        label: "[1]",
        body_text: "[1] Alpha Paper.",
      },
      edges: [
        {
          ...row.edge,
          stable_key: "marker-1->reference-1",
          relation: "cites_bibliography_entry",
          to_stable_key: "reference-1",
        },
        {
          ...row.edge,
          stable_key: "marker-1->reference-2",
          relation: "cites_bibliography_entry",
          to_stable_key: "reference-2",
        },
      ],
      edge: {
        ...row.edge,
        stable_key: "marker-1->reference-1",
        relation: "cites_bibliography_entry",
        to_stable_key: "reference-1",
      },
    } satisfies ReaderApparatusRow;

    render(
      <ReaderDocumentMapCitationsLens
        rows={[multiReferenceRow]}
        capabilities={capabilities}
        contentRef={{ current: document.createElement("div") }}
        activeItemId={null}
        hoveredItemId={null}
        onActivateRow={vi.fn()}
        onHoverItem={vi.fn()}
        isMobile
      />,
    );

    expect(screen.getByText("[1] Alpha Paper.")).toBeVisible();
    expect(screen.getByText("[2] Beta Paper.")).toBeVisible();
  });

  it("renders target-only margin notes as clickable target rows", () => {
    const onActivateRow = vi.fn();
    const onHoverItem = vi.fn();
    const marginNote: ReaderApparatusItem = {
      ...row.target,
      stable_key: "margin-1",
      kind: "margin_note",
      label: "Margin note 1",
      body_text: "Standalone margin note body.",
      sort_key: "000001.target",
    };
    const marginRow = {
      id: "margin-1",
      marker: marginNote,
      targets: [marginNote],
      edges: [],
      target: marginNote,
      edge: null,
      sort_key: "000001.target",
    } satisfies ReaderApparatusRow;

    render(
      <ReaderDocumentMapCitationsLens
        rows={[marginRow]}
        capabilities={{
          ...capabilities,
          supports_hover_preview: false,
          supports_jump_to_marker: false,
          supports_jump_to_target: true,
        }}
        contentRef={{ current: document.createElement("div") }}
        activeItemId="margin-1"
        hoveredItemId={null}
        onActivateRow={onActivateRow}
        onHoverItem={onHoverItem}
        isMobile
      />,
    );

    const button = screen.getByRole("button", { name: /Margin note/ });
    expect(button).toHaveAttribute("data-active", "true");
    expect(button).toHaveAttribute("data-interactive", "true");
    expect(screen.getByText("Standalone margin note body.")).toBeVisible();
    expect(
      screen.queryByText("Citation marker detected; target not resolved."),
    ).not.toBeInTheDocument();

    fireEvent.mouseEnter(button);
    expect(onHoverItem).toHaveBeenCalledWith("margin-1");
    fireEvent.click(button);
    expect(onActivateRow).toHaveBeenCalledWith(marginRow);
  });

  it("renders partial marker-only PDF rows as marker-jumpable without target preview", () => {
    const onActivateRow = vi.fn();
    const markerOnlyRow = {
      ...row,
      marker: {
        ...row.marker,
        kind: "bibliography_ref",
        label: "[13]",
        locator: {
          type: "pdf_page_geometry",
          media_id: "media-1",
          page_number: 2,
          quads: [
            {
              x1: 10,
              y1: 20,
              x2: 20,
              y2: 20,
              x3: 20,
              y3: 30,
              x4: 10,
              y4: 30,
            },
          ],
          exact: "[13]",
          text_quote_selector: { exact: "[13]" },
        },
        extraction_method: "pdf_native_link",
      },
      targets: [],
      edges: [],
      target: null,
      edge: null,
    } satisfies ReaderApparatusRow;

    render(
      <ReaderDocumentMapCitationsLens
        rows={[markerOnlyRow]}
        capabilities={{
          ...capabilities,
          supports_hover_preview: false,
          supports_jump_to_target: false,
        }}
        contentRef={{ current: document.createElement("div") }}
        activeItemId={null}
        hoveredItemId={null}
        onActivateRow={onActivateRow}
        onHoverItem={vi.fn()}
        isMobile
        pdfActivePage={2}
      />,
    );

    expect(
      screen.getByText("1 source-authored marker pending target resolution."),
    ).toBeVisible();
    expect(
      screen.getByText("Citation marker detected; target not resolved."),
    ).toBeVisible();
    expect(screen.queryByText("Target unavailable")).not.toBeInTheDocument();

    const button = screen.getByRole("button", { name: /Reference/ });
    expect(button).toHaveAttribute("data-interactive", "true");
    fireEvent.click(button);
    expect(onActivateRow).toHaveBeenCalledWith(markerOnlyRow);
  });
});
