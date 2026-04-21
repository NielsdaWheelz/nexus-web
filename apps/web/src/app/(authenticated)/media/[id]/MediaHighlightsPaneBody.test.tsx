import type { ReactNode } from "react";
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

const mockHighlightDetailPane = vi.fn((props: Record<string, unknown>) => {
  const highlight = props.highlight as { id: string; exact: string } | null | undefined;
  return (
    <div data-testid="highlight-detail-pane">
      <div data-testid="detail-highlight-id">{highlight?.id ?? ""}</div>
      <div data-testid="detail-exact">{highlight?.exact ?? ""}</div>
      {typeof props.onShowInDocument === "function" ? (
        <button
          type="button"
          onClick={() => (props.onShowInDocument as () => void)()}
        >
          Show in document
        </button>
      ) : null}
    </div>
  );
});

vi.mock("@/components/LinkedItemsPane", () => ({
  default: (props: Record<string, unknown>) => mockHighlightsPane(props),
}));

vi.mock("./HighlightDetailPane", () => ({
  default: (props: Record<string, unknown>) => mockHighlightDetailPane(props),
}));

vi.mock("@/components/ui/StatusPill", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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
    onDelete: vi.fn(async () => {}),
    onStartEditBounds: vi.fn(),
    onCancelEditBounds: vi.fn(),
    isEditingBounds: false,
    onAnnotationSave: vi.fn(async () => {}),
    onAnnotationDelete: vi.fn(async () => {}),
    buildRowOptions: vi.fn(() => []),
    onOpenConversation: vi.fn(),
    onCloseMobileDrawer: vi.fn(),
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

function getLatestDetailProps(): Record<string, unknown> {
  const latest = mockHighlightDetailPane.mock.calls.at(-1)?.[0] as
    | Record<string, unknown>
    | undefined;
  if (!latest) {
    throw new Error("Expected highlight detail pane to render");
  }
  return latest;
}

describe("MediaHighlightsPaneBody", () => {
  beforeEach(() => {
    mockHighlightsPane.mockClear();
    mockHighlightDetailPane.mockClear();
  });

  it("shows the selected desktop highlight in the detail inspector with no all-highlights toggle", () => {
    const exact =
      "This is a deliberately long highlight quote that should stay fully readable in the inspector.";

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
    expect(getLatestDetailProps().highlight).toMatchObject({
      id: "highlight-2",
      exact,
    });
    expect(screen.getByTestId("detail-exact")).toHaveTextContent(exact);
  });

  it("re-resolves EPUB selection to the first contextual highlight when focus is out of scope", async () => {
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

    expect(screen.getByRole("heading", { name: "Chapter highlights" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "All highlights" })).not.toBeInTheDocument();

    await waitFor(() => {
      expect(onFocusHighlight).toHaveBeenCalledWith("early-highlight");
    });

    expect(getLatestDetailProps().highlight).toMatchObject({
      id: "early-highlight",
    });
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

    expect(screen.queryByTestId("highlight-detail-pane")).not.toBeInTheDocument();
  });

  it("opens a mobile detail sheet for the tapped contextual highlight", async () => {
    const user = userEvent.setup();
    const onFocusHighlight = vi.fn();

    render(
      <MediaHighlightsPaneBody
        {...buildProps({
          isMobile: true,
          focusedId: "highlight-1",
          onFocusHighlight,
          fragmentHighlights: [
            makeHighlight({ id: "highlight-1", exact: "First quote" }),
            makeHighlight({ id: "highlight-2", exact: "Second quote" }),
          ],
        })}
      />
    );

    expect(screen.queryByRole("dialog", { name: "Highlight details" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "highlight-2" }));

    expect(onFocusHighlight).toHaveBeenCalledWith("highlight-2");
    expect(screen.getByRole("dialog", { name: "Highlight details" })).toBeInTheDocument();
    expect(screen.getByTestId("detail-highlight-id")).toHaveTextContent("highlight-2");
    expect(screen.getByTestId("detail-exact")).toHaveTextContent("Second quote");
  });

  it("keeps PDF highlights scoped to the active page and mirrors the selection in the inspector", async () => {
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
    expect(getLatestDetailProps().highlight).toMatchObject({
      id: "pdf-page-1b",
      exact: "Page one second",
    });

    await user.click(screen.getByRole("button", { name: "pdf-page-1" }));

    expect(onFocusHighlight).toHaveBeenCalledWith("pdf-page-1");
  });
});
