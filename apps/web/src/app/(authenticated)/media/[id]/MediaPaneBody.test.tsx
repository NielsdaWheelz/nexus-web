import { useCallback, useState, type ReactNode } from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import type { ActionMenuOption } from "@/components/ui/ActionMenu";
import { PaneFixedChromeContext } from "@/components/workspace/PaneFixedChrome";
import { PaneSecondaryContext } from "@/components/workspace/PaneSecondary";
import {
  getPublishedSecondarySurface,
  type PaneSecondaryPublication,
} from "@/lib/panes/panePublications";
import type { WorkspaceSecondarySurfaceId } from "@/lib/panes/paneSecondaryModel";
import {
  readerApparatusOmittedSurfacePayloadFixtures,
  readerApparatusRowPayloadFixtures,
  type ReaderApparatusFixtureEntry,
} from "@/lib/reader/__fixtures__/reader-apparatus";
import type { WorkspaceAttachedSecondaryPaneState } from "@/lib/workspace/schema";
import {
  NOTE_PULSE_HIGHLIGHT,
  READER_PULSE_HIGHLIGHT,
} from "@/lib/reader/pulseEvent";
import type {
  ReaderApparatusItem,
  ReaderApparatusResponse,
} from "@/lib/reader/apparatus";
import type {
  ReaderConnectionPage,
  ReaderDocumentMapEmbedItem,
} from "@/lib/reader/documentMap";
import MediaPaneBody from "./MediaPaneBody";

const testState = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  mediaKind: "pdf" as "pdf" | "web_article" | "epub" | "video",
  includeToc: false,
  isMobileViewport: false,
  fragmentHtml: "<p>Readable text.</p>",
  fragmentCanonicalText: "",
  renderHtmlInMock: false,
  apparatusResponse: null as ReaderApparatusResponse | null,
  documentMapConnections: null as ReaderConnectionPage | null,
  documentMapEmbeds: null as ReaderDocumentMapEmbedItem[] | null,
  readerFocusMode: "off" as
    | "off"
    | "distraction_free"
    | "paragraph"
    | "sentence",
  readerPersistence: { state: "Clean" } as
    | { state: "Clean" }
    | { state: "Pending" }
    | { state: "Forbidden"; failure: unknown },
  readerContextFns: {
    setTheme: vi.fn(),
    setFontFamily: vi.fn(),
    setFocusMode: vi.fn(),
    setHyphenation: vi.fn(),
    setFontSize: vi.fn(),
    setLineHeight: vi.fn(),
    setColumnWidth: vi.fn(),
    retrySave: vi.fn(),
  },
}));

const paneShellMocks = vi.hoisted(() => ({
  usePaneChromeOverride: vi.fn(),
  usePaneMobileChromeController: vi.fn(() => null),
}));

vi.mock("@/lib/api/client", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api/client")>(
      "@/lib/api/client",
    );
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => testState.apiFetch(...args),
    isApiError: (error: unknown) =>
      Boolean(error && typeof error === "object" && "status" in error),
  };
});

vi.mock("@/lib/ui/useIsMobileViewport", () => ({
  useIsMobileViewport: () => testState.isMobileViewport,
}));

vi.mock("@/components/workspace/PaneShell", () => ({
  usePaneChromeOverride: paneShellMocks.usePaneChromeOverride,
}));

vi.mock("@/lib/workspace/mobileChrome", () => ({
  usePaneMobileChromeController: paneShellMocks.usePaneMobileChromeController,
}));

vi.mock("@/lib/reader/ReaderContext", () => ({
  useReaderContext: () => ({
    profile: {
      theme: "light",
      font_family: "serif",
      font_size_px: 16,
      line_height: 1.5,
      column_width_ch: 65,
      focus_mode: testState.readerFocusMode,
      hyphenation: "auto",
    },
    persistence: testState.readerPersistence,
    ...testState.readerContextFns,
  }),
}));

vi.mock("@/lib/media/useLibraryMembership", () => ({
  useLibraryMembership: () => ({
    libraries: [],
    loading: false,
    error: null,
    busy: false,
    loadLibraries: vi.fn(),
    addToLibrary: vi.fn(),
    removeFromLibrary: vi.fn(),
  }),
}));

vi.mock("@/lib/media/useDocumentActions", () => ({
  useDocumentActions: () => ({
    deleteBusy: false,
    retryBusy: false,
    refreshBusy: false,
    retryMetadataBusy: false,
    handleDelete: vi.fn(),
    handleRetry: vi.fn(),
    handleRefresh: vi.fn(),
    handleRetryMetadata: vi.fn(),
  }),
}));

const PDF_INTRINSIC_WIDTH_PX = 812;

vi.mock("@/components/PdfReader", () => ({
  default: ({
    onIntrinsicWidthChange,
  }: {
    onIntrinsicWidthChange?: (state: {
      maxRenderedPageWidthPx: number | null;
    }) => void;
  }) => {
    window.setTimeout(() => {
      onIntrinsicWidthChange?.({
        maxRenderedPageWidthPx: 812,
      });
    }, 0);
    return <div data-testid="pdf-reader" />;
  },
}));

vi.mock("@/components/HtmlRenderer", () => ({
  default: ({
    htmlSanitized,
    className,
  }: {
    htmlSanitized: string;
    className?: string;
  }) => {
    if (!testState.renderHtmlInMock) {
      return <div data-testid="html-renderer" className={className} />;
    }
    if (htmlSanitized.includes('data-reader-apparatus-item-id="marker-1"')) {
      return (
        <div data-testid="html-renderer" className={className}>
          <p>
            Claim
            <a href="#fn1" data-reader-apparatus-item-id="marker-1">
              1
            </a>
          </p>
          <aside id="fn1" data-reader-apparatus-item-id="target-1">
            Document footnote text.
          </aside>
        </div>
      );
    }
    if (htmlSanitized.includes('data-reader-apparatus-item-id="margin-1"')) {
      return (
        <div data-testid="html-renderer" className={className}>
          <p>
            Claim
            <span data-reader-apparatus-item-id="margin-1">
              Standalone margin note body.
            </span>
          </p>
        </div>
      );
    }
    return <div data-testid="html-renderer" className={className} />;
  },
}));

vi.mock("@/components/reader/ReaderDocumentMapOverviewRail", () => ({
  default: ({ onOpenMap }: { onOpenMap: () => void }) => (
    <button type="button" onClick={onOpenMap}>
      Open Document Map
    </button>
  ),
}));

