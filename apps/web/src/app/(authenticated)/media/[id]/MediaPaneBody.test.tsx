import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MediaPaneBody from "./MediaPaneBody";

const mockUsePaneParam = vi.fn<(paramName: string) => string | null>();
const mockUseMediaViewState = vi.fn<(id: string) => Record<string, unknown>>();
const mockUsePaneChromeOverride = vi.fn<(overrides: Record<string, unknown>) => void>();
const mockNavigatePane = vi.fn();
const mockRequestOpenInAppPane = vi.fn();
const mockSetTrack = vi.fn();
function renderSelectionPopover(_props: Record<string, unknown>) {
  return <div data-testid="selection-popover" />;
}
const mockSelectionPopover = vi.fn<(props: Record<string, unknown>) => ReactElement>(
  renderSelectionPopover
);
const mockPdfReader = vi.fn(
  ({
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
  )
);
function renderTranscriptMediaPane(_props: Record<string, unknown>) {
  return <div data-testid="transcript-media-pane" />;
}
const mockTranscriptMediaPane = vi.fn<(props: Record<string, unknown>) => ReactElement>(
  renderTranscriptMediaPane
);
function renderChatComposer(props: {
  conversationId?: string | null;
  attachedContexts?: { preview?: string }[];
  onConversationCreated?: (conversationId: string) => void;
  onMessageSent?: () => void;
}) {
  return (
    <div data-testid="chat-composer">
      <button
        type="button"
        onClick={() => {
          props.onConversationCreated?.("conversation-1");
          props.onMessageSent?.();
        }}
      >
        Send mock message
      </button>
      <div data-testid="chat-composer-attached-count">
        {props.attachedContexts?.length ?? 0}
      </div>
      {props.attachedContexts?.map((item, index) => (
        <div key={`attached-context-${index}`}>{item.preview ?? ""}</div>
      ))}
    </div>
  );
}
const mockChatComposer = vi.fn<
  (props: {
    conversationId?: string | null;
    attachedContexts?: { preview?: string }[];
    onConversationCreated?: (conversationId: string) => void;
    onMessageSent?: () => void;
  }) => ReactElement
>(renderChatComposer);
const mockReaderContentArea = vi.fn(
  ({ children }: { children: ReactNode }) => children
);
const mockMediaHighlightsPaneBody = vi.fn((_props: Record<string, unknown>) => (
  <div data-testid="highlights-pane-body">Highlights pane</div>
));

vi.mock("@/lib/panes/paneRuntime", () => ({
  usePaneParam: (paramName: string) => mockUsePaneParam(paramName),
  usePaneRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePaneSearchParams: () => new URLSearchParams(),
  useSetPaneTitle: () => {},
}));

vi.mock("@/lib/panes/openInAppPane", () => ({
  requestOpenInAppPane: (...args: unknown[]) => mockRequestOpenInAppPane(...args),
}));

vi.mock("@/components/workspace/PaneShell", () => ({
  usePaneChromeOverride: (overrides: Record<string, unknown>) =>
    mockUsePaneChromeOverride(overrides),
}));

vi.mock("@/lib/workspace/store", () => ({
  useWorkspaceStore: () => ({
    navigatePane: mockNavigatePane,
  }),
}));

vi.mock("./useMediaViewState", () => ({
  default: (id: string) => mockUseMediaViewState(id),
}));

vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/lib/reader", () => ({
  useReaderContext: () => ({
    profile: { theme: "light" },
    updateTheme: vi.fn(),
  }),
}));

vi.mock("@/components/ReaderContentArea", () => ({
  default: (
    props: {
      children: ReactNode;
      contentClassName?: string;
    }
  ) => mockReaderContentArea(props),
}));

