"use client";

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import type { ReaderConnectionRow } from "@/lib/reader/documentMap";
import { useEvidenceFilters } from "@/lib/reader/useEvidenceFilters";
import EvidencePaneSurface from "./EvidencePaneSurface";

vi.mock("@/components/notes/HighlightNoteEditor", () => ({
  default: function MockHighlightNoteEditor() {
    return <div data-testid="mock-note-editor" />;
  },
}));

const fetchNoteBlockMock = vi.fn();
vi.mock("@/lib/notes/api", () => ({
  fetchNoteBlock: (blockId: string) => fetchNoteBlockMock(blockId),
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe = vi.fn();
    disconnect = vi.fn();
  },
);

function EvidencePaneSurfaceHarness({
  highlights = [],
  readerApparatusRows = [],
  connectionRows = [],
  readerApparatus = null,
  isMobile = true,
  onRemoveLink = vi.fn(),
  onSaveLinkNote = vi.fn().mockResolvedValue({ note_block_id: "nb-new" }),
  onDeleteLinkNote = vi.fn().mockResolvedValue(undefined),
}: Partial<
  Pick<
    React.ComponentProps<typeof EvidencePaneSurface>,
    | "highlights"
    | "readerApparatusRows"
    | "connectionRows"
    | "readerApparatus"
    | "isMobile"
    | "onRemoveLink"
    | "onSaveLinkNote"
    | "onDeleteLinkNote"
  >
>) {
  const contentRef = useRef<HTMLDivElement>(null);
  const filters = useEvidenceFilters();
  return (
    <FeedbackProvider>
      <div ref={contentRef} style={{ height: 700 }}>
        <p>Reader content</p>
      </div>
      <EvidencePaneSurface
        contentRef={contentRef}
        filters={filters}
        onLink={vi.fn()}
        highlights={highlights}
        readerApparatusRows={readerApparatusRows}
        connectionRows={connectionRows}
        readerApparatus={readerApparatus}
        focusedApparatusItemId={null}
        focusedHighlightId={null}
        isReflowable
        isEditingBounds={false}
        hoveredId={null}
        canQuoteToChat={false}
        loading={false}
        error={null}
        measureKey="test"
        layoutVersion={0}
        isMobile={isMobile}
        onHighlightClick={vi.fn()}
        onFocusHighlight={vi.fn()}
        onHoverHighlight={vi.fn()}
        onQuoteToChat={vi.fn()}
        onColorChange={vi.fn()}
        onDelete={vi.fn()}
        onStartEditBounds={vi.fn()}
        onCancelEditBounds={vi.fn()}
        onNoteSave={vi.fn()}
        onNoteDelete={vi.fn()}
        onOpenConversation={vi.fn()}
        onOpenNoteLink={vi.fn()}
        onApparatusRowActivate={vi.fn()}
        onOpenConnectionSource={vi.fn()}
        onActivateConnectionTarget={vi.fn()}
        onDismissSynapse={vi.fn()}
        onRemoveLink={onRemoveLink}
        onSaveLinkNote={onSaveLinkNote}
        onDeleteLinkNote={onDeleteLinkNote}
      />
    </FeedbackProvider>
  );
}

// Use React here to avoid a lint error from JSX without the import
import React from "react";
import type { AnchoredReaderRow } from "@/components/reader/useAnchoredReaderProjection";

function pdfHighlightRow(id: string): AnchoredReaderRow {
  return {
    id,
    exact: `highlight ${id}`,
    color: "yellow",
    page_number: 1,
    quads: [{ x1: 0, y1: 0, x2: 1, y2: 0, x3: 1, y3: 1, x4: 0, y4: 1 }],
    stable_order_key: `000001:${id}`,
    is_owner: true,
  };
}

describe("EvidencePaneSurface", () => {
  describe("AC-15 empty state", () => {
    it("shows the empty-state message when all source arrays are empty", () => {
      render(<EvidencePaneSurfaceHarness />);
      expect(
        screen.getByText("No highlights, citations, or connections in this context."),
      ).toBeInTheDocument();
    });

    it("renders the Evidence heading even when empty", () => {
      render(<EvidencePaneSurfaceHarness />);
      expect(screen.getByRole("heading", { name: "Evidence" })).toBeInTheDocument();
    });

    it("renders all three filter toggles in the initial state", () => {
      render(<EvidencePaneSurfaceHarness />);
      const nav = screen.getByRole("navigation", { name: "Evidence filter" });
      const buttons = within(nav).getAllByRole("button");
      expect(buttons.map((b) => b.textContent)).toEqual([
        "Highlights",
        "Citations",
        "Connections",
      ]);
      for (const button of buttons) {
        expect(button).toHaveAttribute("aria-pressed", "true");
      }
    });
  });

  describe("loading and error states", () => {
    it("renders a loading notice when loading=true", () => {
      const contentRef = { current: null };
      render(
        <FeedbackProvider>
          <EvidencePaneSurface
            contentRef={contentRef as React.RefObject<HTMLElement | null>}
            filters={{
              filter: { highlight: true, apparatus: true, connection: true },
              toggleFilter: vi.fn(),
            }}
            onLink={vi.fn()}
            highlights={[]}
            readerApparatusRows={[]}
            connectionRows={[]}
            readerApparatus={null}
            focusedApparatusItemId={null}
            focusedHighlightId={null}
            isReflowable
            isEditingBounds={false}
            hoveredId={null}
            canQuoteToChat={false}
            loading
            error={null}
            measureKey="test"
            layoutVersion={0}
            isMobile
            onHighlightClick={vi.fn()}
            onFocusHighlight={vi.fn()}
            onHoverHighlight={vi.fn()}
            onQuoteToChat={vi.fn()}
            onColorChange={vi.fn()}
            onDelete={vi.fn()}
            onStartEditBounds={vi.fn()}
            onCancelEditBounds={vi.fn()}
            onNoteSave={vi.fn()}
            onNoteDelete={vi.fn()}
            onOpenConversation={vi.fn()}
            onOpenNoteLink={vi.fn()}
            onApparatusRowActivate={vi.fn()}
            onOpenConnectionSource={vi.fn()}
            onActivateConnectionTarget={vi.fn()}
            onDismissSynapse={vi.fn()}
            onRemoveLink={vi.fn()}
            onSaveLinkNote={vi.fn()}
            onDeleteLinkNote={vi.fn()}
          />
        </FeedbackProvider>,
      );
      expect(screen.getByText("Loading evidence...")).toBeInTheDocument();
    });
  });

  describe("filter toggles", () => {
    it("deactivates a filter category when clicked and re-activates on second click", async () => {
      render(<EvidencePaneSurfaceHarness />);
      const user = userEvent.setup();
      const highlightsToggle = screen.getByRole("button", { name: "Highlights" });
      expect(highlightsToggle).toHaveAttribute("aria-pressed", "true");
      await user.click(highlightsToggle);
      expect(highlightsToggle).toHaveAttribute("aria-pressed", "false");
      await user.click(highlightsToggle);
      expect(highlightsToggle).toHaveAttribute("aria-pressed", "true");
    });
  });

  describe("accessibility landmarks", () => {
    it("renders a region landmark labelled Evidence", () => {
      render(<EvidencePaneSurfaceHarness />);
      expect(screen.getByRole("region", { name: "Evidence" })).toBeInTheDocument();
    });
  });

  describe("highlight row dedup", () => {
    it("renders one row per highlight id even if a highlight is supplied twice", () => {
      render(
        <EvidencePaneSurfaceHarness
          highlights={[pdfHighlightRow("dup-1"), pdfHighlightRow("dup-1")]}
        />,
      );
      expect(
        screen.getAllByTestId("evidence-highlight-row-dup-1"),
      ).toHaveLength(1);
    });

    it("renders a distinct row for each unique highlight id", () => {
      render(
        <EvidencePaneSurfaceHarness
          highlights={[pdfHighlightRow("a"), pdfHighlightRow("b")]}
        />,
      );
      expect(screen.getByTestId("evidence-highlight-row-a")).toBeInTheDocument();
      expect(screen.getByTestId("evidence-highlight-row-b")).toBeInTheDocument();
    });
  });

  describe("user_link connection rows", () => {
    function userLinkRow(opts: {
      edgeId: string;
      kind: "context" | "supports" | "contradicts";
      linkNote?: {
        ref: string;
        note_block_id: string;
        preview: string | null;
      } | null;
    }): ReaderConnectionRow {
      return {
        id: `edge:${opts.edgeId}`,
        connection: {
          edge_id: opts.edgeId,
          direction: "undirected",
          kind: opts.kind,
          origin: "user",
          snapshot: null,
          source_order_key: null,
          target_order_key: null,
          ordinal: null,
          source_ref: "media:src",
          target_ref: "media:dst",
          source: {} as ReaderConnectionRow["connection"]["source"],
          target: {} as ReaderConnectionRow["connection"]["target"],
          other: { ref: "media:other" } as ReaderConnectionRow["connection"]["other"],
          citation: null,
          link_note: opts.linkNote ?? null,
          created_at: "2026-07-20T00:00:00Z",
        },
        anchor: null,
        source_category: "user_link",
        title: "Other Work",
        subtitle: null,
        excerpt: null,
        activation: {} as ReaderConnectionRow["activation"],
        href: "/media/other#p",
      };
    }

    it("shows Remove (not Note) on a stance row and calls onRemoveLink with the row", async () => {
      const onRemoveLink = vi.fn();
      const row = userLinkRow({ edgeId: "e-stance", kind: "supports" });
      render(
        <EvidencePaneSurfaceHarness connectionRows={[row]} onRemoveLink={onRemoveLink} />,
      );
      const user = userEvent.setup();
      expect(
        screen.queryByRole("button", { name: /add note|edit note/i }),
      ).not.toBeInTheDocument();
      await user.click(
        screen.getByRole("button", { name: "Remove connection to Other Work" }),
      );
      expect(onRemoveLink).toHaveBeenCalledWith(expect.objectContaining({ id: row.id }));
    });

    it("shows Remove and Add note on a neutral (context) Link row without a note", async () => {
      const onRemoveLink = vi.fn();
      const row = userLinkRow({ edgeId: "e-link", kind: "context", linkNote: null });
      render(
        <EvidencePaneSurfaceHarness connectionRows={[row]} onRemoveLink={onRemoveLink} />,
      );
      const user = userEvent.setup();
      expect(
        screen.getByRole("button", { name: "Add note to link to Other Work" }),
      ).toBeInTheDocument();
      await user.click(
        screen.getByRole("button", { name: "Remove connection to Other Work" }),
      );
      expect(onRemoveLink).toHaveBeenCalledWith(expect.objectContaining({ id: row.id }));
    });

    it("adding a note renders the editor immediately with no fetch (nothing to lose)", async () => {
      const row = userLinkRow({ edgeId: "e-link", kind: "context", linkNote: null });
      render(<EvidencePaneSurfaceHarness connectionRows={[row]} />);
      const user = userEvent.setup();
      await user.click(
        screen.getByRole("button", { name: "Add note to link to Other Work" }),
      );
      expect(screen.getByTestId("mock-note-editor")).toBeInTheDocument();
      expect(fetchNoteBlockMock).not.toHaveBeenCalled();
    });

    it("editing an existing note fetches the full body before showing the editor", async () => {
      let resolveFetch!: (block: unknown) => void;
      fetchNoteBlockMock.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
      );
      const row = userLinkRow({
        edgeId: "e-link",
        kind: "context",
        linkNote: { ref: "note_block:nb-1", note_block_id: "nb-1", preview: "full…" },
      });
      render(<EvidencePaneSurfaceHarness connectionRows={[row]} />);
      const user = userEvent.setup();
      await user.click(
        screen.getByRole("button", { name: "Edit note on link to Other Work" }),
      );
      expect(screen.getByText("Loading note…")).toBeInTheDocument();
      expect(fetchNoteBlockMock).toHaveBeenCalledWith("nb-1");
      resolveFetch({
        id: "nb-1",
        parentBlockId: null,
        orderKey: null,
        bodyPmJson: { type: "doc" },
        bodyText: "full body",
        collapsed: false,
        children: [],
      });
      expect(await screen.findByTestId("mock-note-editor")).toBeInTheDocument();
      expect(screen.queryByText("Loading note…")).not.toBeInTheDocument();
    });

    it("Remove note calls onDeleteLinkNote with the link id", async () => {
      fetchNoteBlockMock.mockResolvedValueOnce({
        id: "nb-1",
        parentBlockId: null,
        orderKey: null,
        bodyPmJson: { type: "doc" },
        bodyText: "full body",
        collapsed: false,
        children: [],
      });
      const onDeleteLinkNote = vi.fn().mockResolvedValue(undefined);
      const row = userLinkRow({
        edgeId: "e-link",
        kind: "context",
        linkNote: { ref: "note_block:nb-1", note_block_id: "nb-1", preview: "full…" },
      });
      render(
        <EvidencePaneSurfaceHarness
          connectionRows={[row]}
          onDeleteLinkNote={onDeleteLinkNote}
        />,
      );
      const user = userEvent.setup();
      await user.click(
        screen.getByRole("button", { name: "Edit note on link to Other Work" }),
      );
      await user.click(await screen.findByRole("button", { name: "Remove note" }));
      expect(onDeleteLinkNote).toHaveBeenCalledWith("e-link");
    });
  });
});