const DOCUMENT_MAP_OVERVIEW_RAIL_WIDTH_PX = 28;
const READER_SHELL_REPRESENTATIVE_ROW_FIXTURE_IDS = [
  "html-distill-gp-full",
  "html-numinous-ttft-full",
  "epub-standardebooks-james-pragmatism",
  "pdf-attention-native-link-graph",
  "pdf-law-review-footnotes",
  "tei-philpapers-lop-aiz-grobid-0-8-2",
  "arxiv-2606-source-package",
  "html-tufte-css-full",
  "html-gwern-sidenote-full",
] as const;

const readerShellRepresentativeRowFixtures =
  READER_SHELL_REPRESENTATIVE_ROW_FIXTURE_IDS.map((fixtureId) => {
    const entry = readerApparatusRowPayloadFixtures.find(
      (candidate) => candidate.fixtureId === fixtureId,
    );
    if (!entry) {
      throw new Error(`Missing reader apparatus row fixture ${fixtureId}`);
    }
    return entry;
  });

type PaneChromeOverrides = {
  toolbar?: ReactNode;
  options?: ActionMenuOption[];
};

function jsonResponse(data: unknown) {
  return { data };
}

function pathOf(input: unknown): string {
  return new URL(String(input), "http://localhost").pathname;
}

function apiCallsForPath(path: string): unknown[][] {
  return testState.apiFetch.mock.calls.filter(([input]) => pathOf(input) === path);
}

function mediaKindForPayload(entry: ReaderApparatusFixtureEntry) {
  const kind = entry.payload.apparatus.media_kind;
  if (kind !== "pdf" && kind !== "web_article" && kind !== "epub") {
    throw new Error(`Unsupported MediaPaneBody apparatus fixture kind: ${kind}`);
  }
  return kind;
}

function mediaResponse() {
  return {
    id: "media-1",
    kind: testState.mediaKind,
    title: "Reader fixture",
    canonical_source_url: null,
    processing_status: "ready_for_reading",
    retrieval_status: "ready",
    contributors: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    capabilities: {
      can_read: true,
      can_highlight: true,
      can_quote: true,
      can_search: true,
      can_play: false,
      can_download_file: false,
      can_read_embeds: testState.mediaKind === "web_article",
    },
  };
}

function apparatusResponse(): ReaderApparatusResponse {
  return (
    testState.apparatusResponse ?? {
      media_id: "media-1",
      media_kind: testState.mediaKind,
      status: "empty",
      extractor_version: "reader_apparatus_v1",
      source_fingerprint: "sha256:test",
      capabilities: {
        has_inline_markers: false,
        has_sidecar_items: false,
        supports_hover_preview: false,
        supports_jump_to_marker: false,
        supports_jump_to_target: false,
        has_probable_items: false,
      },
      items: [],
      edges: [],
      diagnostics: {},
    }
  );
}

function apparatusItem(
  id: string,
  item: Omit<ReaderApparatusItem, "id" | "resource_ref">,
): ReaderApparatusItem {
  return {
    id,
    resource_ref: `reader_apparatus_item:${id}`,
    ...item,
  };
}

function readerDocumentMapResponse() {
  const apparatus = apparatusResponse();
  const citationCount =
    apparatus.status === "ready" || apparatus.status === "partial"
      ? apparatus.items.length
      : 0;
  const connections = testState.documentMapConnections ?? {
    anchored: [],
    unanchored: [],
    next_cursor: null,
  };
  const connectionCount = connections.anchored.length + connections.unanchored.length;
  const embeds = testState.documentMapEmbeds ?? [];
  return {
    media_id: "media-1",
    media_kind: testState.mediaKind,
    title: "Reader fixture",
    status: "ready",
    source_version: {
      media_updated_at: "2026-01-01T00:00:00Z",
      content_fingerprint: null,
      apparatus_source_fingerprint: apparatus.source_fingerprint,
      graph_max_updated_at: null,
      highlights_max_updated_at: null,
    },
    lenses: [
      {
        id: "contents",
        label: "Contents",
        status: "ready",
        item_count: 1,
        anchored_count: 1,
        unanchored_count: 0,
      },
      {
        id: "highlights",
        label: "Highlights",
        status: "empty",
        item_count: 0,
        anchored_count: 0,
        unanchored_count: 0,
      },
      {
        id: "embeds",
        label: "Embeds",
        status: embeds.length > 0 ? "ready" : "empty",
        item_count: embeds.length,
        anchored_count: embeds.filter((item) => item.anchor).length,
        unanchored_count: embeds.filter((item) => !item.anchor).length,
      },
      {
        id: "citations",
        label: "Citations",
        status: citationCount > 0 ? apparatus.status : "empty",
        item_count: citationCount,
        anchored_count: citationCount,
        unanchored_count: 0,
      },
      {
        id: "connections",
        label: "Connections",
        status: connectionCount > 0 ? "ready" : "empty",
        item_count: connectionCount,
        anchored_count: connections.anchored.length,
        unanchored_count: connections.unanchored.length,
      },
      {
        id: "chat",
        label: "Chat",
        status: "empty",
        item_count: 0,
        anchored_count: 0,
        unanchored_count: 0,
      },
    ],
    items: embeds,
    markers: [
      {
        id: "marker:contents:section-1",
        item_id: "section:section-1",
        lens_id: "contents",
        lane: "contents",
        position: 0.5,
        status: "container",
        tone: "neutral",
        label: "Section 1",
        preview: null,
      },
    ],
    navigation: null,
    highlights: [],
    apparatus,
    connections,
    chat_threads: [],
    diagnostics: {
      omitted_item_counts: {},
      partial_lenses: [],
      owner_warnings: [],
    },
  };
}

function fragmentResponse() {
  return [
    {
      id: "fragment-1",
      media_id: "media-1",
      idx: 0,
      html_sanitized: testState.fragmentHtml,
      canonical_text: testState.fragmentCanonicalText,
      document_embeds: [],
      created_at: "2026-01-01T00:00:00Z",
    },
  ];
}

function navigationTocNodes() {
  if (!testState.includeToc) {
    return [];
  }
  return [
    {
      id: "toc-section-1",
      label: "Section 1",
      ordinal: 0,
      href: testState.mediaKind === "epub" ? "chapter-1.xhtml#start" : null,
      fragment_idx: 0,
      level: 1,
      depth: 0,
      section_id: "section-1",
      children: [],
    },
  ];
}

function readerContentsSecondaryPane(): WorkspaceAttachedSecondaryPaneState {
  return {
    id: "secondary-1",
    parentPrimaryPaneId: "pane-1",
    groupId: "reader-tools",
    activeSurfaceId: "reader-contents",
    widthPx: 360,
    visibility: "visible",
  };
}

function latestChromeOverrides(): PaneChromeOverrides | null {
  const call = paneShellMocks.usePaneChromeOverride.mock.calls.at(-1);
  return (call?.[0] as PaneChromeOverrides | undefined) ?? null;
}