vi.mock("@/lib/player/globalPlayer", () => ({
  useGlobalPlayer: () => ({
    track: null,
    setTrack: mockSetTrack,
    clearTrack: vi.fn(),
    seekToMs: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    isPlaying: false,
    currentTimeSeconds: 0,
    durationSeconds: 0,
    bufferedSeconds: 0,
    playbackRate: 1,
    volume: 1,
    queueItems: [],
    refreshQueue: vi.fn(async () => {}),
    addToQueue: vi.fn(async () => []),
    removeFromQueue: vi.fn(async () => {}),
    reorderQueue: vi.fn(async () => {}),
    clearQueue: vi.fn(async () => {}),
    playNextInQueue: vi.fn(async () => {}),
    playPreviousInQueue: vi.fn(async () => {}),
    hasNextInQueue: false,
    hasPreviousInQueue: false,
    bindAudioElement: vi.fn(),
  }),
}));

vi.mock("@/components/HtmlRenderer", () => ({
  default: () => <div data-testid="html-renderer" />,
}));

vi.mock("@/components/PdfReader", () => ({
  default: (props: {
    onHighlightTap?: (highlightId: string, anchorRect: DOMRect) => void;
    startPageNumber?: number;
    startZoom?: number;
    onResumeStateChange?: (pageNumber: number, zoom: number) => void;
  }) => mockPdfReader(props),
}));

vi.mock("@/components/SelectionPopover", () => ({
  default: (props: Record<string, unknown>) => mockSelectionPopover(props),
}));

