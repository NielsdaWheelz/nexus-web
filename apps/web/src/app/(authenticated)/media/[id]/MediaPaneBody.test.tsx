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
import type { WorkspaceAttachedSecondaryPaneState } from "@/lib/workspace/schema";
import { READER_PULSE_HIGHLIGHT } from "@/lib/reader/pulseEvent";
import type { DocumentEmbed } from "@/lib/media/documentEmbeds";
import type { MediaRetrievalLocator } from "@/lib/api/sse/locators";
import type {
  ReaderEvidenceConfidence,
  ReaderEvidenceSourceKind,
} from "@/lib/reader/documentMap";
import MediaPaneBody from "./MediaPaneBody";

const testState = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  mediaKind: "pdf" as "pdf" | "web_article" | "epub" | "video",
  includeToc: false,
  includeSecondEpubSection: false,
  isMobileViewport: false,
  fragmentHtml: "<p>Readable text.</p>",
  fragmentCanonicalText: "",
  renderHtmlInMock: false,
  documentMapDocumentItems: null as unknown[] | null,
  documentMapPassageGroups: null as unknown[] | null,
  documentMapEmbeds: null as DocumentEmbed[] | null,
  readerFocusMode: "off" as
    "off" | "distraction_free" | "paragraph" | "sentence",
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
    onHighlightHover,
  }: {
    onIntrinsicWidthChange?: (state: {
      maxRenderedPageWidthPx: number | null;
    }) => void;
    onHighlightHover?: (highlightId: string | null) => void;
  }) => {
    window.setTimeout(() => {
      onIntrinsicWidthChange?.({
        maxRenderedPageWidthPx: 812,
      });
    }, 0);
    return (
      <div
        data-testid="pdf-reader"
        tabIndex={0}
        onPointerEnter={() =>
          onHighlightHover?.("33333333-3333-4333-8333-333333333333")
        }
        onPointerLeave={() => onHighlightHover?.(null)}
        onFocus={() =>
          onHighlightHover?.("33333333-3333-4333-8333-333333333333")
        }
        onBlur={() => onHighlightHover?.(null)}
      />
    );
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
const PDF_HIGHLIGHT_ID = "33333333-3333-4333-8333-333333333333";
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
  return testState.apiFetch.mock.calls.filter(
    ([input]) => pathOf(input) === path,
  );
}

interface DocumentMapPassageGroupFixture {
  locus_ref: string;
  resolution: { kind: "Resolved" | "Unavailable" };
  target_excerpt: { kind: "Absent" } | { kind: "Present"; value: string };
  items: Array<{
    id: string;
    kind: string;
    label: string;
    excerpt: { kind: "Absent" } | { kind: "Present"; value: string };
  }>;
  also_references: unknown[];
}

interface SourceTargetFixture {
  stableKey: string;
  resourceId?: string;
  kind: ReaderEvidenceSourceKind;
  label: string;
  body: string | null;
  locator: MediaRetrievalLocator;
  orderKey: string;
}

