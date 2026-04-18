import type { ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Highlight } from "@/components/HighlightEditor";
import type { PdfHighlightOut } from "@/components/PdfReader";
import MediaHighlightsPaneBody from "./MediaHighlightsPaneBody";

const mockApiFetch = vi.fn();
const mockHighlightsPane = vi.fn((props: Record<string, unknown>) => {
  const highlights = (props.highlights as Array<{ id: string }>) ?? [];
  const onHighlightClick = props.onHighlightClick as (highlightId: string) => void;
  return (
    <div data-testid="highlights-pane" data-layout-mode={String(props.layoutMode ?? "")}>
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

vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
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
    mediaId: "media-1",
    isPdf: false,
    isEpub: false,
    isMobile: false,
    fragmentHighlights: [makeHighlight()],
    pdfPageHighlights: [] as PdfHighlightOut[],
    pdfDocumentHighlights: [] as PdfHighlightOut[],
    highlightsVersion: 1,
    pdfHighlightsVersion: 1,
    pdfActivePage: 1,
    pdfHighlightsHasMore: false,
    pdfHighlightsLoading: false,
    onLoadMorePdfHighlights: vi.fn(),
    highlightMutationToken: 0,
    contentRef: { current: document.createElement("div") as HTMLDivElement | null },
    focusedId: null,
    onFocusHighlight: vi.fn(),
    onNavigatePdfHighlight: vi.fn(),
    onNavigateToFragment: vi.fn(),
    onHighlightsViewChange: vi.fn(),
    onSendToChat: vi.fn(),
    onAnnotationSave: vi.fn(async () => {}),
    onAnnotationDelete: vi.fn(async () => {}),
    buildRowOptions: vi.fn(() => []),
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

describe("MediaHighlightsPaneBody", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockHighlightsPane.mockClear();
  });

  it("defaults web content to contextual highlights with no all-highlights control", () => {
    render(<MediaHighlightsPaneBody {...buildProps()} />);

    expect(screen.getByRole("heading", { name: "Highlights" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "All highlights" })).not.toBeInTheDocument();
    expect(getLatestPaneProps().layoutMode).toBe("aligned");
  });

  it("switches PDFs between page highlights and all highlights", async () => {
    const user = userEvent.setup();
    const onFocusHighlight = vi.fn();
    const onNavigatePdfHighlight = vi.fn();
    const onHighlightsViewChange = vi.fn();
    const onLoadMorePdfHighlights = vi.fn();

    render(
      <MediaHighlightsPaneBody
        {...buildProps({
          isPdf: true,
          fragmentHighlights: [],
          pdfPageHighlights: [
            makePdfHighlight({
              id: "pdf-page-1",
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
            }),
          ],
          pdfDocumentHighlights: [
            makePdfHighlight({
              id: "pdf-page-1",
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
            }),
            makePdfHighlight({
              id: "pdf-page-2",
              anchor: {
                type: "pdf_page_geometry",
                media_id: "media-1",
                page_number: 2,
                quads: [
                  {
                    x1: 10,
                    y1: 50,
                    x2: 30,
                    y2: 50,
                    x3: 30,
                    y3: 70,
                    x4: 10,
                    y4: 70,
                  },
                ],
              },
            }),
          ],
          pdfHighlightsHasMore: true,
          onFocusHighlight,
          onNavigatePdfHighlight,
          onHighlightsViewChange,
          onLoadMorePdfHighlights,
        })}
      />
    );

    expect(screen.getByRole("heading", { name: "Page highlights" })).toBeInTheDocument();
    expect(
      screen.getByText("At least 1 highlight on other pages. Open All highlights to view them immediately.")
    ).toBeInTheDocument();
    expect(getLatestPaneProps().layoutMode).toBe("aligned");
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "All highlights" }));

    expect(onHighlightsViewChange).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "All highlights" })).toBeInTheDocument();
    expect(
      screen.getByText("Showing highlights from the entire document.")
    ).toBeInTheDocument();
    expect(getLatestPaneProps().layoutMode).toBe("list");
    expect(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "pdf-page-2" }));

    expect(onNavigatePdfHighlight).toHaveBeenCalledWith({
      highlightId: "pdf-page-2",
      pageNumber: 2,
      quads: [
        {
          x1: 10,
          y1: 50,
          x2: 30,
          y2: 50,
          x3: 30,
          y3: 70,
          x4: 10,
          y4: 70,
        },
      ],
    });
    expect(onFocusHighlight).toHaveBeenCalledWith("pdf-page-2");

    await user.click(screen.getByRole("button", { name: "Load more" }));

    expect(onLoadMorePdfHighlights).toHaveBeenCalledTimes(1);
  });

  it("fetches all book highlights for EPUB and navigates back into the active fragment", async () => {
    const user = userEvent.setup();
    const onFocusHighlight = vi.fn();
    const onNavigateToFragment = vi.fn();
    const onHighlightsViewChange = vi.fn();

    mockApiFetch.mockResolvedValue({
      data: {
        highlights: [
          {
            ...makeHighlight({
              id: "book-highlight-1",
              fragment_id: "fragment-9",
            }),
            fragment_idx: 9,
          },
        ],
        page: {
          has_more: true,
          next_cursor: "cursor-2",
        },
      },
    });

    render(
      <MediaHighlightsPaneBody
        {...buildProps({
          isEpub: true,
          fragmentHighlights: [makeHighlight({ id: "chapter-highlight-1" })],
          onFocusHighlight,
          onNavigateToFragment,
          onHighlightsViewChange,
        })}
      />
    );

    expect(screen.getByRole("heading", { name: "Chapter highlights" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "All highlights" }));

    expect(onHighlightsViewChange).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/api/media/media-1/highlights?limit=50&mine_only=false"
      );
    });

    expect(screen.getByRole("heading", { name: "All highlights" })).toBeInTheDocument();
    expect(screen.getByText("Showing highlights from the entire book.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "book-highlight-1" }));

    expect(onNavigateToFragment).toHaveBeenCalledWith(
      "book-highlight-1",
      "fragment-9",
      9
    );
    expect(onFocusHighlight).toHaveBeenCalledWith("book-highlight-1");
  });
});