async function renderLatestToolbar() {
  let toolbar: ReactNode = null;
  await waitFor(() => {
    toolbar = latestChromeOverrides()?.toolbar ?? null;
    expect(toolbar).not.toBeNull();
  });
  render(<>{toolbar}</>);
}

function latestSecondaryPublication(
  onSetPaneSecondary: ReturnType<typeof vi.fn>,
): PaneSecondaryPublication | null {
  for (const [publication] of [...onSetPaneSecondary.mock.calls].reverse()) {
    if (publication) {
      return publication as PaneSecondaryPublication;
    }
  }
  return null;
}

async function getContentsSurfaceBody(
  onSetPaneSecondary: ReturnType<typeof vi.fn>,
): Promise<ReactNode> {
  let body: ReactNode = null;
  await waitFor(() => {
    const publication = latestSecondaryPublication(onSetPaneSecondary);
    body =
      getPublishedSecondarySurface(publication, "reader-contents")?.body ?? null;
    expect(body).not.toBeNull();
  });
  return body;
}

async function getChromeOption(id: string): Promise<ActionMenuOption> {
  let option: ActionMenuOption | undefined;
  await waitFor(() => {
    option = latestChromeOverrides()?.options?.find((item) => item.id === id);
    expect(option).toBeDefined();
  });
  return option as ActionMenuOption;
}

async function getApparatusSurfaceBody(
  onSetPaneSecondary: ReturnType<typeof vi.fn>,
): Promise<ReactNode> {
  // Wait for document-map fetch so apparatus rows are populated in the publication.
  await waitFor(() => {
    expect(apiCallsForPath("/api/media/media-1/document-map")).toHaveLength(1);
  });
  let body: ReactNode = null;
  await waitFor(() => {
    const publication = latestSecondaryPublication(onSetPaneSecondary);
    body =
      getPublishedSecondarySurface(publication, "reader-evidence")?.body ?? null;
    expect(body).not.toBeNull();
  });
  return body;
}

function activation(resourceRef: string, href: string | null) {
  return {
    resourceRef,
    kind: href ? "route" : "none",
    href,
    unresolvedReason: href ? null : "missing",
  } as const;
}

function noteTargetConnectionPage(): ReaderConnectionPage {
  const noteBlockId = "33333333-3333-4333-8333-333333333333";
  return {
    anchored: [
      {
        id: "edge:edge-note:anchor:highlight",
        connection: {
          edge_id: "edge-note",
          direction: "outgoing",
          kind: "context",
          origin: "highlight_note",
          snapshot: null,
          source_order_key: null,
          target_order_key: null,
          ordinal: null,
          source_ref: "highlight:22222222-2222-4222-8222-222222222222",
          target_ref: `note_block:${noteBlockId}`,
          source: {
            ref: "highlight:22222222-2222-4222-8222-222222222222",
            scheme: "highlight",
            id: "22222222-2222-4222-8222-222222222222",
            label: "Current highlight",
            description: null,
            activation: activation(
              "highlight:22222222-2222-4222-8222-222222222222",
              "/media/media-1#highlight-22222222-2222-4222-8222-222222222222",
            ),
            href: "/media/media-1#highlight-22222222-2222-4222-8222-222222222222",
            missing: false,
          },
          target: {
            ref: `note_block:${noteBlockId}`,
            scheme: "note_block",
            id: noteBlockId,
            label: "Research note",
            description: null,
            activation: activation(`note_block:${noteBlockId}`, `/notes/${noteBlockId}`),
            href: `/notes/${noteBlockId}`,
            missing: false,
          },
          other: {
            ref: `note_block:${noteBlockId}`,
            scheme: "note_block",
            id: noteBlockId,
            label: "Research note",
            description: null,
            activation: activation(`note_block:${noteBlockId}`, `/notes/${noteBlockId}`),
            href: `/notes/${noteBlockId}`,
            missing: false,
          },
          citation: {
            ordinal: 1,
            role: "context",
            snapshot: { excerpt: "Target note excerpt." },
            activation: activation(`note_block:${noteBlockId}`, `/notes/${noteBlockId}`),
            target_reader: {
              media_id: null,
              locator: {
                type: "note_block_offsets",
                block_id: noteBlockId,
                start_offset: 2,
                end_offset: 18,
              },
            },
            target_status: "current",
          },
          created_at: "2026-01-01T00:00:00Z",
        },
        anchor: {
          ref: "highlight:22222222-2222-4222-8222-222222222222",
          media_id: "media-1",
          locator: {
            type: "web_text_offsets",
            media_id: "media-1",
            fragment_id: "fragment-1",
            start_offset: 0,
            end_offset: 8,
          },
          page_number: null,
          fragment_id: "fragment-1",
          highlight_id: "22222222-2222-4222-8222-222222222222",
          evidence_span_id: null,
          passage_anchor_id: null,
          order_key: "fragment:0000000000:0000000000",
        },
        source_category: "highlight_note",
        title: "Research note",
        subtitle: "highlight_note · context",
        excerpt: "Target note excerpt.",
        activation: activation(`note_block:${noteBlockId}`, `/notes/${noteBlockId}`),
        href: `/notes/${noteBlockId}`,
      },
    ],
    unanchored: [],
    next_cursor: null,
  };
}

function PaneSecondaryTestHost({
  onSetPaneSecondary,
  renderSurfaceId,
  children,
}: {
  onSetPaneSecondary: (next: PaneSecondaryPublication | null) => void;
  renderSurfaceId?: WorkspaceSecondarySurfaceId;
  children: ReactNode;
}) {
  const [publication, setPublication] =
    useState<PaneSecondaryPublication | null>(null);
  const publish = useCallback(
    (next: PaneSecondaryPublication | null) => {
      onSetPaneSecondary(next);
      setPublication(next);
    },
    [onSetPaneSecondary],
  );
  const secondaryBody = renderSurfaceId
    ? (getPublishedSecondarySurface(publication, renderSurfaceId)?.body ?? null)
    : null;
  return (
    <PaneSecondaryContext.Provider value={publish}>
      {children}
      {secondaryBody}
    </PaneSecondaryContext.Provider>
  );
}