function sourceReferencePassage({
  stableKey,
  kind,
  label,
  body = null,
  locator,
  orderKey,
  confidence = "exact",
  targets = [],
  resourceId = "11111111-1111-4111-8111-111111111111",
}: {
  stableKey: string;
  kind: ReaderEvidenceSourceKind;
  label: string;
  body?: string | null;
  locator: MediaRetrievalLocator;
  orderKey: string;
  confidence?: ReaderEvidenceConfidence;
  targets?: SourceTargetFixture[];
  resourceId?: string;
}) {
  const resourceRef = `reader_apparatus_item:${resourceId}`;
  const quotedTarget =
    "text_quote_selector" in locator &&
    locator.text_quote_selector?.exact?.trim()
      ? locator.text_quote_selector.exact
      : "exact" in locator &&
          typeof locator.exact === "string" &&
          locator.exact.trim()
        ? locator.exact
        : kind.endsWith("_ref")
          ? label
          : body;
  return {
    locus_ref: resourceRef,
    resolution: {
      kind: "Resolved",
      anchor: {
        locator,
      },
      order_key: orderKey,
    },
    items: [
      {
        id: `source-reference:${stableKey}`,
        kind: "SourceReference",
        label,
        excerpt: body ? { kind: "Present", value: body } : { kind: "Absent" },
        associations: [],
        stable_key: stableKey,
        apparatus_kind: kind,
        confidence,
        targets: targets.map((target) => {
          const targetResourceId =
            target.resourceId ?? "22222222-2222-4222-8222-222222222222";
          const targetRef = `reader_apparatus_item:${targetResourceId}`;
          return {
            ref: targetRef,
            stable_key: target.stableKey,
            apparatus_kind: target.kind,
            label: { kind: "Present", value: target.label },
            body: target.body
              ? { kind: "Present", value: target.body }
              : { kind: "Absent" },
            activation: {
              resource_ref: targetRef,
              kind: "route",
              href: `/media/media-1?apparatus=${target.stableKey}`,
              unresolved_reason: null,
            },
            resolution: {
              kind: "Resolved",
              anchor: {
                locator: target.locator,
              },
              order_key: target.orderKey,
            },
          };
        }),
      },
    ],
    target_excerpt: quotedTarget
      ? { kind: "Present", value: quotedTarget }
      : { kind: "Absent" },
    also_references: [],
  };
}

function pdfHighlightPassage() {
  const itemId = `highlight:${PDF_HIGHLIGHT_ID}`;
  return {
    locus_ref: itemId,
    resolution: {
      kind: "Resolved",
      anchor: {
        locator: {
          type: "pdf_page_geometry",
          media_id: "media-1",
          page_number: 1,
          quads: [
            {
              x1: 70,
              y1: 60,
              x2: 230,
              y2: 60,
              x3: 230,
              y3: 80,
              x4: 70,
              y4: 80,
            },
          ],
          exact: "PDF hover target",
        },
      },
      order_key: "0001.0001",
    },
    target_excerpt: { kind: "Present", value: "PDF hover target" },
    items: [
      {
        id: itemId,
        kind: "Highlight",
        label: "PDF hover target",
        excerpt: { kind: "Present", value: "PDF hover target" },
        associations: [],
        highlight_id: PDF_HIGHLIGHT_ID,
        quote: "PDF hover target",
        prefix: "",
        suffix: "",
        color: "yellow",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        author_user_id: "user-1",
        is_owner: true,
      },
    ],
    also_references: [],
  };
}

