"use client";

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { useEvidenceFilters } from "@/lib/reader/useEvidenceFilters";
import EvidencePaneSurface from "./EvidencePaneSurface";

vi.mock("@/components/notes/HighlightNoteEditor", () => ({
  default: function MockHighlightNoteEditor() {
    return <div data-testid="mock-note-editor" />;
  },
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
}: Partial<
  Pick<
    React.ComponentProps<typeof EvidencePaneSurface>,
    | "highlights"
    | "readerApparatusRows"
    | "connectionRows"
    | "readerApparatus"
    | "isMobile"
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
        onCite={vi.fn()}
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
            onCite={vi.fn()}
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
});