function renderMediaPane(
  options: {
    secondaryPane?: WorkspaceAttachedSecondaryPaneState | null;
    renderSecondarySurfaceId?: WorkspaceSecondarySurfaceId;
  } = {},
) {
  const href = "/media/media-1";
  const identity = resolvePaneRouteIdentity(href);
  const onSetPaneLayout = vi.fn();
  const onNavigatePane = vi.fn();
  const onRequestSecondarySurface = vi.fn();
  const onCloseSecondaryPane = vi.fn();
  const onSetFixedChrome = vi.fn();
  const onSetPaneSecondary = vi.fn();

  render(
    <FeedbackProvider>
      <LecternProvider>
      <GlobalPlayerProvider>
      <PaneRuntimeProvider
        paneId="pane-1"
        isActive={true}
        href={href}
        routeId={identity.routeId}
        routeKey={identity.routeKey}
        secondaryPane={options.secondaryPane ?? null}
        canGoBack={false}
        canGoForward={false}
        onGoBackPane={vi.fn()}
        onGoForwardPane={vi.fn()}
        pathParams={{ id: "media-1" }}
        onNavigatePane={onNavigatePane}
        onReplacePane={vi.fn()}
        onOpenInNewPane={vi.fn()}
        onSetPaneLayout={onSetPaneLayout}
        onRequestSecondarySurface={onRequestSecondarySurface}
        onCloseSecondaryPane={onCloseSecondaryPane}
      >
        <PaneSecondaryTestHost
          onSetPaneSecondary={onSetPaneSecondary}
          renderSurfaceId={options.renderSecondarySurfaceId}
        >
          <PaneFixedChromeContext.Provider value={onSetFixedChrome}>
            <MediaPaneBody />
          </PaneFixedChromeContext.Provider>
        </PaneSecondaryTestHost>
      </PaneRuntimeProvider>
      </GlobalPlayerProvider>
      </LecternProvider>
    </FeedbackProvider>,
  );

  return {
    onSetPaneLayout,
    onNavigatePane,
    onRequestSecondarySurface,
    onCloseSecondaryPane,
    onSetPaneSecondary,
    onSetFixedChrome,
    routeKey: identity.routeKey,
  };
}

