import { useState, type ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfHighlightOut } from "@/components/PdfReader";
import type { Highlight } from "./mediaHelpers";
import MediaHighlightsPaneBody from "./MediaHighlightsPaneBody";

const mockHighlightsPane = vi.fn((props: Record<string, unknown>) => {
  const highlights = (props.highlights as Array<{ id: string }>) ?? [];
  const onHighlightClick = props.onHighlightClick as (highlightId: string) => void;
  return (
    <div data-testid="highlights-pane">
      {highlights.map((highlight) => (
        <button
          key={highlight.id}
          type="button"
          onClick={() => onHighlightClick(highlight.id)}
        >
          {highlight.id}
        </button>
      ))}
    </div>
  );
});

vi.mock("@/components/LinkedItemsPane", () => ({
  default: (props: Record<string, unknown>) => mockHighlightsPane(props),
}));

vi.mock("@/components/ui/StatusPill", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

function makeHighlight(overrides: Partial<Highlight> = {}): Highlight {
  return {
    id: "highlight-1",
    fragment_id: "fragment-1",
    start_offset: 10,
    end_offset: 20,
    color: "yellow",
    exact: "Example highlight",
    prefix: "Before",
    suffix: "After",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    annotation: null,
    linked_conversations: [],
    ...overrides,
  };
}

function makePdfHighlight(overrides: Partial<PdfHighlightOut> = {}): PdfHighlightOut {
  return {
    id: "pdf-highlight-1",
    anchor: {
      type: "pdf_page_geometry",
      media_id: "media-1",
      page_number: 1,
      quads: [
        {
          x1: 10,
          y1: 20,
          x2: 30,
          y2: 20,
          x3: 30,
          y3: 40,
          x4: 10,
          y4: 40,
        },
      ],
    },
    color: "yellow",
    exact: "PDF highlight",
    prefix: "Before",
    suffix: "After",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    annotation: null,
    author_user_id: "user-1",
    is_owner: true,
    linked_conversations: [],
    ...overrides,
  };
}

function buildProps(overrides: Record<string, unknown> = {}) {
  return {
    isPdf: false,
    isEpub: false,
    isMobile: false,
    fragmentHighlights: [makeHighlight()],
    pdfPageHighlights: [] as PdfHighlightOut[],
    highlightsVersion: 1,
    pdfHighlightsVersion: 1,
    pdfActivePage: 1,
    contentRef: { current: document.createElement("div") as HTMLDivElement | null },
    focusedId: null,
    onFocusHighlight: vi.fn(),
    onClearFocus: vi.fn(),
    onSendToChat: vi.fn(),
    onColorChange: vi.fn(async () => {}),
    onDelete: vi.fn(async () => {}),
    onStartEditBounds: vi.fn(),
    onCancelEditBounds: vi.fn(),
    isEditingBounds: false,
    onAnnotationSave: vi.fn(async () => {}),
    onAnnotationDelete: vi.fn(async () => {}),
    onOpenConversation: vi.fn(),
    ...overrides,
  };
}

function getLatestPaneProps(): Record<string, unknown> {
  const latest = mockHighlightsPane.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
  if (!latest) {
    throw new Error("Expected highlights pane to render");
  }
  return latest;
}

function getRenderedHighlightIds(): string[] {
  const highlights = getLatestPaneProps().highlights as Array<{ id: string }> | undefined;
  return highlights?.map((highlight) => highlight.id) ?? [];
}

describe("MediaHighlightsPaneBody", () => {
  beforeEach(() => {
    mockHighlightsPane.mockClear();
  });

  it("renders desktop highlights in contextual order and keeps the focused row selected", () => {
    const exact =
      "This is a deliberately long highlight quote that should stay fully readable when expanded inline.";

    render(
      <MediaHighlightsPaneBody
        {...buildProps({
          focusedId: "highlight-2",
          fragmentHighlights: [
            makeHighlight({ id: "highlight-1", exact: "Earlier highlight", start_offset: 0 }),
            makeHighlight({ id: "highlight-2", exact, start_offset: 40 }),
          ],
        })}
      />
    );

    expect(screen.getByRole("heading", { name: "Highlights" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "All highlights" })).not.toBeInTheDocument();
    expect(getRenderedHighlightIds()).toEqual(["highlight-1", "highlight-2"]);
    expect(getLatestPaneProps().focusedId).toBe("highlight-2");
  });

  it("re-resolves EPUB focus to the first contextual highlight when the prior focus is out of scope", async () => {
    const onFocusHighlight = vi.fn();

    render(
      <MediaHighlightsPaneBody
        {...buildProps({
          isEpub: true,
          focusedId: "missing-highlight",
          onFocusHighlight,
          fragmentHighlights: [
            makeHighlight({ id: "late-highlight", exact: "Later", start_offset: 20 }),
            makeHighlight({ id: "early-highlight", exact: "Earlier", start_offset: 2 }),
          ],
        })}
      />
    );

    expect(screen.getByRole("heading", { name: "Section highlights" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "All highlights" })).not.toBeInTheDocument();

    await waitFor(() => {
      expect(onFocusHighlight).toHaveBeenCalledWith("early-highlight");
    });

    expect(getLatestPaneProps().focusedId).toBe("early-highlight");
  });

  it("clears focus when the contextual set becomes empty", async () => {
    const onClearFocus = vi.fn();

    render(
      <MediaHighlightsPaneBody
        {...buildProps({
          focusedId: "orphaned-highlight",
          fragmentHighlights: [],
          onClearFocus,
        })}
      />
    );

    await waitFor(() => {
      expect(onClearFocus).toHaveBeenCalledTimes(1);
    });

    expect(getLatestPaneProps().highlights).toEqual([]);
    expect(getLatestPaneProps().focusedId).toBeNull();
  });

  it("uses visible-highlights copy on mobile and updates the focused row when tapped", async () => {
    const user = userEvent.setup();
    const onFocusHighlight = vi.fn();
    const props = buildProps({
      isMobile: true,
      focusedId: "highlight-1",
      onFocusHighlight,
      fragmentHighlights: [
        makeHighlight({ id: "highlight-1", exact: "First quote" }),
        makeHighlight({ id: "highlight-2", exact: "Second quote" }),
      ],
    });

    function MobileHarness() {
      const [focusedId, setFocusedId] = useState<string | null>("highlight-1");
      return (
        <MediaHighlightsPaneBody
          {...props}
          focusedId={focusedId}
          onFocusHighlight={(highlightId) => {
            onFocusHighlight(highlightId);
            setFocusedId(highlightId);
          }}
        />
      );
    }

    render(<MobileHarness />);

    expect(screen.getByText(/visible highlights/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "highlight-2" }));

    expect(onFocusHighlight).toHaveBeenCalledWith("highlight-2");
    expect(getLatestPaneProps().focusedId).toBe("highlight-2");
  });

  it("keeps PDF highlights scoped to the active page and mirrors the selection in the inline list", async () => {
    const user = userEvent.setup();
    const onFocusHighlight = vi.fn();

    render(
      <MediaHighlightsPaneBody
        {...buildProps({
          isPdf: true,
          fragmentHighlights: [],
          focusedId: "pdf-page-1b",
          onFocusHighlight,
          pdfPageHighlights: [
            makePdfHighlight({ id: "pdf-page-1", exact: "Page one first" }),
            makePdfHighlight({
              id: "pdf-page-1b",
              exact: "Page one second",
              anchor: {
                type: "pdf_page_geometry",
                media_id: "media-1",
                page_number: 1,
                quads: [
                  {
                    x1: 40,
                    y1: 20,
                    x2: 60,
                    y2: 20,
                    x3: 60,
                    y3: 40,
                    x4: 40,
                    y4: 40,
                  },
                ],
              },
            }),
          ],
        })}
      />
    );

    expect(screen.getByRole("heading", { name: "Page highlights" })).toBeInTheDocument();
    expect(screen.getByText("Active page: 1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "All highlights" })).not.toBeInTheDocument();
    expect(getRenderedHighlightIds()).toEqual(["pdf-page-1", "pdf-page-1b"]);
    expect(getLatestPaneProps().focusedId).toBe("pdf-page-1b");

    await user.click(screen.getByRole("button", { name: "pdf-page-1" }));

    expect(onFocusHighlight).toHaveBeenCalledWith("pdf-page-1");
  });
});
