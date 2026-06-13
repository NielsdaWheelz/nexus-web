import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LibraryIntelligencePane from "@/app/(authenticated)/libraries/[id]/LibraryIntelligencePane";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import type { LiStreamEvent } from "@/lib/api/sse/libraryIntelligenceEvents";
import {
  NOTE_PULSE_HIGHLIGHT,
  READER_PULSE_HIGHLIGHT,
  type NotePulseTarget,
  type ReaderPulseTarget,
} from "@/lib/reader/pulseEvent";

// Mock only the true external streaming boundaries (the BFF stream-token fetch
// and the direct SSE client); the pane runs the real useLibraryIntelligenceStream
// hook so generate→subscribe, the constructed SSE URL, and done→reload are
// exercised end to end. fetch (apiFetch/useResource) is stubbed at the boundary.
const streamMocks = vi.hoisted(() => ({
  fetchStreamToken: vi.fn(),
  sseClientDirect: vi.fn(() => vi.fn()),
}));

vi.mock("@/lib/api/streamToken", () => ({
  fetchStreamToken: streamMocks.fetchStreamToken,
}));

vi.mock("@/lib/api/sse-client", () => ({
  sseClientDirect: streamMocks.sseClientDirect,
}));

const LIBRARY_ID = "lib-1";
const ARTIFACT_ID = "artifact-1";
const REVISION_ID = "rev-1";
const REVISION_REF = `library_intelligence_revision:${REVISION_ID}`;
const MEDIA_ID = "media-1";

interface SseOptions {
  url: string;
  onEvent: (event: LiStreamEvent) => void;
}

function lastSseOptions(): SseOptions {
  const calls = streamMocks.sseClientDirect.mock.calls as unknown as Array<
    [SseOptions]
  >;
  const options = calls.at(-1)?.[0];
  if (!options) throw new Error("sseClientDirect was not called");
  return options;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function pathOf(input: RequestInfo | URL): string {
  if (input instanceof Request) {
    return new URL(input.url).pathname;
  }
  return new URL(String(input), "http://localhost").pathname;
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  if (input instanceof Request) return input.method;
  return init?.method ?? "GET";
}

function headerOf(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  name: string,
): string | null {
  if (input instanceof Request) return input.headers.get(name);
  return new Headers(init?.headers).get(name);
}

const CITATION = {
  ordinal: 1,
  role: "context",
  target_ref: { type: "content_chunk", id: "chunk-1" },
  media_id: MEDIA_ID,
  locator: {
    type: "web_text_offsets",
    media_id: MEDIA_ID,
    fragment_id: "fragment-1",
    start_offset: 0,
    end_offset: 10,
  },
  deep_link: `/media/${MEDIA_ID}#fragment-fragment-1`,
  snapshot: { title: "Source title", excerpt: "the cited words" },
};

const NOTE_CITATION = {
  ordinal: 1,
  role: "context",
  target_ref: { type: "evidence_span", id: "span-1" },
  media_id: null,
  locator: {
    type: "note_block_offsets",
    page_id: "page-1",
    block_id: "block-1",
    start_offset: 0,
    end_offset: 10,
  },
  deep_link: null,
  snapshot: { title: "Notebook", excerpt: "the noted words" },
};

 function artifact(
  overrides: Partial<{
    artifact_id: string | null;
    artifact_ref: string | null;
    revision_id: string | null;
    revision_ref: string | null;
    status: string;
    content_md: string;
    citations: unknown[];
    stale_source_count: number | null;
    build: { revision_id: string; status: string } | null;
  }> = {},
) {
  return {
    artifact_id: ARTIFACT_ID,
    artifact_ref: `library_intelligence_artifact:${ARTIFACT_ID}`,
    revision_id: REVISION_ID,
    revision_ref: REVISION_REF,
    status: "current",
    content_md: "Synthesis prose [1].",
    citations: [CITATION],
    stale_source_count: null,
    build: null,
    ...overrides,
  };
}

let getCalls: number;

function revision(
  overrides: Partial<{
    artifact_id: string;
    artifact_ref: string;
    revision_id: string;
    revision_ref: string;
    status: string;
    content_md: string;
    citations: unknown[];
    created_at: string;
    promoted_at: string | null;
    is_current: boolean;
  }> = {},
) {
  return {
    artifact_id: ARTIFACT_ID,
    artifact_ref: `library_intelligence_artifact:${ARTIFACT_ID}`,
    revision_id: "rev-2",
    revision_ref: "library_intelligence_revision:rev-2",
    status: "ready",
    content_md: "Historical synthesis [1].",
    citations: [CITATION],
    created_at: "2026-01-02T03:04:05Z",
    promoted_at: "2026-01-02T03:04:05Z",
    is_current: false,
    ...overrides,
  };
}

function stubFetch(
  artifactBody: ReturnType<typeof artifact>,
  revisionBody?: ReturnType<typeof revision>,
) {
  getCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      const method = methodOf(input, init);
      if (path === `/api/libraries/${LIBRARY_ID}/intelligence`) {
        getCalls += 1;
        return jsonResponse({ data: artifactBody });
      }
      if (
        revisionBody &&
        path ===
          `/api/libraries/${LIBRARY_ID}/intelligence/revisions/${revisionBody.revision_id}`
      ) {
        return jsonResponse({ data: revisionBody });
      }
      if (
        path === `/api/libraries/${LIBRARY_ID}/intelligence/generate` &&
        method === "POST"
      ) {
        // idempotency_key now travels as an Idempotency-Key header, not a body
        // field — regression-lock the header convention.
        expect(headerOf(input, init, "Idempotency-Key")).toMatch(/^li-gen/);
        expect(init?.body ?? null).toBeNull();
        return jsonResponse({
          data: {
            artifact_id: ARTIFACT_ID,
            revision_id: REVISION_ID,
          },
        });
      }
      throw new Error(`Unexpected fetch call: ${method} ${path}`);
    }),
  );
}