describe("MediaPaneBody pane sizing", () => {
  beforeEach(() => {
    testState.apiFetch.mockReset();
    testState.includeToc = false;
    testState.isMobileViewport = false;
    testState.fragmentHtml = "<p>Readable text.</p>";
    testState.fragmentCanonicalText = "";
    testState.renderHtmlInMock = false;
    testState.apparatusResponse = null;
    testState.documentMapConnections = null;
    testState.documentMapEmbeds = null;
    testState.readerFocusMode = "off";
    testState.readerPersistence = { state: "Clean" };
    paneShellMocks.usePaneChromeOverride.mockReset();
    paneShellMocks.usePaneMobileChromeController.mockClear();
    for (const fn of Object.values(testState.readerContextFns)) {
      fn.mockReset();
    }
    testState.apiFetch.mockImplementation(
      async (input: unknown, init?: RequestInit) => {
        const path = pathOf(input);
        if (path === "/api/lectern") {
          // Lets the LecternProvider (consumed by the pane) settle to Ready.
          return jsonResponse({ items: [] });
        }
        if (path === "/api/media/media-1") {
          return jsonResponse(mediaResponse());
        }
        if (path === "/api/media/media-1/reader-state") {
          if (init?.method === "PUT") {
            const body = init.body ? JSON.parse(String(init.body)) : {};
            return jsonResponse({
              state: "Positioned",
              revision: 1,
              locator: body.locator,
            });
          }
          return jsonResponse({ state: "Empty", revision: 0 });
        }
        if (path === "/api/media/media-1/fragments") {
          return jsonResponse(fragmentResponse());
        }
        if (path === "/api/media/media-1/navigation") {
          return jsonResponse({
            media_id: "media-1",
            kind: testState.mediaKind,
            sections: [
              {
                section_id: "section-1",
                label: "Section 1",
                ordinal: 0,
                fragment_id: "fragment-1",
                fragment_idx: 0,
                level: 1,
                depth: 0,
                start_offset: 0,
                end_offset: 0,
                href_path: "chapter-1.xhtml",
                href_fragment: null,
                anchor_id: null,
                char_count: 0,
              },
            ],
            toc_nodes: navigationTocNodes(),
            landmarks: [],
            page_list: [],
          });
        }
        if (path === "/api/media/media-1/document-map") {
          return jsonResponse(readerDocumentMapResponse());
        }
        if (path === "/api/media/media-1/sections/section-1") {
          return jsonResponse({
            section_id: "section-1",
            label: "Section 1",
            fragment_id: "fragment-1",
            fragment_idx: 0,
            href_path: "chapter-1.xhtml",
            anchor_id: null,
            source_node_id: null,
            source: "spine",
            ordinal: 0,
            prev_section_id: null,
            next_section_id: null,
            html_sanitized: testState.fragmentHtml,
            canonical_text: testState.fragmentCanonicalText,
            char_count: 0,
            word_count: 2,
            created_at: "2026-01-01T00:00:00Z",
          });
        }
        if (path === "/api/media/media-1/highlights") {
          return jsonResponse({ highlights: [] });
        }
        if (path === "/api/fragments/fragment-1/highlights") {
          return jsonResponse({ highlights: [] });
        }
        throw new Error(`Unexpected API call: ${path}`);
      },
    );
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserverMock {
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );
  });

  it.each(["web_article", "epub"] as const)(
    "publishes workspace primary layout and fixed chrome for %s",
    async (kind) => {
      testState.mediaKind = kind;
      const { onSetPaneLayout, onSetFixedChrome, routeKey } =
        renderMediaPane();

      await waitFor(() => {
        expect(onSetPaneLayout).toHaveBeenCalledWith({
          paneId: "pane-1",
          routeKey,
          layout: {
            primaryWidth: { kind: "workspace" },
          },
        });
      });
      await waitFor(() => {
        expect(onSetFixedChrome).toHaveBeenCalledWith(
          expect.objectContaining({
            id: "reader-document-map-overview-rail",
            widthPx: DOCUMENT_MAP_OVERVIEW_RAIL_WIDTH_PX,
          }),
        );
      });
    },
  );

  it("publishes intrinsic PDF primary layout and fixed chrome", async () => {
    testState.mediaKind = "pdf";
    const { onSetPaneLayout, onSetFixedChrome, routeKey } =
      renderMediaPane();

    await waitFor(() => {
      expect(onSetPaneLayout).toHaveBeenCalledWith({
        paneId: "pane-1",
        routeKey,
        layout: {
          primaryWidth: { kind: "intrinsic", widthPx: PDF_INTRINSIC_WIDTH_PX },
        },
      });
    });
    await waitFor(() => {
      expect(onSetFixedChrome).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "reader-document-map-overview-rail",
          widthPx: DOCUMENT_MAP_OVERVIEW_RAIL_WIDTH_PX,
        }),
      );
    });
  });

  it.each(["epub", "web_article"] as const)(
    "renders readable %s text content",
    async (kind) => {
      testState.mediaKind = kind;
      renderMediaPane();

      expect(await screen.findByTestId("html-renderer")).toBeInTheDocument();
    },
  );

  it("renders the media authors byline with an empty-author state", async () => {
    testState.mediaKind = "web_article";
    renderMediaPane();

    expect(await screen.findByTestId("html-renderer")).toBeInTheDocument();
    expect(screen.getByText("Authors")).toBeInTheDocument();
    expect(screen.getByText("No authors")).toBeInTheDocument();
  });

  it("loads web article fragments once", async () => {
    testState.mediaKind = "web_article";
    renderMediaPane();

    expect(await screen.findByTestId("html-renderer")).toBeInTheDocument();

    expect(
      testState.apiFetch.mock.calls.filter(
        ([input]) => pathOf(input) === "/api/media/media-1/fragments",
      ),
    ).toHaveLength(1);
  });

  it("publishes one-node web article contents independent of highlights", async () => {
    testState.mediaKind = "web_article";
    testState.includeToc = true;
    testState.readerFocusMode = "paragraph";
    const { onSetPaneSecondary } = renderMediaPane();

    await waitFor(() => {
      const publication = latestSecondaryPublication(onSetPaneSecondary);
      expect(publication).toMatchObject({
        groupId: "reader-tools",
        defaultSurfaceId: "reader-contents",
      });
      expect(publication?.surfaces.map((surface) => surface.id)).toEqual([
        "reader-contents",
        "reader-evidence",
      ]);
    });
  });

  it("does not publish reader-embeds; publishes reader-evidence instead, even with embed items", async () => {
    testState.mediaKind = "web_article";
    testState.fragmentHtml =
      '<p>Before.</p><figure data-nexus-document-embed-id="embed:000000:youtube:dQw4w9WgXcQ"><figcaption>Embedded video: Launch video</figcaption></figure>';
    testState.fragmentCanonicalText = "Before.\nEmbedded video: Launch video";
    testState.documentMapEmbeds = [
      {
        id: "embed:embed-1",
        lens_ids: ["embeds"],
        kind: "document_embed",
        source_domain: "document_embeds",
        title: "Embedded video: Launch video",
        subtitle: "youtube",
        excerpt: "Launch video",
        activation: null,
        href: "/media/child-1",
        anchor: {
          ref: "media:media-1",
          media_id: "media-1",
          locator: {
            type: "web_text_offsets",
            media_id: "media-1",
            fragment_id: "fragment-1",
            start_offset: 8,
            end_offset: 36,
          },
          page_number: null,
          fragment_id: "fragment-1",
          highlight_id: null,
          evidence_span_id: null,
          passage_anchor_id: null,
          order_key: "fragment:0000000000:0000000008",
          precision: "exact",
        },
        document_order_key: "fragment:0000000000:0000000008",
        document_fraction: 0.5,
        target_status: "exact",
        provenance: { owner: "document_embeds" },
        actions: ["activate"],
        document_embed_id: "embed-1",
        occurrence_key: "embed:000000:youtube:dQw4w9WgXcQ",
        provider: "youtube",
        embed_kind: "video",
        resolution_status: "resolved",
      },
    ];
    const { onSetPaneSecondary } = renderMediaPane();

    await waitFor(() => {
      const publication = latestSecondaryPublication(onSetPaneSecondary);
      expect(publication?.surfaces.map((surface) => surface.id)).not.toContain(
        "reader-embeds",
      );
      expect(publication?.surfaces.map((surface) => surface.id)).toContain(
        "reader-evidence",
      );
    });
  });

  it("does not publish a reader-resource-chat surface", async () => {
    const { onSetPaneSecondary } = renderMediaPane();
    await waitFor(() => {
      const publication = latestSecondaryPublication(onSetPaneSecondary);
      expect(publication).not.toBeNull();
    });
    const publication = latestSecondaryPublication(onSetPaneSecondary);
    expect(publication?.surfaces.map((s) => s.id)).not.toContain("reader-resource-chat");
  });

  it("publishes Citations and previews a source-authored marker", async () => {
    testState.mediaKind = "web_article";
    testState.renderHtmlInMock = true;
    testState.fragmentHtml =
      '<p>Claim<a href="#fn1" data-reader-apparatus-item-id="marker-1">1</a></p>' +
      '<aside id="fn1" data-reader-apparatus-item-id="target-1">Document footnote text.</aside>';
    testState.fragmentCanonicalText = "Claim1\nDocument footnote text.";
    testState.apparatusResponse = {
      media_id: "media-1",
      media_kind: "web_article",
      status: "ready",
      extractor_version: "reader_apparatus_v1",
      source_fingerprint: "sha256:test",
      capabilities: {
        has_inline_markers: true,
        has_sidecar_items: true,
        supports_hover_preview: true,
        supports_jump_to_marker: true,
        supports_jump_to_target: true,
        has_probable_items: false,
      },
      items: [
        apparatusItem("11111111-1111-4111-8111-111111111111", {
          stable_key: "target-1",
          kind: "footnote",
          label: "1",
          body_text: "Preview note body.",
          body_html_sanitized: null,
          locator: {
            type: "web_text_offsets",
            media_id: "media-1",
            fragment_id: "fragment-1",
            start_offset: 7,
            end_offset: 30,
            media_kind: "web_article",
            text_quote_selector: { exact: "Document footnote text." },
          },
          locator_status: "exact",
          confidence: "exact",
          extraction_method: "html_semantic",
          source_ref: { format: "html", target_id: "fn1" },
          sort_key: "000000.target",
        }),
        apparatusItem("22222222-2222-4222-8222-222222222222", {
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
          extraction_method: "html_semantic",
          source_ref: { format: "html", target_id: "fn1" },
          sort_key: "000000.marker",
        }),
      ],
      edges: [
        {
          stable_key: "marker-1->target-1",
          from_stable_key: "marker-1",
          to_stable_key: "target-1",
          relation: "points_to_note",
          confidence: "exact",
          extraction_method: "html_semantic",
          source_ref: { format: "html", target_id: "fn1" },
          sort_key: "000000.edge",
        },
      ],
      diagnostics: {},
    };
    const { onRequestSecondarySurface, onSetPaneSecondary } = renderMediaPane();

    await waitFor(() => {
      const publication = latestSecondaryPublication(onSetPaneSecondary);
      expect(publication?.surfaces.map((surface) => surface.id)).toContain(
        "reader-evidence",
      );
    });

    const user = userEvent.setup();
    const marker = await screen.findByText("1");
    await user.hover(marker);

    expect(
      await screen.findByRole("tooltip", {}, { timeout: 3_000 }),
    ).toHaveTextContent("Preview note body.");

    fireEvent.click(screen.getByText("1"));
    expect(onRequestSecondarySurface).toHaveBeenCalledWith(
      "pane-1",
      "reader-evidence",
    );
  });

  it("keeps the generated Citations shell matrix representative and explicit", () => {
    expect(readerShellRepresentativeRowFixtures.map((entry) => entry.fixtureId)).toEqual(
      [...READER_SHELL_REPRESENTATIVE_ROW_FIXTURE_IDS],
    );
    for (const entry of readerShellRepresentativeRowFixtures) {
      expect(entry.expectedReaderToolsSurface).toBe("citations_tab_rows");
      expect(entry.expectedRowCount).toBeGreaterThan(0);
      expect(entry.payload.apparatus.capabilities.has_sidecar_items).toBe(true);
    }
  });

  it.each(readerApparatusOmittedSurfacePayloadFixtures)(
    "omits the Citations tab for empty apparatus payload $fixtureId",
    async (entry) => {
      testState.mediaKind = entry.payload.apparatus.media_kind as
        | "pdf"
        | "web_article"
        | "epub";
      testState.apparatusResponse = entry.payload.apparatus;

      const { onSetPaneSecondary } = renderMediaPane();

      await waitFor(() => {
        expect(apiCallsForPath("/api/media/media-1/document-map")).toHaveLength(1);
      });
      await waitFor(() => {
        const publication = latestSecondaryPublication(onSetPaneSecondary);
        expect(publication).not.toBeNull();
        expect(publication?.defaultSurfaceId).not.toBe("reader-apparatus");
        expect(publication?.surfaces.map((surface) => surface.id)).not.toContain(
          "reader-apparatus",
        );
        expect(publication?.surfaces.map((surface) => surface.id)).toContain(
          "reader-evidence",
        );
      });
    },
  );

  it.each(readerShellRepresentativeRowFixtures)(
    "publishes and renders Citations shell rows for generated payload $fixtureId",
    async (entry) => {
      testState.mediaKind = mediaKindForPayload(entry);
      testState.apparatusResponse = entry.payload.apparatus;
      testState.isMobileViewport = true;

      const { onSetPaneSecondary } = renderMediaPane();

      await waitFor(() => {
        expect(apiCallsForPath("/api/media/media-1/document-map")).toHaveLength(1);
      });
      await waitFor(() => {
        const publication = latestSecondaryPublication(onSetPaneSecondary);
        expect(publication).not.toBeNull();
        expect(publication?.groupId).toBe("reader-tools");
        expect(publication?.surfaces.map((surface) => surface.id)).toContain(
          "reader-evidence",
        );
      });

      const body = await getApparatusSurfaceBody(onSetPaneSecondary);
      // EvidencePaneSurface reads useFeedback (Link-note toasts); production
      // supplies the provider from app/layout.tsx, so the harness mirrors it.
      const view = render(<FeedbackProvider>{body}</FeedbackProvider>);
      const surface = within(view.container);

      expect(surface.getByRole("heading", { name: "Evidence" })).toBeVisible();
      const rowButtons = surface.getAllByTestId("evidence-apparatus-row");
      expect(rowButtons).toHaveLength(entry.expectedRowCount);
      for (const needle of entry.bodyNeedles) {
        expect(
          surface.getAllByText((content) => content.includes(needle)).length,
          `${entry.fixtureId} body needle ${needle}`,
        ).toBeGreaterThan(0);
      }
      if (entry.fixtureId === "tei-philpapers-lop-aiz-grobid-0-8-2") {
        expect(entry.expectedStatus).toBe("partial");
        expect(entry.payload.apparatus.capabilities.has_probable_items).toBe(true);
      }
      if (entry.fixtureId === "arxiv-2606-source-package") {
        expect(entry.payload.apparatus.capabilities.supports_jump_to_marker).toBe(
          false,
        );
        expect(entry.payload.apparatus.capabilities.supports_jump_to_target).toBe(
          false,
        );
        expect(rowButtons.every((button) => button.hasAttribute("disabled"))).toBe(
          true,
        );
      }
      if (entry.fixtureId === "html-numinous-ttft-full") {
        expect(entry.expectedEdgeCount).toBe(0);
        expect(entry.payload.apparatus.capabilities.supports_hover_preview).toBe(
          false,
        );
      }
      if (entry.fixtureId === "html-tufte-css-full") {
        expect(surface.getAllByText("Sidenote")).toHaveLength(3);
        expect(surface.getAllByText("Margin note")).toHaveLength(4);
      }
      if (entry.fixtureId === "html-gwern-sidenote-full") {
        expect(surface.getAllByText("Endnote")).toHaveLength(6);
      }
    },
  );

  it("publishes Citations for target-only margin notes without hover previews", async () => {
    testState.mediaKind = "web_article";
    testState.isMobileViewport = true;
    testState.renderHtmlInMock = true;
    testState.fragmentHtml =
      '<p>Claim<span data-reader-apparatus-item-id="margin-1">Standalone margin note body.</span></p>';
    testState.fragmentCanonicalText = "ClaimStandalone margin note body.";
    testState.apparatusResponse = {
      media_id: "media-1",
      media_kind: "web_article",
      status: "ready",
      extractor_version: "reader_apparatus_v1",
      source_fingerprint: "sha256:test-margin-note",
      capabilities: {
        has_inline_markers: false,
        has_sidecar_items: true,
        supports_hover_preview: false,
        supports_jump_to_marker: false,
        supports_jump_to_target: true,
        has_probable_items: false,
      },
      items: [
        apparatusItem("33333333-3333-4333-8333-333333333333", {
          stable_key: "margin-1",
          kind: "margin_note",
          label: "Margin note 1",
          body_text: "Standalone margin note body.",
          body_html_sanitized: null,
          locator: {
            type: "web_text_offsets",
            media_id: "media-1",
            fragment_id: "fragment-1",
            start_offset: 5,
            end_offset: 33,
            media_kind: "web_article",
            text_quote_selector: { exact: "Standalone margin note body." },
          },
          locator_status: "exact",
          confidence: "strong",
          extraction_method: "html_margin_note",
          source_ref: { format: "html", element: "span.marginnote" },
          sort_key: "000000.target",
        }),
      ],
      edges: [],
      diagnostics: {},
    };
    const { onRequestSecondarySurface, onSetPaneSecondary } = renderMediaPane({
      renderSecondarySurfaceId: "reader-evidence",
    });

    const marginNoteButton = await screen.findByRole("button", { name: /Margin note/ });
    expect(marginNoteButton).toBeVisible();
    expect(
      screen.getAllByText("Standalone margin note body.").length,
    ).toBeGreaterThan(1);

    const inlineMarginNote = within(
      screen.getByTestId("html-renderer"),
    ).getByText("Standalone margin note body.");
    expect(inlineMarginNote).toBeInstanceOf(HTMLElement);

    const publicationCountBeforeClick = onSetPaneSecondary.mock.calls.length;
    fireEvent.click(marginNoteButton);
    expect(onRequestSecondarySurface).toHaveBeenCalledWith(
      "pane-1",
      "reader-evidence",
    );
    await waitFor(() => {
      expect(onSetPaneSecondary.mock.calls.length).toBeGreaterThan(
        publicationCountBeforeClick,
      );
    });

    const activeInlineMarginNote = within(
      screen.getByTestId("html-renderer"),
    ).getByText("Standalone margin note body.");
    expect(activeInlineMarginNote).toBeInstanceOf(HTMLElement);

    fireEvent.click(activeInlineMarginNote);
    expect(onRequestSecondarySurface).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      expect(activeInlineMarginNote).toHaveClass("reader-apparatus-focused");
    });
    await waitFor(() => {
      expect(activeInlineMarginNote).toHaveClass("reader-apparatus-pulse");
    });

    fireEvent.pointerOver(activeInlineMarginNote);
    await waitFor(() => {
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });
  });

  it("dispatches a PDF reader pulse when a native-link reference row is activated", async () => {
    testState.isMobileViewport = true;
    testState.mediaKind = "pdf";
    testState.apparatusResponse = {
      media_id: "media-1",
      media_kind: "pdf",
      status: "ready",
      extractor_version: "reader_apparatus_v1",
      source_fingerprint: "sha256:test-pdf",
      capabilities: {
        has_inline_markers: true,
        has_sidecar_items: true,
        supports_hover_preview: true,
        supports_jump_to_marker: true,
        supports_jump_to_target: true,
        has_probable_items: false,
      },
      items: [
        apparatusItem("44444444-4444-4444-8444-444444444444", {
          stable_key: "pdf-marker-13",
          kind: "bibliography_ref",
          label: "[13]",
          body_text: null,
          body_html_sanitized: null,
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
          locator_status: "exact",
          confidence: "exact",
          extraction_method: "pdf_native_link",
          source_ref: { format: "pdf", named_destination: "cite.memory" },
          sort_key: "0002.0001.marker",
        }),
        apparatusItem("55555555-5555-4555-8555-555555555555", {
          stable_key: "pdf-target-13",
          kind: "bibliography_entry",
          label: "[13]",
          body_text: "[13] Long short-term memory. Neural computation.",
          body_html_sanitized: null,
          locator: {
            type: "pdf_page_geometry",
            media_id: "media-1",
            page_number: 11,
            quads: [
              {
                x1: 100,
                y1: 200,
                x2: 500,
                y2: 200,
                x3: 500,
                y3: 235,
                x4: 100,
                y4: 235,
              },
            ],
            exact: "[13] Long short-term memory. Neural computation.",
            text_quote_selector: {
              exact: "[13] Long short-term memory. Neural computation.",
            },
          },
          locator_status: "exact",
          confidence: "exact",
          extraction_method: "pdf_native_link_target",
          source_ref: { format: "pdf", target_label: "[13]" },
          sort_key: "0011.000200.000.0013.target",
        }),
      ],
      edges: [
        {
          stable_key: "pdf-marker-13->pdf-target-13",
          from_stable_key: "pdf-marker-13",
          to_stable_key: "pdf-target-13",
          relation: "cites_bibliography_entry",
          confidence: "exact",
          extraction_method: "pdf_native_link_target",
          source_ref: { format: "pdf", named_destination: "cite.memory" },
          sort_key: "0002.0001.edge",
        },
      ],
      diagnostics: {
        pdf_native_link: {
          status: "targets_materialized",
          marker_count: 1,
          target_count: 1,
          edge_count: 1,
          unresolved_marker_count: 0,
        },
      },
    };
    const pulseHandler = vi.fn();
    window.addEventListener(READER_PULSE_HIGHLIGHT, pulseHandler);
    try {
      const { onRequestSecondarySurface } = renderMediaPane({
        renderSecondarySurfaceId: "reader-evidence",
      });

      const refButton = await screen.findByRole("button", { name: /Reference/ });
      fireEvent.click(refButton);

      expect(onRequestSecondarySurface).toHaveBeenCalledWith(
        "pane-1",
        "reader-evidence",
      );
      await waitFor(() => {
        expect(pulseHandler).toHaveBeenCalledTimes(1);
      });
      const event = pulseHandler.mock.calls[0]?.[0] as CustomEvent;
      expect(event.detail).toMatchObject({
        mediaId: "media-1",
        snippet: "[13]",
        highlightBehavior: "pulse",
        focusBehavior: "scroll_into_view",
        locator: {
          type: "pdf_page_geometry",
          media_id: "media-1",
          page_number: 2,
          exact: "[13]",
        },
      });
      expect(
        testState.apiFetch.mock.calls.some(
          ([input, init]) =>
            pathOf(input) === "/api/media/media-1/pdf-highlights" &&
            init?.method === "POST",
        ),
      ).toBe(false);
    } finally {
      window.removeEventListener(READER_PULSE_HIGHLIGHT, pulseHandler);
    }
  });

  it("activates a document-map connection note target through the note pulse path", async () => {
    testState.mediaKind = "web_article";
    testState.includeToc = true;
    testState.documentMapConnections = noteTargetConnectionPage();
    const notePulseHandler = vi.fn();
    window.addEventListener(NOTE_PULSE_HIGHLIGHT, notePulseHandler);
    try {
      renderMediaPane({ renderSecondarySurfaceId: "reader-evidence" });

      fireEvent.click(
        await screen.findByRole("button", {
          name: "Open target in reader for Research note",
        }),
      );

      await waitFor(() => {
        expect(notePulseHandler).toHaveBeenCalledTimes(1);
      });
      const event = notePulseHandler.mock.calls[0]?.[0] as CustomEvent;
      expect(event.detail).toEqual({
        blockId: "33333333-3333-4333-8333-333333333333",
        startOffset: 2,
        endOffset: 18,
        snippet: "Target note excerpt.",
        highlightBehavior: "pulse",
        focusBehavior: "scroll_into_view",
      });
    } finally {
      window.removeEventListener(NOTE_PULSE_HIGHLIGHT, notePulseHandler);
    }
  });

  it.each(["epub", "web_article"] as const)(
    "requests the Document Map secondary from %s mobile reader menu",
    async (kind) => {
      testState.mediaKind = kind;
      testState.includeToc = true;
      testState.isMobileViewport = true;
      const { onRequestSecondarySurface, onSetPaneSecondary } =
        renderMediaPane();
      await getContentsSurfaceBody(onSetPaneSecondary);

      const contentsOption = await getChromeOption("document-map");
      expect(contentsOption.label).toBe("Document Map");

      contentsOption.onSelect?.({ triggerEl: null });

      expect(onRequestSecondarySurface).toHaveBeenCalledWith(
        "pane-1",
        "reader-contents",
      );
    },
  );

  it("keeps mobile Contents available when focus mode hides highlights", async () => {
    testState.mediaKind = "web_article";
    testState.includeToc = true;
    testState.isMobileViewport = true;
    testState.readerFocusMode = "paragraph";
    const { onRequestSecondarySurface, onSetPaneSecondary } = renderMediaPane();
    await getContentsSurfaceBody(onSetPaneSecondary);

    const contentsOption = await getChromeOption("document-map");
    const optionIds = latestChromeOverrides()?.options?.map((option) => option.id);

    expect(optionIds).toContain("document-map");
    expect(optionIds).not.toContain("show-contents");
    expect(optionIds).not.toContain("show-highlights");

    contentsOption.onSelect?.({ triggerEl: null });

    expect(onRequestSecondarySurface).toHaveBeenCalledWith(
      "pane-1",
      "reader-contents",
    );
  });

  it("requests the Document Map secondary from desktop transcript options", async () => {
    testState.mediaKind = "video";
    const { onRequestSecondarySurface, onSetPaneSecondary } = renderMediaPane();

    await waitFor(() => {
      const publication = latestSecondaryPublication(onSetPaneSecondary);
      expect(publication?.surfaces.some((surface) => surface.id === "reader-evidence")).toBe(
        true,
      );
    });

    const documentMapOption = await getChromeOption("document-map");
    expect(documentMapOption.label).toBe("Document Map");

    documentMapOption.onSelect?.({ triggerEl: null });

    expect(onRequestSecondarySurface).toHaveBeenCalledWith(
      "pane-1",
      "reader-evidence",
    );
  });

  it.each(["epub", "web_article"] as const)(
    "requests the Document Map secondary from %s toolbar controls",
    async (kind) => {
      testState.mediaKind = kind;
      testState.includeToc = true;
      const { onRequestSecondarySurface, onSetPaneSecondary } =
        renderMediaPane();
      await getContentsSurfaceBody(onSetPaneSecondary);

      await renderLatestToolbar();
      const contentsButton = screen.getByRole("button", { name: "Document Map" });
      expect(contentsButton).toHaveAttribute("aria-pressed", "false");

      fireEvent.click(contentsButton);

      expect(onRequestSecondarySurface).toHaveBeenCalledWith(
        "pane-1",
        "reader-contents",
      );
    },
  );

  it.each(["epub", "web_article"] as const)(
    "closes the active Document Map secondary from %s toolbar controls",
    async (kind) => {
      testState.mediaKind = kind;
      testState.includeToc = true;
      const { onCloseSecondaryPane, onSetPaneSecondary } = renderMediaPane({
        secondaryPane: readerContentsSecondaryPane(),
      });
      await getContentsSurfaceBody(onSetPaneSecondary);

      await renderLatestToolbar();
      const contentsButton = screen.getByRole("button", { name: "Document Map" });
      expect(contentsButton).toHaveAttribute("aria-pressed", "true");

      fireEvent.click(contentsButton);

      expect(onCloseSecondaryPane).toHaveBeenCalledWith("secondary-1");
    },
  );

  it("keeps the desktop secondary pane open after Contents selection", async () => {
    testState.mediaKind = "web_article";
    testState.includeToc = true;
    const { onCloseSecondaryPane, onSetPaneSecondary } = renderMediaPane({
      secondaryPane: readerContentsSecondaryPane(),
    });
    const body = await getContentsSurfaceBody(onSetPaneSecondary);
    render(<>{body}</>);

    fireEvent.click(screen.getByRole("button", { name: "Section 1" }));

    expect(onCloseSecondaryPane).not.toHaveBeenCalled();
  });

  it("closes the mobile secondary sheet after Contents selection", async () => {
    testState.mediaKind = "web_article";
    testState.includeToc = true;
    testState.isMobileViewport = true;
    const { onCloseSecondaryPane, onSetPaneSecondary } = renderMediaPane({
      secondaryPane: readerContentsSecondaryPane(),
    });
    const body = await getContentsSurfaceBody(onSetPaneSecondary);
    render(<>{body}</>);

    fireEvent.click(screen.getByRole("button", { name: "Section 1" }));

    expect(onCloseSecondaryPane).toHaveBeenCalledWith("secondary-1");
  });

  it("offers the reader theme quick switch for reflowable media, honoring Forbidden", async () => {
    testState.mediaKind = "web_article";
    renderMediaPane();

    const light = await getChromeOption("reader-theme-light");
    const dark = await getChromeOption("reader-theme-dark");
    // The current theme is light: its own option is inert, the other active.
    expect(light.disabled).toBe(true);
    expect(dark.disabled).toBe(false);
    expect(latestChromeOverrides()?.options?.map((option) => option.id)).not.toContain(
      "reader-pdf-source-colors",
    );

    dark.onSelect?.({ triggerEl: null });
    expect(testState.readerContextFns.setTheme).toHaveBeenCalledWith("dark");
  });

  it("disables both theme quick-switch options under terminal Forbidden", async () => {
    testState.mediaKind = "web_article";
    testState.readerPersistence = { state: "Forbidden", failure: {} };
    renderMediaPane();

    const light = await getChromeOption("reader-theme-light");
    const dark = await getChromeOption("reader-theme-dark");
    expect(light.disabled).toBe(true);
    expect(dark.disabled).toBe(true);
  });

  it("shows the static PDF source-colors status row instead of the quick switch for PDFs", async () => {
    testState.mediaKind = "pdf";
    renderMediaPane();

    const statusRow = await getChromeOption("reader-pdf-source-colors");
    expect(statusRow.label).toBe("PDF pages keep their source colors");
    // A render-seam status row: perceivable static content, not a disabled
    // menuitem that keyboard traversal would skip.
    expect(statusRow.render).toBeDefined();
    expect(statusRow.onSelect).toBeUndefined();
    render(<>{statusRow.render?.({ closeMenu: () => {}, triggerEl: null })}</>);
    expect(screen.getByText("PDF pages keep their source colors")).toBeInTheDocument();

    const optionIds = latestChromeOverrides()?.options?.map((option) => option.id);
    expect(optionIds).not.toContain("reader-theme-light");
    expect(optionIds).not.toContain("reader-theme-dark");
  });
});
