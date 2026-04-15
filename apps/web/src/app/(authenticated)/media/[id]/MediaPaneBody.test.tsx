import { type ReactElement, type ReactNode } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MediaPaneBody from "./MediaPaneBody";

const mockUsePaneParam = vi.fn<(paramName: string) => string | null>();
const mockUseMediaViewState = vi.fn<(id: string) => Record<string, unknown>>();
const mockUsePaneChromeOverride = vi.fn<(overrides: Record<string, unknown>) => void>();
const mockReaderContentArea = vi.fn(
  ({ children }: { children: ReactNode }) => <>{children}</>
);

vi.mock("@/lib/panes/paneRuntime", () => ({
  usePaneParam: (paramName: string) => mockUsePaneParam(paramName),
  usePaneRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePaneSearchParams: () => new URLSearchParams(),
  useSetPaneTitle: () => {},
}));

vi.mock("@/components/workspace/PaneShell", () => ({
  usePaneChromeOverride: (overrides: Record<string, unknown>) =>
    mockUsePaneChromeOverride(overrides),
}));

vi.mock("./useMediaViewState", () => ({
  default: (id: string) => mockUseMediaViewState(id),
}));

vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/components/ReaderContentArea", () => ({
  default: (
    props: {
      children: ReactNode;
      contentClassName?: string;
    }
  ) => mockReaderContentArea(props),
}));

vi.mock("@/components/HtmlRenderer", () => ({
  default: () => <div data-testid="html-renderer" />,
}));

vi.mock("@/components/PdfReader", () => ({
  default: ({
    onHighlightTap,
  }: {
    onHighlightTap?: (highlightId: string, anchorRect: DOMRect) => void;
  }) => (
    <div data-testid="pdf-reader">
      <button
        type="button"
        onClick={() => onHighlightTap?.("pdf-highlight-1", new DOMRect(10, 20, 30, 12))}
      >
        Tap PDF highlight
      </button>
    </div>
  ),
}));

vi.mock("@/components/SelectionPopover", () => ({
  default: () => <div data-testid="selection-popover" />,
}));

vi.mock("@/components/HighlightEditPopover", () => ({
  default: () => <div data-testid="highlight-edit-popover" />,
}));

vi.mock("@/components/ui/StateMessage", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/StatusPill", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/workspace/DocumentViewport", () => ({
  default: ({ children }: { children: ReactNode }) => (
    <div data-testid="document-viewport">{children}</div>
  ),
}));

vi.mock("./MediaLinkedItemsPaneBody", () => ({
  default: () => <div data-testid="linked-items-pane-body">Linked items pane</div>,
}));

vi.mock("./TranscriptMediaPane", () => ({
  default: () => <div data-testid="transcript-media-pane" />,
}));

vi.mock("./EpubContentPane", () => ({
  default: () => <div data-testid="epub-content-pane" />,
}));

function buildViewState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mediaToolbar: null,
    mediaHeaderOptions: [],
    mediaHeaderMeta: null,
    loading: false,
    error: null,
    media: {
      id: "media-1",
      kind: "web",
      title: "Example media",
      processing_status: "ready_for_reading",
      canonical_source_url: null,
      podcast_title: null,
      podcast_image_url: null,
      chapters: [],
      description_html: null,
      description_text: null,
      listening_state: null,
      subscription_default_playback_speed: null,
      last_error_code: null,
    },
    isEpub: false,
    epubError: null,
    canRead: true,
    showHighlightsPane: true,
    isPdf: false,
    isMobileViewport: false,
    highlights: [],
    pdfPageHighlights: [],
    pdfDocumentHighlights: [],
    highlightsVersion: 0,
    pdfHighlightsVersion: 0,
    pdfActivePage: 1,
    pdfHighlightsHasMore: false,
    pdfHighlightsLoading: false,
    handleLoadMorePdfHighlights: vi.fn(),
    highlightMutationEpoch: 0,
    contentRef: { current: document.createElement("div") as HTMLDivElement | null },
    pdfContentRef: { current: null as HTMLDivElement | null },
    focusState: { focusedId: null, editingBounds: false },
    focusHighlight: vi.fn(),
    handleNavigatePdfHighlight: vi.fn(),
    handleNavigateToFragment: vi.fn(),
    handleLinkedItemsScopeChange: vi.fn(),
    handleSendToChat: vi.fn(),
    handleAnnotationSave: vi.fn(async () => {}),
    handleAnnotationDelete: vi.fn(async () => {}),
    buildRowOptions: vi.fn(() => []),
    isMismatchDisabled: false,
    focusModeEnabled: false,
    isTranscriptMedia: false,
    playbackSource: null,
    isPlaybackOnlyTranscript: false,
    transcriptState: null,
    transcriptCoverage: null,
    transcriptRequestInFlight: false,
    transcriptRequestForecast: null,
    handleRequestTranscript: vi.fn(),
    activeTranscriptFragment: null,
    renderedHtml: "<p>Hello</p>",
    handleTranscriptSegmentSelect: vi.fn(),
    handleContentClick: vi.fn(),
    fragments: [{ id: "fragment-1" }],
    readerResumeState: null,
    readerResumeStateLoading: false,
    saveReaderResumeState: vi.fn(),
    pdfRefreshToken: 0,
    handlePdfPageHighlightsChange: vi.fn(),
    pdfNavigationTarget: null,
    setPdfNavigationTarget: vi.fn(),
    schedulePdfHighlightsRefresh: vi.fn(),
    setPdfControlsState: vi.fn(),
    pdfControlsRef: { current: null },
    selection: null,
    isCreating: false,
    handleCreateHighlight: vi.fn(),
    handleDismissPopover: vi.fn(),
    editPopoverHighlight: null,
    editPopoverAnchorRect: null,
    startEditBounds: vi.fn(),
    cancelEditBounds: vi.fn(),
    handleColorChange: vi.fn(),
    dismissEditPopover: vi.fn(),
    epubSections: [],
    activeChapter: null,
    activeSectionId: null,
    chapterLoading: false,
    epubToc: null,
    tocWarning: false,
    epubTocExpanded: false,
    navigateToSection: vi.fn(),
    ...overrides,
  };
}