vi.mock("@/components/ChatComposer", () => ({
  default: (props: {
    attachedContexts?: { preview?: string }[];
    onConversationCreated?: (conversationId: string) => void;
    onMessageSent?: () => void;
  }) => mockChatComposer(props),
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

vi.mock("@/components/LibraryMembershipPanel", () => ({
  default: () => <div data-testid="library-membership-panel" />,
}));

vi.mock("@/components/workspace/DocumentViewport", () => ({
  default: ({ children }: { children: ReactNode }) => (
    <div data-testid="document-viewport">{children}</div>
  ),
}));

vi.mock("./MediaHighlightsPaneBody", () => ({
  default: (props: Record<string, unknown>) => mockMediaHighlightsPaneBody(props),
}));

vi.mock("./TranscriptMediaPane", () => ({
  default: (props: Record<string, unknown>) => mockTranscriptMediaPane(props),
}));

vi.mock("./EpubContentPane", () => ({
  default: () => <div data-testid="epub-content-pane" />,
}));

function buildViewState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
      authors: [],
      published_date: null,
      publisher: null,
      language: null,
      chapters: [],
      description: null,
      description_html: null,
      description_text: null,
      listening_state: null,
      subscription_default_playback_speed: null,
      episode_state: null,
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
    highlightsVersion: 0,
    pdfHighlightsVersion: 0,
    pdfActivePage: 1,
    contentRef: { current: document.createElement("div") as HTMLDivElement | null },
    pdfContentRef: { current: null as HTMLDivElement | null },
    focusState: { focusedId: null, editingBounds: false },
    focusHighlight: vi.fn(),
    clearFocus: vi.fn(),
    handleSendToChat: vi.fn(),
    handleDelete: vi.fn(async () => {}),
    handleQuoteSelectionToNewChat: vi.fn(),
    prepareQuoteSelectionForChat: vi.fn(async () => null),
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
    libraryPickerLibraries: [],
    libraryPickerLoading: false,
    libraryPickerError: null,
    libraryMembershipBusy: false,
    loadLibraryPickerLibraries: vi.fn(async () => {}),
    handleAddToLibrary: vi.fn(async () => {}),
    handleRemoveFromLibrary: vi.fn(async () => {}),
    pdfRefreshToken: 0,
    handlePdfPageHighlightsChange: vi.fn(),
    setPdfControlsState: vi.fn(),
    pdfControlsRef: { current: null },
    pdfControlsState: null,
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
    setEpubTocExpanded: vi.fn(),
    navigateToSection: vi.fn(),
    activeSectionPosition: -1,
    prevSection: null,
    nextSection: null,
    hasEpubToc: false,
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

function renderLatestToolbar() {
  const toolbar = getLatestChromeOverride().toolbar as ReactNode;
  if (!toolbar) {
    throw new Error("Expected toolbar override to be present");
  }
  return render(<>{toolbar}</>);
}

function renderLatestMeta() {
  const meta = getLatestChromeOverride().meta as ReactNode;
  if (!meta) {
    throw new Error("Expected meta override to be present");
  }
  return render(<>{meta}</>);
}

function getLatestTranscriptMediaPaneProps(): Record<string, unknown> {
  const latest = mockTranscriptMediaPane.mock.calls.at(-1)?.[0] as
    | Record<string, unknown>
    | undefined;
  if (!latest) {
    throw new Error("Expected TranscriptMediaPane to be rendered");
  }
  return latest;
}

function getLatestSelectionPopoverProps(): Record<string, unknown> {
  const latest = mockSelectionPopover.mock.calls.at(-1)?.[0] as
    | Record<string, unknown>
    | undefined;
  if (!latest) {
    throw new Error("Expected SelectionPopover to be rendered");
  }
  return latest;
}

function getLatestPdfReaderProps(): Record<string, unknown> {
  const latest = mockPdfReader.mock.calls.at(-1)?.[0] as
    | Record<string, unknown>
    | undefined;
  if (!latest) {
    throw new Error("Expected PdfReader to be rendered");
  }
  return latest;
}

function getLatestChatComposerProps(): Record<string, unknown> {
  const latest = mockChatComposer.mock.calls.at(-1)?.[0] as
    | Record<string, unknown>
    | undefined;
  if (!latest) {
    throw new Error("Expected ChatComposer to be rendered");
  }
  return latest;
}

function getLatestHighlightsPaneBodyProps(): Record<string, unknown> {
  const latest = mockMediaHighlightsPaneBody.mock.calls.at(-1)?.[0] as
    | Record<string, unknown>
    | undefined;
  if (!latest) {
    throw new Error("Expected MediaHighlightsPaneBody to be rendered");
  }
  return latest;
}

type ToggleActionElement = ReactElement<{
  onClick: () => void;
  "aria-label"?: string;
  "aria-expanded"?: boolean;
}>;

function getLatestHighlightsAction(): ToggleActionElement | null {
  const actions = getLatestChromeOverride().actions;
  if (!actions || !isValidElement(actions)) {
    return null;
  }

  const actionGroup = actions as ReactElement<{ children?: ReactNode }>;

  for (const child of Children.toArray(actionGroup.props.children)) {
    if (!isValidElement(child)) {
      continue;
    }
    const action = child as ToggleActionElement;
    if (
      action.props["aria-label"] === "Highlights" &&
      typeof action.props.onClick === "function"
    ) {
      return action;
    }
  }

  return null;
}

describe("MediaPaneBody highlights shell", () => {
  let currentViewState = buildViewState();

  beforeEach(() => {
    mockUsePaneParam.mockReset();
    mockUseMediaViewState.mockReset();
    mockUsePaneChromeOverride.mockReset();
    mockNavigatePane.mockReset();
    mockRequestOpenInAppPane.mockReset();
    mockRequestOpenInAppPane.mockReturnValue(true);
    mockSetTrack.mockReset();
    mockSelectionPopover.mockReset();
    mockSelectionPopover.mockImplementation(renderSelectionPopover);
    mockPdfReader.mockClear();
    mockChatComposer.mockReset();
    mockChatComposer.mockImplementation(renderChatComposer);
    mockTranscriptMediaPane.mockReset();
    mockTranscriptMediaPane.mockImplementation(renderTranscriptMediaPane);
    mockReaderContentArea.mockReset();
    mockReaderContentArea.mockImplementation(
      ({ children }: { children: ReactNode }) => children
    );
    mockMediaHighlightsPaneBody.mockReset();
    mockMediaHighlightsPaneBody.mockImplementation((_props: Record<string, unknown>) => (
      <div data-testid="highlights-pane-body">Highlights pane</div>
    ));
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

  it("renders the desktop highlights pane at the fixed cutover width and forwards detail callbacks", () => {
    const clearFocus = vi.fn();
    const handleDelete = vi.fn(async () => {});
    const startEditBounds = vi.fn();
    const cancelEditBounds = vi.fn();
    currentViewState = buildViewState({
      highlights: [{ id: "fragment-highlight-1" }],
      clearFocus,
      handleDelete,
      startEditBounds,
      cancelEditBounds,
      focusState: { focusedId: "fragment-highlight-1", editingBounds: true },
    });
    mockUseMediaViewState.mockImplementation(() => currentViewState);

    render(<MediaPaneBody />);

    const pane = screen.getByTestId("highlights-pane-body");
    expect(pane).toBeInTheDocument();
    expect(pane.parentElement).toHaveStyle({
      width: "400px",
      flex: "0 0 400px",
    });
    expect(getLatestHighlightsPaneBodyProps()).toMatchObject({
      isMobile: false,
      fragmentHighlights: [{ id: "fragment-highlight-1" }],
      onClearFocus: clearFocus,
      onDelete: handleDelete,
      onStartEditBounds: startEditBounds,
      onCancelEditBounds: cancelEditBounds,
      isEditingBounds: true,
      onCloseMobileDrawer: undefined,
    });
    expect(getLatestHighlightsAction()).toBeNull();
  });

  it("forwards active-page PDF highlights into the contextual pane body", () => {
    currentViewState = buildViewState({
      isPdf: true,
      media: {
        id: "media-1",
        kind: "pdf",
        title: "Example media",
        processing_status: "ready_for_reading",
        canonical_source_url: null,
        podcast_title: null,
        podcast_image_url: null,
        authors: [],
        published_date: null,
        publisher: null,
        language: null,
        chapters: [],
        description: null,
        description_html: null,
        description_text: null,
        listening_state: null,
        subscription_default_playback_speed: null,
        episode_state: null,
        last_error_code: null,
      },
      pdfPageHighlights: [{ id: "pdf-page-highlight-1" }],
      pdfActivePage: 4,
    });
    mockUseMediaViewState.mockImplementation(() => currentViewState);

    render(<MediaPaneBody />);

    expect(getLatestHighlightsPaneBodyProps()).toMatchObject({
      isPdf: true,
      isMobile: false,
      pdfPageHighlights: [{ id: "pdf-page-highlight-1" }],
      pdfActivePage: 4,
    });
  });

  it("suppresses the highlights pane and action when highlights are unavailable", () => {
    currentViewState = buildViewState({
      showHighlightsPane: false,
      focusModeEnabled: true,
    });
    mockUseMediaViewState.mockImplementation(() => currentViewState);

    render(<MediaPaneBody />);

    expect(screen.queryByTestId("highlights-pane-body")).not.toBeInTheDocument();
    expect(getLatestHighlightsAction()).toBeNull();
    expect(
      screen.getByText("Focus mode enabled: highlights pane hidden.")
    ).toBeInTheDocument();
  });

  it("publishes author-aware metadata into pane chrome", () => {
    currentViewState = buildViewState({
      media: {
        id: "media-1",
        kind: "web_article",
        title: "Example media",
        processing_status: "ready_for_reading",
        canonical_source_url: "https://example.com/articles/1",
        podcast_title: null,
        podcast_image_url: null,
        authors: [
          { id: "author-1", name: "Ada Lovelace", role: "author" },
          { id: "author-2", name: "Grace Hopper", role: "editor" },
          { id: "author-3", name: "Katherine Johnson", role: null },
        ],
        published_date: "2026-03-06",
        publisher: "Example Publisher",
        language: "en",
        chapters: [],
        description: null,
        description_html: null,
        description_text: null,
        listening_state: null,
        subscription_default_playback_speed: null,
        episode_state: null,
        last_error_code: null,
      },
    });
    mockUseMediaViewState.mockImplementation(() => currentViewState);

    render(<MediaPaneBody />);
    renderLatestMeta();

    expect(screen.getByText("web_article")).toBeInTheDocument();
    expect(screen.getByText("Ada Lovelace, Grace Hopper +1")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View Source ↗" })).toHaveAttribute(
      "href",
      "https://example.com/articles/1"
    );
  });

  it("exposes a mobile Highlights action and closes the drawer when highlights become unavailable", () => {
    currentViewState = buildViewState({ isMobileViewport: true, showHighlightsPane: true });
    mockUseMediaViewState.mockImplementation(() => currentViewState);

    const { rerender } = render(<MediaPaneBody />);
    const action = getLatestHighlightsAction();
    expect(action).not.toBeNull();
    expect(action?.props["aria-expanded"]).toBe(false);

    act(() => {
      action?.props.onClick();
    });

    expect(screen.getByRole("dialog", { name: "Highlights" })).toBeInTheDocument();
    expect(document.body.style.overflow).toBe("hidden");

    currentViewState = buildViewState({
      isMobileViewport: true,
      showHighlightsPane: false,
      focusModeEnabled: true,
    });
    mockUseMediaViewState.mockImplementation(() => currentViewState);
    rerender(<MediaPaneBody />);

    expect(screen.queryByRole("dialog", { name: "Highlights" })).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
    expect(getLatestHighlightsAction()).toBeNull();
  });

  it("passes a mobile drawer close handler into the highlights pane body", () => {
    currentViewState = buildViewState({ isMobileViewport: true, showHighlightsPane: true });
    mockUseMediaViewState.mockImplementation(() => currentViewState);

    render(<MediaPaneBody />);

    const action = getLatestHighlightsAction();
    expect(action).not.toBeNull();

    act(() => {
      action?.props.onClick();
    });

    expect(screen.getByRole("dialog", { name: "Highlights" })).toBeInTheDocument();

    const onCloseMobileDrawer = getLatestHighlightsPaneBodyProps().onCloseMobileDrawer as
      | (() => void)
      | undefined;
    expect(onCloseMobileDrawer).toBeTypeOf("function");

    act(() => {
      onCloseMobileDrawer?.();
    });

    expect(screen.queryByRole("dialog", { name: "Highlights" })).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
  });

  it("opens the mobile Highlights drawer when tapping a content highlight", async () => {
    const user = userEvent.setup();
    const handleContentClick = vi.fn(() => "hl-1");
    currentViewState = buildViewState({
      isMobileViewport: true,
      handleContentClick,
    });
    mockUseMediaViewState.mockImplementation(() => currentViewState);

    render(<MediaPaneBody />);
    expect(screen.queryByRole("dialog", { name: "Highlights" })).not.toBeInTheDocument();

    await user.click(screen.getByTestId("html-renderer"));

    expect(handleContentClick).toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Highlights" })).toBeInTheDocument();
  });

  it("passes selection line rects into the reflowable selection popup", () => {
    const lineRects = [new DOMRect(96, 180, 120, 18), new DOMRect(102, 206, 102, 18)];
    const selectionRect = new DOMRect(96, 180, 120, 44);
    currentViewState = buildViewState({
      selection: {
        range: document.createRange(),
        rect: selectionRect,
        lineRects,
      },
    });
    mockUseMediaViewState.mockImplementation(() => currentViewState);

    render(<MediaPaneBody />);

    expect(screen.getByTestId("selection-popover")).toBeInTheDocument();
    expect(getLatestSelectionPopoverProps()).toMatchObject({
      selectionRect,
      selectionLineRects: lineRects,
    });
  });

  it("opens a local mobile quote drawer instead of navigating immediately from the selection popover", async () => {
    const prepareQuoteSelectionForChat = vi.fn(async () => ({
      context: {
        type: "highlight",
        id: "11111111-1111-4111-8111-111111111111",
        color: "yellow",
        preview: "Quoted line",
        mediaId: "media-1",
        mediaTitle: "Example media",
      },
      targetPaneId: null,
      targetConversationId: null,
    }));
    const handleQuoteSelectionToNewChat = vi.fn();
    const handleSendToChat = vi.fn();
    currentViewState = buildViewState({
      isMobileViewport: true,
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
        capabilities: { can_quote: true },
      },
      selection: {
        range: document.createRange(),
        rect: new DOMRect(96, 180, 120, 44),
        lineRects: [new DOMRect(96, 180, 120, 18)],
      },
      prepareQuoteSelectionForChat,
      handleQuoteSelectionToNewChat,
      handleSendToChat,
    });
    mockUseMediaViewState.mockImplementation(() => currentViewState);

    render(<MediaPaneBody />);

    const onQuoteToChat = getLatestSelectionPopoverProps().onQuoteToChat as
      | ((color: string) => Promise<void>)
      | undefined;

    expect(onQuoteToChat).toBeTypeOf("function");

    await act(async () => {
      await onQuoteToChat?.("yellow");
    });

    expect(prepareQuoteSelectionForChat).toHaveBeenCalledWith("yellow");
    expect(handleQuoteSelectionToNewChat).not.toHaveBeenCalled();
    expect(handleSendToChat).not.toHaveBeenCalled();

    const drawer = screen.getByRole("dialog", { name: "Ask in chat" });
    expect(within(drawer).getByTestId("chat-composer")).toBeInTheDocument();
    expect(within(drawer).getByTestId("chat-composer-attached-count")).toHaveTextContent("1");
    expect(within(drawer).getByText("Quoted line")).toBeInTheDocument();
    expect(getLatestChatComposerProps()).toMatchObject({ conversationId: null });
  });

  it("opens the created conversation pane and closes the mobile quote drawer after send", async () => {
    const user = userEvent.setup();
    const prepareQuoteSelectionForChat = vi.fn(async () => ({
      context: {
        type: "highlight",
        id: "11111111-1111-4111-8111-111111111111",
        color: "yellow",
        preview: "Quoted line",
        mediaId: "media-1",
        mediaTitle: "Example media",
      },
      targetPaneId: null,
      targetConversationId: null,
    }));
    currentViewState = buildViewState({
      isMobileViewport: true,
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
        capabilities: { can_quote: true },
      },
      selection: {
        range: document.createRange(),
        rect: new DOMRect(96, 180, 120, 44),
        lineRects: [new DOMRect(96, 180, 120, 18)],
      },
      prepareQuoteSelectionForChat,
    });
    mockUseMediaViewState.mockImplementation(() => currentViewState);

    render(<MediaPaneBody />);

    const onQuoteToChat = getLatestSelectionPopoverProps().onQuoteToChat as
      | ((color: string) => Promise<void>)
      | undefined;

    await act(async () => {
      await onQuoteToChat?.("yellow");
    });

    await user.click(screen.getByRole("button", { name: "Send mock message" }));

    expect(mockRequestOpenInAppPane).toHaveBeenCalledWith("/conversations/conversation-1", {
      titleHint: "Chat",
    });
    expect(screen.queryByRole("dialog", { name: "Ask in chat" })).not.toBeInTheDocument();
  });

  it("opens the mobile Highlights drawer when tapping a PDF highlight", async () => {
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
    expect(screen.queryByRole("dialog", { name: "Highlights" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Tap PDF highlight" }));

    expect(dismissEditPopover).toHaveBeenCalledTimes(1);
    expect(focusHighlight).toHaveBeenCalledWith("pdf-highlight-1");
    expect(screen.getByRole("dialog", { name: "Highlights" })).toBeInTheDocument();
  });

  it("passes the nested PDF locator through to PdfReader and saves page updates as a locator object", () => {
    const saveReaderResumeState = vi.fn();
    currentViewState = buildViewState({
      isPdf: true,
      readerResumeState: {
        locator: {
          kind: "pdf_page",
          page: 7,
          zoom: 1.5,
        },
      },
      saveReaderResumeState,
    });
    mockUseMediaViewState.mockImplementation(() => currentViewState);

    render(<MediaPaneBody />);

    expect(getLatestPdfReaderProps()).toMatchObject({
      startPageNumber: 7,
      startZoom: 1.5,
    });

    const onResumeStateChange = getLatestPdfReaderProps().onResumeStateChange as
      | ((pageNumber: number, zoom: number) => void)
      | undefined;
    expect(onResumeStateChange).toBeTypeOf("function");

    onResumeStateChange?.(9, 2);

    expect(saveReaderResumeState).toHaveBeenCalledWith({
      locator: {
        kind: "pdf_page",
        page: 9,
        zoom: 2,
      },
    });
  });

  it("publishes compact PDF controls into pane chrome", () => {
    const goToPreviousPage = vi.fn();
    const goToNextPage = vi.fn();
    const createHighlight = vi.fn();
    const zoomOut = vi.fn();
    const zoomIn = vi.fn();
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
      pdfControlsState: {
        pageNumber: 3,
        numPages: 12,
        zoomPercent: 125,
        canGoPrev: true,
        canGoNext: true,
        canZoomIn: true,
        canZoomOut: true,
        canCreateHighlight: true,
        highlightLabel: "Highlight selection",
        isCreating: false,
        createTelemetry: {
          attempts: 0,
          postRequests: 0,
          patchRequests: 0,
          successes: 0,
          errors: 0,
          lastOutcome: "idle",
        },
        pageRenderEpoch: 1,
        isBusy: false,
      },
      pdfControlsRef: {
        current: {
          goToPreviousPage,
          goToNextPage,
          createHighlight,
          captureSelectionSnapshot: vi.fn(),
          zoomOut,
          zoomIn,
        },
      },
    });
    mockUseMediaViewState.mockImplementation(() => currentViewState);

    render(<MediaPaneBody />);
    renderLatestToolbar();

    expect(screen.getByRole("toolbar", { name: "PDF controls" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous page" })).toHaveTextContent("Prev");
    expect(screen.getByRole("button", { name: "Next page" })).toHaveTextContent("Next");
    expect(screen.getByRole("button", { name: "Highlight selection" })).toHaveTextContent(
      "Highlight"
    );
    expect(screen.getByText("3 / 12")).toHaveAttribute("aria-label", "Page 3 of 12");
    expect(screen.getByRole("button", { name: "More actions" })).toBeInTheDocument();
  });

  it("publishes Libraries… into the pane header options", () => {
    currentViewState = buildViewState({
      media: {
        id: "media-1",
        kind: "web",
        title: "Example media",
        processing_status: "ready_for_reading",
        canonical_source_url: "https://example.com/source",
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

    render(<MediaPaneBody />);

    expect(getLatestChromeOverride().options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "libraries", label: "Libraries…" }),
      ])
    );
  });

  it("publishes EPUB controls and reader options into pane chrome", () => {
    currentViewState = buildViewState({
      isEpub: true,
      media: {
        id: "media-1",
        kind: "epub",
        title: "Example EPUB",
        processing_status: "ready_for_reading",
        canonical_source_url: "https://example.com/book.epub",
        podcast_title: null,
        podcast_image_url: null,
        chapters: [],
        description_html: null,
        description_text: null,
        listening_state: null,
        subscription_default_playback_speed: null,
        last_error_code: null,
      },
      epubSections: [
        { section_id: "section-1", label: "Chapter 1" },
        { section_id: "section-2", label: "Chapter 2" },
      ],
      activeSectionId: "section-1",
      activeSectionPosition: 0,
      prevSection: null,
      nextSection: { section_id: "section-2", label: "Chapter 2" },
      hasEpubToc: true,
      tocWarning: false,
    });
    mockUseMediaViewState.mockImplementation(() => currentViewState);

    render(<MediaPaneBody />);
    renderLatestToolbar();

    expect(screen.getByRole("toolbar", { name: "EPUB controls" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous chapter" })).toHaveTextContent("Prev");
    expect(screen.getByRole("button", { name: "Next chapter" })).toHaveTextContent("Next");
    expect(screen.getByText("1 / 2")).toHaveAttribute("aria-label", "Section 1 of 2");
    expect(screen.getByRole("combobox", { name: "Select chapter" })).toBeInTheDocument();

    expect(getLatestChromeOverride().options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "open-source", label: "Open source" }),
        expect.objectContaining({ id: "toggle-toc" }),
        expect.objectContaining({ id: "theme-light" }),
        expect.objectContaining({ id: "theme-dark" }),
        expect.objectContaining({ id: "libraries", label: "Libraries…" }),
      ])
    );
  });

  it("hydrates saved podcast listening state into the global player for transcript audio", async () => {
    currentViewState = buildViewState({
      isTranscriptMedia: true,
      playbackSource: {
        kind: "external_audio",
        stream_url: "https://cdn.example.com/podcast.mp3",
        source_url: "https://example.com/episodes/1",
      },
      media: {
        id: "media-1",
        kind: "podcast_episode",
        title: "Example transcript",
        processing_status: "ready_for_reading",
        canonical_source_url: "https://example.com/episodes/1",
        podcast_title: "Example podcast",
        podcast_image_url: "https://cdn.example.com/cover.jpg",
        chapters: [
          {
            chapter_idx: 0,
            title: "Intro",
            t_start_ms: 0,
            t_end_ms: 120000,
            url: null,
            image_url: null,
          },
        ],
        description_html: null,
        description_text: null,
        listening_state: {
          position_ms: 12000,
          playback_speed: 1.5,
        },
        subscription_default_playback_speed: 2,
        last_error_code: null,
      },
    });
    mockUseMediaViewState.mockImplementation(() => currentViewState);

    render(<MediaPaneBody />);

    await waitFor(() => {
      expect(mockSetTrack).toHaveBeenCalledWith(
        expect.objectContaining({
          media_id: "media-1",
          title: "Example transcript",
          stream_url: "https://cdn.example.com/podcast.mp3",
          source_url: "https://example.com/episodes/1",
          podcast_title: "Example podcast",
          image_url: "https://cdn.example.com/cover.jpg",
        }),
        {
          autoplay: false,
          seek_seconds: 12,
          playback_rate: 1.5,
        }
      );
    });
  });

  it("falls back to the subscription default speed when transcript audio has no saved progress", async () => {
    currentViewState = buildViewState({
      isTranscriptMedia: true,
      playbackSource: {
        kind: "external_audio",
        stream_url: "https://cdn.example.com/podcast.mp3",
        source_url: "https://example.com/episodes/1",
      },
      media: {
        id: "media-1",
        kind: "podcast_episode",
        title: "Example transcript",
        processing_status: "ready_for_reading",
        canonical_source_url: "https://example.com/episodes/1",
        podcast_title: "Example podcast",
        podcast_image_url: "https://cdn.example.com/cover.jpg",
        chapters: [],
        description_html: null,
        description_text: null,
        listening_state: null,
        subscription_default_playback_speed: 1.75,
        last_error_code: null,
      },
    });
    mockUseMediaViewState.mockImplementation(() => currentViewState);

    render(<MediaPaneBody />);

    await waitFor(() => {
      expect(mockSetTrack).toHaveBeenCalledWith(
        expect.objectContaining({
          media_id: "media-1",
          title: "Example transcript",
          stream_url: "https://cdn.example.com/podcast.mp3",
          source_url: "https://example.com/episodes/1",
        }),
        {
          autoplay: false,
          playback_rate: 1.75,
        }
      );
    });
  });

  it("does not hydrate the global player for transcript videos", () => {
    currentViewState = buildViewState({
      isTranscriptMedia: true,
      playbackSource: {
        kind: "external_video",
        stream_url: "https://www.youtube.com/watch?v=abc123",
        source_url: "https://www.youtube.com/watch?v=abc123",
        provider: "youtube",
        provider_video_id: "abc123",
        watch_url: "https://www.youtube.com/watch?v=abc123",
        embed_url: "https://www.youtube.com/embed/abc123",
      },
      media: {
        id: "media-1",
        kind: "video",
        title: "Example transcript video",
        processing_status: "ready_for_reading",
        canonical_source_url: "https://www.youtube.com/watch?v=abc123",
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

    render(<MediaPaneBody />);

    expect(mockSetTrack).not.toHaveBeenCalled();
    expect(getLatestTranscriptMediaPaneProps()).toMatchObject({
      mediaKind: "video",
      playbackSource: expect.objectContaining({
        kind: "external_video",
      }),
    });
  });

  it("keeps transcript in the transcript shell while web and epub stay on the ReaderContentArea path", () => {
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