function crossSectionSourceReferencePassage() {
  return sourceReferencePassage({
    stableKey: "owner",
    kind: "footnote_ref",
    label: "Owner marker",
    locator: {
      type: "epub_fragment_offsets",
      media_id: "media-1",
      section_id: "section-1",
      fragment_id: "fragment-1",
      start_offset: 0,
      end_offset: 2,
    },
    orderKey: "section:0000:0000000000",
    targets: [
      {
        stableKey: "target",
        kind: "footnote",
        label: "Target note",
        body: "Cross-section evidence.",
        locator: {
          type: "epub_fragment_offsets",
          media_id: "media-1",
          section_id: "section-2",
          fragment_id: "fragment-2",
          start_offset: 0,
          end_offset: 22,
        },
        orderKey: "section:0001:0000000000",
      },
    ],
  });
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

function readerDocumentMapResponse() {
  const embeds = testState.documentMapEmbeds ?? [];
  const passageGroups = (testState.documentMapPassageGroups ??
    []) as DocumentMapPassageGroupFixture[];
  const documentItems = testState.documentMapDocumentItems ?? [];
  const passageItems = passageGroups.flatMap((group) => group.items);
  return {
    media_id: "media-1",
    media_kind: testState.mediaKind,
    title: "Reader fixture",
    status: "ready",
    source_version: {
      media_updated_at: {
        kind: "Present",
        value: "2026-01-01T00:00:00Z",
      },
      apparatus_source_fingerprint: { kind: "Absent" },
      graph_max_updated_at: { kind: "Absent" },
      highlights_max_updated_at: { kind: "Absent" },
    },
    navigation: { kind: "Absent" },
    embeds,
    evidence: {
      counts: {
        highlights: passageItems.filter((item) => item.kind === "Highlight")
          .length,
        citations: passageItems.filter(
          (item) =>
            item.kind === "SourceReference" ||
            item.kind === "GeneratedCitation",
        ).length,
        links: documentItems.filter(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            (item as { kind?: unknown }).kind === "Link",
        ).length,
        synapses: 0,
        passages: passageItems.length,
        document: documentItems.length,
      },
      passage_groups: passageGroups,
      document_items: documentItems,
    },
    markers: [
      {
        id: "contents:section-1",
        item_id: "contents:section-1",
        kind: "Contents",
        position: 0.5,
        tone: "Neutral",
        label: "Section 1",
        preview: { kind: "Absent" },
      },
      ...passageGroups.map((group, index) => ({
        id: group.items[0]!.id,
        item_id: group.items[0]!.id,
        kind: "SourceReference",
        position: (index + 1) / (passageGroups.length + 1),
        tone: group.resolution.kind === "Resolved" ? "Citation" : "Warning",
        label: group.items[0]!.label,
        preview: group.items[0]!.excerpt,
      })),
      ...embeds.map((embed, index) => ({
        id: `embed:${embed.id}`,
        item_id: `embed:${embed.id}`,
        kind: "Embed",
        position: (index + 1) / (embeds.length + 1),
        tone: "Neutral",
        label: embed.display.label,
        preview: { kind: "Present", value: embed.display.description },
      })),
    ],
    diagnostics: {
      omitted_item_counts: {},
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

function readerEvidenceSecondaryPane(): WorkspaceAttachedSecondaryPaneState {
  return {
    ...readerContentsSecondaryPane(),
    activeSurfaceId: "reader-evidence",
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
      getPublishedSecondarySurface(publication, "reader-contents")?.body ??
      null;
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

function noteTargetDocumentItem() {
  const noteBlockId = "33333333-3333-4333-8333-333333333333";
  return {
    id: "link:edge-note",
    kind: "Link",
    label: "Research note",
    excerpt: { kind: "Present", value: "Target note excerpt." },
    associations: [],
    edge_id: "edge-note",
    role: "context",
    origin: "highlight_note",
    object: {
      ref: `note_block:${noteBlockId}`,
      kind: "Note",
      label: "Research note",
      excerpt: { kind: "Present", value: "Target note excerpt." },
      activation: {
        resource_ref: `note_block:${noteBlockId}`,
        kind: "route",
        href: `/notes/${noteBlockId}`,
        unresolved_reason: null,
      },
      note_block_id: noteBlockId,
      body_pm_json: {},
    },
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
    href?: string;
    secondaryPane?: WorkspaceAttachedSecondaryPaneState | null;
    renderSecondarySurfaceId?: WorkspaceSecondarySurfaceId;
  } = {},
) {
  const href = options.href ?? "/media/media-1";
  const identity = resolvePaneRouteIdentity(href);
  const onSetPaneLayout = vi.fn();
  const onNavigatePane = vi.fn();
  const onRequestSecondarySurface = vi.fn();
  const onCloseSecondaryPane = vi.fn();
  const onOpenInNewPane = vi.fn();
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
            onOpenInNewPane={onOpenInNewPane}
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
    onOpenInNewPane,
    onSetPaneSecondary,
    onSetFixedChrome,
    routeKey: identity.routeKey,
  };
}

describe("MediaPaneBody pane sizing", () => {
  beforeEach(() => {
    testState.apiFetch.mockReset();
    testState.includeToc = false;
    testState.includeSecondEpubSection = false;
    testState.isMobileViewport = false;
    testState.fragmentHtml = "<p>Readable text.</p>";
    testState.fragmentCanonicalText = "";
    testState.renderHtmlInMock = false;
    testState.documentMapDocumentItems = null;
    testState.documentMapPassageGroups = null;
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
              ...(testState.includeSecondEpubSection
                ? [
                    {
                      section_id: "section-2",
                      label: "Section 2",
                      ordinal: 1,
                      fragment_id: "fragment-2",
                      fragment_idx: 1,
                      level: 1,
                      depth: 0,
                      start_offset: 0,
                      end_offset: 23,
                      href_path: "chapter-2.xhtml",
                      href_fragment: null,
                      anchor_id: null,
                      char_count: 23,
                    },
                  ]
                : []),
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
        if (path === "/api/media/media-1/sections/section-2") {
          return jsonResponse({
            section_id: "section-2",
            label: "Section 2",
            fragment_id: "fragment-2",
            fragment_idx: 1,
            href_path: "chapter-2.xhtml",
            anchor_id: null,
            source_node_id: null,
            source: "spine",
            ordinal: 1,
            prev_section_id: "section-1",
            next_section_id: null,
            html_sanitized: "<p>Cross-section evidence.</p>",
            canonical_text: "",
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
        if (path === "/api/fragments/fragment-2/highlights") {
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
      const { onSetPaneLayout, onSetFixedChrome, routeKey } = renderMediaPane();

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
    const { onSetPaneLayout, onSetFixedChrome, routeKey } = renderMediaPane();

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

  it("activates a SourceReference target across EPUB sections using the target locator", async () => {
    testState.mediaKind = "epub";
    testState.includeSecondEpubSection = true;
    testState.documentMapPassageGroups = [crossSectionSourceReferencePassage()];
    const pulseHandler = vi.fn();
    window.addEventListener(READER_PULSE_HIGHLIGHT, pulseHandler);
    try {
      renderMediaPane({ renderSecondarySurfaceId: "reader-evidence" });
      await userEvent.click(
        await screen.findByRole("button", { name: "1 linked object" }),
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Target note" }),
      );

      await waitFor(() => {
        expect(
          apiCallsForPath("/api/media/media-1/sections/section-2"),
        ).toHaveLength(1);
        expect(pulseHandler).toHaveBeenCalledTimes(1);
      });
      expect(
        (pulseHandler.mock.calls[0]?.[0] as CustomEvent).detail,
      ).toMatchObject({
        mediaId: "media-1",
        locator: {
          type: "epub_fragment_offsets",
          section_id: "section-2",
          fragment_id: "fragment-2",
        },
      });
    } finally {
      window.removeEventListener(READER_PULSE_HIGHLIGHT, pulseHandler);
    }
  });

  it("opens a Shift-clicked SourceReference target in a new pane", async () => {
    testState.mediaKind = "epub";
    testState.includeSecondEpubSection = true;
    testState.documentMapPassageGroups = [crossSectionSourceReferencePassage()];
    const { onOpenInNewPane } = renderMediaPane({
      renderSecondarySurfaceId: "reader-evidence",
    });

    await userEvent.click(
      await screen.findByRole("button", { name: "1 linked object" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Target note" }), {
      shiftKey: true,
    });

    expect(onOpenInNewPane).toHaveBeenCalledWith(
      "/media/media-1?apparatus=target",
      "Target note",
      undefined,
    );
    expect(
      apiCallsForPath("/api/media/media-1/sections/section-2"),
    ).toHaveLength(0);
  });

  it("honors an apparatus target URL with the target locator, not its owner locator", async () => {
    testState.mediaKind = "epub";
    testState.includeSecondEpubSection = true;
    testState.documentMapPassageGroups = [crossSectionSourceReferencePassage()];
    const pulseHandler = vi.fn();
    window.addEventListener(READER_PULSE_HIGHLIGHT, pulseHandler);
    try {
      renderMediaPane({
        href: "/media/media-1?apparatus=target",
        renderSecondarySurfaceId: "reader-evidence",
      });

      await waitFor(() => {
        expect(
          apiCallsForPath("/api/media/media-1/sections/section-2"),
        ).toHaveLength(1);
        expect(pulseHandler).toHaveBeenCalledTimes(1);
      });
      expect(
        (pulseHandler.mock.calls[0]?.[0] as CustomEvent).detail,
      ).toMatchObject({
        locator: {
          type: "epub_fragment_offsets",
          section_id: "section-2",
          fragment_id: "fragment-2",
        },
      });
    } finally {
      window.removeEventListener(READER_PULSE_HIGHLIGHT, pulseHandler);
    }
  });

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
        id: "embed-1",
        media_id: "media-1",
        fragment_id: "fragment-1",
        ordinal: 0,
        occurrence_key: "embed:000000:youtube:dQw4w9WgXcQ",
        provider: "youtube",
        kind: "video",
        source_url: {
          status: "present",
          value: "https://youtu.be/dQw4w9WgXcQ",
        },
        canonical_url: {
          status: "present",
          value: "https://youtu.be/dQw4w9WgXcQ",
        },
        locator: { canonical_start_offset: 8, canonical_end_offset: 36 },
        display: {
          mode: "resolved",
          label: "Embedded video: Launch video",
          description: "Launch video",
          actions: [],
        },
        target: {
          status: "exact",
          media_id: "child-1",
          kind: "video",
          title: "Launch video",
          thumbnail_url: null,
          playback: null,
        },
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
    expect(publication?.surfaces.map((s) => s.id)).not.toContain(
      "reader-resource-chat",
    );
  });

  it("publishes Citations and previews a source-authored marker", async () => {
    testState.mediaKind = "web_article";
    testState.renderHtmlInMock = true;
    testState.fragmentHtml =
      '<p>Claim<a href="#fn1" data-reader-apparatus-item-id="marker-1">1</a></p>' +
      '<aside id="fn1" data-reader-apparatus-item-id="target-1">Document footnote text.</aside>';
    testState.fragmentCanonicalText = "Claim1\nDocument footnote text.";
    testState.documentMapPassageGroups = [
      sourceReferencePassage({
        stableKey: "marker-1",
        kind: "footnote_ref",
        label: "1",
        locator: {
          type: "web_text_offsets",
          media_id: "media-1",
          fragment_id: "fragment-1",
          start_offset: 5,
          end_offset: 6,
        },
        orderKey: "fragment:0000000000:0000000005",
        targets: [
          {
            stableKey: "target-1",
            kind: "footnote",
            label: "1",
            body: "Preview note body.",
            locator: {
              type: "web_text_offsets",
              media_id: "media-1",
              fragment_id: "fragment-1",
              start_offset: 7,
              end_offset: 30,
            },
            orderKey: "fragment:0000000000:0000000007",
          },
        ],
      }),
    ];
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

  it("publishes Citations for target-only margin notes without hover previews", async () => {
    testState.mediaKind = "web_article";
    testState.isMobileViewport = true;
    testState.renderHtmlInMock = true;
    testState.fragmentHtml =
      '<p>Claim<span data-reader-apparatus-item-id="margin-1">Standalone margin note body.</span></p>';
    testState.fragmentCanonicalText = "ClaimStandalone margin note body.";
    testState.documentMapPassageGroups = [
      sourceReferencePassage({
        stableKey: "margin-1",
        kind: "margin_note",
        label: "Margin note 1",
        body: "Standalone margin note body.",
        confidence: "strong",
        locator: {
          type: "web_text_offsets",
          media_id: "media-1",
          fragment_id: "fragment-1",
          start_offset: 5,
          end_offset: 33,
        },
        orderKey: "fragment:0000000000:0000000005",
      }),
    ];
    const { onRequestSecondarySurface, onSetPaneSecondary } = renderMediaPane({
      renderSecondarySurfaceId: "reader-evidence",
    });

    const marginNoteButton = await screen.findByRole("button", {
      name: "Jump to Standalone margin note body.",
    });
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
    expect(onRequestSecondarySurface).toHaveBeenCalledTimes(1);
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

  it("mirrors transient PDF highlight hover and focus into Evidence without activating the row", async () => {
    testState.mediaKind = "pdf";
    testState.documentMapPassageGroups = [pdfHighlightPassage()];
    renderMediaPane({ renderSecondarySurfaceId: "reader-evidence" });

    expect(await screen.findAllByText("PDF hover target")).not.toHaveLength(0);
    const evidenceRow = screen.getByRole("article");
    expect(evidenceRow).not.toHaveAttribute("data-active");

    const pdfReader = screen.getByTestId("pdf-reader");
    fireEvent.pointerEnter(pdfReader);
    await waitFor(() =>
      expect(evidenceRow).toHaveAttribute("data-hovered", "true"),
    );
    expect(evidenceRow).not.toHaveAttribute("data-active");

    fireEvent.pointerLeave(pdfReader);
    await waitFor(() =>
      expect(evidenceRow).not.toHaveAttribute("data-hovered"),
    );

    await userEvent.tab();
    await waitFor(() =>
      expect(evidenceRow).toHaveAttribute("data-hovered", "true"),
    );
    expect(pdfReader).toHaveFocus();
    expect(evidenceRow).not.toHaveAttribute("data-active");

    await userEvent.tab();
    await waitFor(() =>
      expect(evidenceRow).not.toHaveAttribute("data-hovered"),
    );
  });

  it("dispatches a PDF reader pulse when a native-link reference row is activated", async () => {
    testState.isMobileViewport = true;
    testState.mediaKind = "pdf";
    testState.documentMapPassageGroups = [
      sourceReferencePassage({
        stableKey: "pdf-marker-13",
        kind: "bibliography_ref",
        label: "[13]",
        locator: {
          type: "pdf_page_geometry",
          media_id: "media-1",
          page_number: 2,
          quads: [
            { x1: 10, y1: 20, x2: 20, y2: 20, x3: 20, y3: 30, x4: 10, y4: 30 },
          ],
          exact: "[13]",
          text_quote_selector: { exact: "[13]" },
        },
        orderKey: "0002.0001.marker",
        targets: [
          {
            stableKey: "pdf-target-13",
            kind: "bibliography_entry",
            label: "[13]",
            body: "[13] Long short-term memory. Neural computation.",
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
            orderKey: "0011.000200.000.0013.target",
          },
        ],
      }),
    ];
    const pulseHandler = vi.fn();
    window.addEventListener(READER_PULSE_HIGHLIGHT, pulseHandler);
    try {
      const { onCloseSecondaryPane } = renderMediaPane({
        secondaryPane: readerEvidenceSecondaryPane(),
        renderSecondarySurfaceId: "reader-evidence",
      });

      const refButton = await screen.findByRole("button", {
        name: "Jump to [13]",
      });
      fireEvent.click(refButton);

      await waitFor(() => {
        expect(pulseHandler).toHaveBeenCalledTimes(1);
      });
      expect(onCloseSecondaryPane).toHaveBeenCalledWith("secondary-1");
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
      pulseHandler.mockClear();
      onCloseSecondaryPane.mockClear();
      await userEvent.click(
        screen.getByRole("button", { name: "1 linked object" }),
      );
      await userEvent.click(screen.getByRole("button", { name: "[13]" }));
      await waitFor(() => expect(pulseHandler).toHaveBeenCalledTimes(1));
      expect(onCloseSecondaryPane).toHaveBeenCalledWith("secondary-1");
      expect(
        (pulseHandler.mock.calls[0]?.[0] as CustomEvent).detail,
      ).toMatchObject({
        snippet: "[13] Long short-term memory. Neural computation.",
        locator: {
          type: "pdf_page_geometry",
          media_id: "media-1",
          page_number: 11,
          exact: "[13] Long short-term memory. Neural computation.",
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

  it("keeps the mobile Evidence sheet open when a passage cannot activate", async () => {
    testState.isMobileViewport = true;
    testState.mediaKind = "web_article";
    testState.documentMapPassageGroups = [
      sourceReferencePassage({
        stableKey: "missing-fragment-reference",
        kind: "footnote_ref",
        label: "Missing passage",
        locator: {
          type: "web_text_offsets",
          media_id: "media-1",
          fragment_id: "missing-fragment",
          start_offset: 0,
          end_offset: 7,
        },
        orderKey: "fragment:9999999999:0000000000",
      }),
    ];
    const { onCloseSecondaryPane } = renderMediaPane({
      secondaryPane: readerEvidenceSecondaryPane(),
      renderSecondarySurfaceId: "reader-evidence",
    });

    await userEvent.click(
      await screen.findByRole("button", { name: "Jump to Missing passage" }),
    );

    expect(onCloseSecondaryPane).not.toHaveBeenCalled();
  });

  it("does not route around a failed same-pane source-target activation", async () => {
    testState.isMobileViewport = true;
    testState.mediaKind = "web_article";
    testState.documentMapPassageGroups = [
      sourceReferencePassage({
        stableKey: "current-reference",
        kind: "footnote_ref",
        label: "1",
        locator: {
          type: "web_text_offsets",
          media_id: "media-1",
          fragment_id: "fragment-1",
          start_offset: 0,
          end_offset: 1,
        },
        orderKey: "fragment:0000000000:0000000000",
        targets: [
          {
            stableKey: "stale-target",
            kind: "footnote",
            label: "Stale target",
            body: "Old note body.",
            locator: {
              type: "web_text_offsets",
              media_id: "media-1",
              fragment_id: "missing-fragment",
              start_offset: 0,
              end_offset: 8,
            },
            orderKey: "fragment:9999999999:0000000000",
          },
        ],
      }),
    ];
    const { onCloseSecondaryPane, onNavigatePane } = renderMediaPane({
      secondaryPane: readerEvidenceSecondaryPane(),
      renderSecondarySurfaceId: "reader-evidence",
    });

    await userEvent.click(
      await screen.findByRole("button", { name: "1 linked object" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Stale target" }));

    expect(onCloseSecondaryPane).not.toHaveBeenCalled();
    expect(onNavigatePane).not.toHaveBeenCalled();
  });

  it("activates a whole-document note link through its canonical route", async () => {
    testState.mediaKind = "web_article";
    testState.includeToc = true;
    testState.documentMapDocumentItems = [noteTargetDocumentItem()];
    const { onNavigatePane } = renderMediaPane({
      renderSecondarySurfaceId: "reader-evidence",
    });

    await userEvent.click(
      await screen.findByRole("tab", { name: /Whole document 1/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Open Research note" }),
    );

    expect(onNavigatePane).toHaveBeenCalledWith(
      "pane-1",
      "/notes/33333333-3333-4333-8333-333333333333",
      undefined,
    );
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
    const optionIds = latestChromeOverrides()?.options?.map(
      (option) => option.id,
    );

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
      expect(
        publication?.surfaces.some(
          (surface) => surface.id === "reader-evidence",
        ),
      ).toBe(true);
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
      const contentsButton = screen.getByRole("button", {
        name: "Document Map",
      });
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
      const contentsButton = screen.getByRole("button", {
        name: "Document Map",
      });
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
    expect(
      latestChromeOverrides()?.options?.map((option) => option.id),
    ).not.toContain("reader-pdf-source-colors");

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
    render(
      <>
        {statusRow.render?.({
          closeMenu: () => {},
          closeMenuWithoutFocus: () => {},
          triggerEl: null,
        })}
      </>,
    );
    expect(
      screen.getByText("PDF pages keep their source colors"),
    ).toBeInTheDocument();

    const optionIds = latestChromeOverrides()?.options?.map(
      (option) => option.id,
    );
    expect(optionIds).not.toContain("reader-theme-light");
    expect(optionIds).not.toContain("reader-theme-dark");
  });
});