function getLatestChromeOverride(): Record<string, unknown> {
  const latest = mockUsePaneChromeOverride.mock.calls.at(-1)?.[0];
  if (!latest) {
    throw new Error("Expected usePaneChromeOverride to be called");
  }
  return latest;
}

type ToggleActionElement = ReactElement<{
  onClick: () => void;
  "aria-label"?: string;
}>;

describe("MediaPaneBody desktop linked-items collapse", () => {
  let currentViewState = buildViewState();

  beforeEach(() => {
    mockUsePaneParam.mockReset();
    mockUseMediaViewState.mockReset();
    mockUsePaneChromeOverride.mockReset();
    mockReaderContentArea.mockReset();
    mockReaderContentArea.mockImplementation(
      ({ children }: { children: ReactNode }) => <>{children}</>
    );
    mockUsePaneParam.mockImplementation((paramName) =>
      paramName === "id" ? "media-1" : null
    );
    currentViewState = buildViewState();
    mockUseMediaViewState.mockImplementation(() => currentViewState);
    document.body.style.overflow = "";
  });

  afterEach(() => {
    document.body.style.overflow = "";
  });

  it("toggles the desktop linked-items column from pane chrome actions", () => {
    render(<MediaPaneBody />);

    expect(screen.getByTestId("linked-items-pane-body")).toBeInTheDocument();

    let action = getLatestChromeOverride().actions as ToggleActionElement;
    expect(action.props["aria-label"]).toBe("Hide highlights pane");

    act(() => {
      action.props.onClick();
    });

    expect(screen.queryByTestId("linked-items-pane-body")).not.toBeInTheDocument();

    action = getLatestChromeOverride().actions as ToggleActionElement;
    expect(action.props["aria-label"]).toBe("Show highlights pane");

    act(() => {
      action.props.onClick();
    });

    expect(screen.getByTestId("linked-items-pane-body")).toBeInTheDocument();
  });

  it("suppresses collapse action when highlights pane is unavailable (focus mode)", () => {
    currentViewState = buildViewState({
      showHighlightsPane: false,
      focusModeEnabled: true,
    });
    mockUseMediaViewState.mockImplementation(() => currentViewState);

    render(<MediaPaneBody />);

    expect(screen.queryByTestId("linked-items-pane-body")).not.toBeInTheDocument();
    expect(getLatestChromeOverride().actions).toBeUndefined();
    expect(
      screen.getByText("Focus mode enabled: highlights pane hidden.")
    ).toBeInTheDocument();
  });

  it("closes the mobile linked-items drawer when highlights pane becomes unavailable", () => {
    currentViewState = buildViewState({ isMobileViewport: true, showHighlightsPane: true });
    mockUseMediaViewState.mockImplementation(() => currentViewState);

    const { rerender } = render(<MediaPaneBody />);
    const action = getLatestChromeOverride().actions as ToggleActionElement;
    act(() => { action.props.onClick(); });

    expect(screen.getByRole("dialog", { name: "Linked items" })).toBeInTheDocument();
    expect(document.body.style.overflow).toBe("hidden");

    currentViewState = buildViewState({
      isMobileViewport: true,
      showHighlightsPane: false,
      focusModeEnabled: true,
    });
    mockUseMediaViewState.mockImplementation(() => currentViewState);
    rerender(<MediaPaneBody />);

    expect(screen.queryByRole("dialog", { name: "Linked items" })).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
  });

  it("opens the mobile linked-items drawer when tapping a content highlight", async () => {
    const user = userEvent.setup();
    const handleContentClick = vi.fn(() => "hl-1");
    currentViewState = buildViewState({
      isMobileViewport: true,
      handleContentClick,
    });
    mockUseMediaViewState.mockImplementation(() => currentViewState);

    render(<MediaPaneBody />);
    expect(screen.queryByRole("dialog", { name: "Linked items" })).not.toBeInTheDocument();

    await user.click(screen.getByTestId("html-renderer"));

    expect(handleContentClick).toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Linked items" })).toBeInTheDocument();
  });

  it("opens the mobile linked-items drawer when tapping a PDF highlight", async () => {
    const user = userEvent.setup();
    const focusHighlight = vi.fn();
    const dismissEditPopover = vi.fn();
    currentViewState = buildViewState({
      isMobileViewport: true,
      isPdf: true,
      media: {
        id: "media-1",
        kind: "pdf",
        title: "Example PDF",
        processing_status: "ready_for_reading",
        canonical_source_url: null,
        podcast_title: null,
        podcast_image_url: null,
        chapters: [],
        description_html: null,
        description_text: null,
        listening_state: null,
        subscription_default_playback_speed: null,
        last_error_code: null,
      },
      focusHighlight,
      dismissEditPopover,
    });
    mockUseMediaViewState.mockImplementation(() => currentViewState);

    render(<MediaPaneBody />);
    expect(screen.queryByRole("dialog", { name: "Linked items" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Tap PDF highlight" }));

    expect(dismissEditPopover).toHaveBeenCalledTimes(1);
    expect(focusHighlight).toHaveBeenCalledWith("pdf-highlight-1");
    expect(screen.getByRole("dialog", { name: "Linked items" })).toBeInTheDocument();
  });

  it("keeps reflowable readers on the ReaderContentArea path and leaves transcript/pdf outside it", () => {
    currentViewState = buildViewState({
      fragments: [{ id: "fragment-1" }],
    });
    mockUseMediaViewState.mockImplementation(() => currentViewState);

    const { rerender } = render(<MediaPaneBody />);

    expect(mockReaderContentArea).toHaveBeenCalledTimes(1);
    expect(mockReaderContentArea.mock.calls.at(-1)?.[0]).toMatchObject({
      children: expect.anything(),
    });
    expect(screen.getByTestId("html-renderer")).toBeInTheDocument();

    mockReaderContentArea.mockClear();
    currentViewState = buildViewState({
      isEpub: true,
      media: {
        id: "media-1",
        kind: "epub",
        title: "Example EPUB",
        processing_status: "ready_for_reading",
        canonical_source_url: null,
        podcast_title: null,
        podcast_image_url: null,
        chapters: [],
        description_html: null,
        description_text: null,
        listening_state: null,
        subscription_default_playback_speed: null,
        last_error_code: null,
      },
    });
    mockUseMediaViewState.mockImplementation(() => currentViewState);
    rerender(<MediaPaneBody />);

    expect(mockReaderContentArea).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("epub-content-pane")).toBeInTheDocument();

    mockReaderContentArea.mockClear();
    currentViewState = buildViewState({
      isTranscriptMedia: true,
      media: {
        id: "media-1",
        kind: "podcast_episode",
        title: "Example transcript",
        processing_status: "ready_for_reading",
        canonical_source_url: null,
        podcast_title: "Example podcast",
        podcast_image_url: null,
        chapters: [],
        description_html: null,
        description_text: null,
        listening_state: null,
        subscription_default_playback_speed: null,
        last_error_code: null,
      },
    });
    mockUseMediaViewState.mockImplementation(() => currentViewState);
    rerender(<MediaPaneBody />);

    expect(mockReaderContentArea).not.toHaveBeenCalled();
    expect(screen.getByTestId("transcript-media-pane")).toBeInTheDocument();

    mockReaderContentArea.mockClear();
    currentViewState = buildViewState({
      isPdf: true,
      media: {
        id: "media-1",
        kind: "pdf",
        title: "Example PDF",
        processing_status: "ready_for_reading",
        canonical_source_url: null,
        podcast_title: null,
        podcast_image_url: null,
        chapters: [],
        description_html: null,
        description_text: null,
        listening_state: null,
        subscription_default_playback_speed: null,
        last_error_code: null,
      },
    });
    mockUseMediaViewState.mockImplementation(() => currentViewState);
    rerender(<MediaPaneBody />);

    expect(mockReaderContentArea).not.toHaveBeenCalled();
    expect(screen.getByTestId("pdf-reader")).toBeInTheDocument();
  });
});