function renderPane(onOpenChat = vi.fn()) {
  return renderPaneAt(`/libraries/${LIBRARY_ID}`, onOpenChat);
}

function renderPaneAt(href: string, onOpenChat = vi.fn()) {
  const identity = resolvePaneRouteIdentity(href);
  const onNavigatePane = vi.fn();
  const onOpenInNewPane = vi.fn();
  render(
    <PaneRuntimeProvider
      paneId="pane-library"
      href={href}
      routeId={identity.routeId}
      resourceRef={identity.resourceRef}
      resourceKey={identity.resourceKey}
      pathParams={{ id: LIBRARY_ID }}
      canGoBack={false}
      canGoForward={false}
      onNavigatePane={onNavigatePane}
      onReplacePane={vi.fn()}
      onOpenInNewPane={onOpenInNewPane}
      onGoBackPane={vi.fn()}
      onGoForwardPane={vi.fn()}
    >
      <LibraryIntelligencePane libraryId={LIBRARY_ID} onOpenChat={onOpenChat} />
    </PaneRuntimeProvider>,
  );
  return { onNavigatePane, onOpenChat, onOpenInNewPane };
}

describe("LibraryIntelligencePane", () => {
  beforeEach(() => {
    streamMocks.fetchStreamToken.mockReset();
    streamMocks.fetchStreamToken.mockResolvedValue({
      token: "stream-token-1",
      stream_base_url: "https://stream.example.test",
    });
    streamMocks.sseClientDirect.mockReset();
    streamMocks.sseClientDirect.mockReturnValue(vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the Current status and renders the synthesis prose", async () => {
    stubFetch(artifact({ status: "current" }));
    renderPane();
    expect(await screen.findByText("Current")).toBeVisible();
    expect(await screen.findByText(/Synthesis prose/)).toBeVisible();
  });

  it("shows the stale source count and a Regenerate button when stale", async () => {
    stubFetch(artifact({ status: "stale", stale_source_count: 3 }));
    renderPane();
    expect(await screen.findByText("Stale — 3 sources changed")).toBeVisible();
    expect(
      await screen.findByRole("button", { name: "Regenerate" }),
    ).toBeVisible();
  });

  it("singularizes the stale source count for one source", async () => {
    stubFetch(artifact({ status: "stale", stale_source_count: 1 }));
    renderPane();
    expect(await screen.findByText("Stale — 1 source changed")).toBeVisible();
  });

  it("shows the empty state and no prose when unavailable", async () => {
    stubFetch(
      artifact({
        status: "unavailable",
        artifact_id: null,
        artifact_ref: null,
        revision_id: null,
        revision_ref: null,
        content_md: "",
        citations: [],
      }),
    );
    renderPane();
    expect(
      await screen.findByText("No intelligence has been generated yet."),
    ).toBeVisible();
    expect(
      await screen.findByRole("button", { name: "Generate" }),
    ).toBeVisible();
  });

  it("shows a Retry button and an alert when failed", async () => {
    stubFetch(artifact({ status: "failed", content_md: "" }));
    renderPane();
    expect(await screen.findByRole("alert")).toHaveTextContent("Failed");
    expect(await screen.findByRole("button", { name: "Retry" })).toBeVisible();
  });

  it("renders a citation that dispatches a reader pulse when clicked", async () => {
    const user = userEvent.setup();
    const pulses: ReaderPulseTarget[] = [];
    const listener = (event: Event) => {
      if (event instanceof CustomEvent) {
        pulses.push(event.detail as ReaderPulseTarget);
      }
    };
    window.addEventListener(READER_PULSE_HIGHLIGHT, listener);
    try {
      stubFetch(artifact({ status: "current" }));
      renderPane();
      const citation = await screen.findByRole("link", {
        name: "Open citation 1",
      });
      await user.click(citation);
      await waitFor(() => expect(pulses).toHaveLength(1));
      expect(pulses[0]?.mediaId).toBe(MEDIA_ID);
    } finally {
      window.removeEventListener(READER_PULSE_HIGHLIGHT, listener);
    }
  });

  it("opens note citations and dispatches a pending-compatible note pulse", async () => {
    const user = userEvent.setup();
    const pulses: NotePulseTarget[] = [];
    const listener = (event: Event) => {
      if (event instanceof CustomEvent) {
        pulses.push(event.detail as NotePulseTarget);
      }
    };
    window.addEventListener(NOTE_PULSE_HIGHLIGHT, listener);
    try {
      stubFetch(artifact({ status: "current", citations: [NOTE_CITATION] }));
      const { onNavigatePane } = renderPane();
      const citation = await screen.findByRole("link", {
        name: "Open citation 1",
      });
      await user.click(citation);
      await waitFor(() => expect(pulses).toHaveLength(1));
      expect(pulses[0]).toMatchObject({
        pageId: "page-1",
        blockId: "block-1",
        startOffset: 0,
        endOffset: 10,
      });
      expect(onNavigatePane).toHaveBeenCalledWith(
        "pane-library",
        "/notes/block-1",
        undefined,
      );
    } finally {
      window.removeEventListener(NOTE_PULSE_HIGHLIGHT, listener);
    }
  });

  it("triggers the stream generate without firing repeated GETs on a timer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      stubFetch(
        artifact({
          status: "unavailable",
          artifact_id: null,
          artifact_ref: null,
          revision_id: null,
          revision_ref: null,
          content_md: "",
          citations: [],
        }),
      );
      const user = userEvent.setup();
      renderPane();
      const generateButton = await screen.findByRole("button", {
        name: "Generate",
      });
      const initialCalls = getCalls;
      await user.click(generateButton);
      // The real generate POST → subscribe chain opens exactly one SSE stream.
      await waitFor(() =>
        expect(streamMocks.sseClientDirect).toHaveBeenCalledTimes(1),
      );
      // Advance well past any plausible polling interval: a polling loop would
      // re-fetch the intelligence endpoint; the one-shot reloadNonce does not.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getCalls).toBe(initialCalls);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps current content visible while building and subscribes to the draft revision", async () => {
    stubFetch(
      artifact({
        status: "building",
        content_md: "Existing prose [1].",
        build: { revision_id: "draft-rev", status: "building" },
      }),
    );
    renderPane();
    // Current content stays rendered while a draft builds.
    expect(await screen.findByText(/Existing prose/)).toBeVisible();
    expect(await screen.findByText("Generating…")).toBeVisible();
    // The real subscribe path builds the SSE URL the FastAPI route expects;
    // assert the `/stream/library-intelligence/` segment to regression-lock it.
    await waitFor(() =>
      expect(streamMocks.sseClientDirect).toHaveBeenCalledTimes(1),
    );
    expect(lastSseOptions().url).toBe(
      "https://stream.example.test/stream/library-intelligence/draft-rev/events",
    );
  });

  it("refetches exactly once after a terminal done event", async () => {
    stubFetch(
      artifact({
        status: "unavailable",
        artifact_id: null,
        artifact_ref: null,
        revision_id: null,
        revision_ref: null,
        content_md: "",
        citations: [],
      }),
    );
    const user = userEvent.setup();
    renderPane();
    const generateButton = await screen.findByRole("button", {
      name: "Generate",
    });
    await user.click(generateButton);
    await waitFor(() =>
      expect(streamMocks.sseClientDirect).toHaveBeenCalledTimes(1),
    );
    const callsBeforeDone = getCalls;
    // Drive the real onDone → reloadNonce → single refetch through the captured
    // SSE client options, exactly as the live stream would.
    lastSseOptions().onEvent({
      type: "done",
      data: { status: "ready", error_code: null, revision_id: REVISION_ID },
    });
    await waitFor(() => expect(getCalls).toBe(callsBeforeDone + 1));
  });

  it("shows a Generation failed alert on a failed done event", async () => {
    stubFetch(
      artifact({
        status: "unavailable",
        artifact_id: null,
        artifact_ref: null,
        revision_id: null,
        revision_ref: null,
        content_md: "",
        citations: [],
      }),
    );
    const user = userEvent.setup();
    renderPane();
    const generateButton = await screen.findByRole("button", {
      name: "Generate",
    });
    await user.click(generateButton);
    await waitFor(() =>
      expect(streamMocks.sseClientDirect).toHaveBeenCalledTimes(1),
    );
    // A failed terminal event must surface the in-band notice, independent of
    // the follow-on artifact GET.
    lastSseOptions().onEvent({
      type: "done",
      data: { status: "failed", error_code: "E_INTERNAL", revision_id: REVISION_ID },
    });
    expect(await screen.findByText("Generation failed")).toBeVisible();
  });

  it("enables the Chat button only with a revision ref and calls onOpenChat", async () => {
    const user = userEvent.setup();
    stubFetch(artifact({ status: "current" }));
    const { onOpenChat } = renderPane();
    const chatButton = await screen.findByRole("button", { name: "Chat" });
    expect(chatButton).toBeEnabled();
    await user.click(chatButton);
    expect(onOpenChat).toHaveBeenCalledWith(REVISION_REF);
  });

  it("uses a selected historical revision body and revision ref", async () => {
    const user = userEvent.setup();
    const selectedRevision = revision();
    stubFetch(artifact({ status: "current" }), selectedRevision);
    const { onOpenChat } = renderPaneAt(
      `/libraries/${LIBRARY_ID}?tab=intelligence&revision=${selectedRevision.revision_id}`,
    );

    expect(await screen.findByText(/Historical synthesis/)).toBeVisible();
    expect(screen.queryByText("Current")).toBeNull();
    await user.click(await screen.findByRole("button", { name: "Chat" }));
    expect(onOpenChat).toHaveBeenCalledWith(selectedRevision.revision_ref);
  });

  it("disables the Chat button when there is no revision ref", async () => {
    stubFetch(
      artifact({
        status: "unavailable",
        artifact_id: null,
        artifact_ref: null,
        revision_id: null,
        revision_ref: null,
        content_md: "",
        citations: [],
      }),
    );
    renderPane();
    expect(await screen.findByRole("button", { name: "Chat" })).toBeDisabled();
  });
});
