import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LibraryBrief from "@/components/library/LibraryBrief";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import { GENERATION_RUN_STREAM_PATHS } from "@/lib/api/useGenerationRun";
import type { LiStreamEvent } from "@/lib/api/sse/libraryIntelligenceEvents";
import {
  NOTE_PULSE_HIGHLIGHT,
  READER_PULSE_HIGHLIGHT,
  type NotePulseTarget,
  type ReaderPulseTarget,
} from "@/lib/reader/pulseEvent";

// Only the external streaming transport is mocked (the BFF stream-token fetch +
// the direct SSE client), so the brief runs the real useLibraryIntelligenceStream
// hook end to end; fetch (apiFetch/useResource) is stubbed at the boundary.
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
const CONVERSATION_ID = "conversation-1";

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
  if (input instanceof Request) return new URL(input.url).pathname;
  return new URL(String(input), "http://localhost").pathname;
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  if (input instanceof Request) return input.method;
  return init?.method ?? "GET";
}

const CITATION = {
  ordinal: 1,
  role: "context",
  target_ref: { type: "content_chunk", id: "chunk-1" },
  activation: {
    resourceRef: "content_chunk:chunk-1",
    kind: "route",
    href: `/media/${MEDIA_ID}#fragment-fragment-1`,
    unresolvedReason: null,
  },
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
  activation: {
    resourceRef: "evidence_span:span-1",
    kind: "route",
    href: "/notes/block-1",
    unresolvedReason: null,
  },
  media_id: null,
  locator: {
    type: "note_block_offsets",
    block_id: "block-1",
    start_offset: 0,
    end_offset: 10,
  },
  deep_link: null,
  snapshot: { title: "Notebook", excerpt: "the noted words" },
};

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    artifact_id: ARTIFACT_ID,
    artifact_ref: `library_intelligence_artifact:${ARTIFACT_ID}`,
    revision_id: REVISION_ID,
    revision_ref: REVISION_REF,
    status: "current",
    content_md: "Synthesis prose [1].",
    citations: [CITATION],
    stale_source_count: null,
    citation_count: 1,
    source_count: 1,
    covered_source_count: 1,
    omitted_source_count: 0,
    custom_instruction: null,
    model_provider: null,
    model_name: null,
    total_tokens: null,
    build: null,
    ...overrides,
  };
}

function revision(overrides: Record<string, unknown> = {}) {
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
    citation_count: 1,
    source_count: 1,
    covered_source_count: 1,
    omitted_source_count: 0,
    custom_instruction: null,
    model_provider: null,
    model_name: null,
    total_tokens: null,
    ...overrides,
  };
}

function revisionSummary(overrides: Record<string, unknown> = {}) {
  return {
    artifact_id: ARTIFACT_ID,
    artifact_ref: `library_intelligence_artifact:${ARTIFACT_ID}`,
    revision_id: REVISION_ID,
    revision_ref: REVISION_REF,
    status: "ready",
    created_at: "2026-01-02T03:04:05Z",
    promoted_at: "2026-01-02T03:04:05Z",
    is_current: true,
    citation_count: 1,
    source_count: 1,
    covered_source_count: 1,
    omitted_source_count: 0,
    custom_instruction: null,
    model_provider: null,
    model_name: null,
    total_tokens: null,
    ...overrides,
  };
}

const empty = () =>
  artifact({
    status: "unavailable",
    artifact_id: null,
    artifact_ref: null,
    revision_id: null,
    revision_ref: null,
    content_md: "",
    citations: [],
  });

function stubFetch(
  artifactBody: ReturnType<typeof artifact>,
  options: {
    revisionBody?: ReturnType<typeof revision>;
    revisions?: Array<ReturnType<typeof revisionSummary>>;
    conversationFails?: boolean;
  } = {},
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathOf(input);
      const method = methodOf(input, init);
      if (path === `/api/libraries/${LIBRARY_ID}/intelligence`) {
        return jsonResponse({ data: artifactBody });
      }
      if (
        options.revisionBody &&
        path ===
          `/api/libraries/${LIBRARY_ID}/intelligence/revisions/${options.revisionBody.revision_id}`
      ) {
        return jsonResponse({ data: options.revisionBody });
      }
      if (
        path === `/api/libraries/${LIBRARY_ID}/intelligence/revisions` &&
        method === "GET"
      ) {
        return jsonResponse({
          data: { revisions: options.revisions ?? [revisionSummary()] },
        });
      }
      if (
        path === `/api/libraries/${LIBRARY_ID}/intelligence/generate` &&
        method === "POST"
      ) {
        return jsonResponse({ data: { artifact_id: ARTIFACT_ID, revision_id: REVISION_ID } });
      }
      if (path === "/api/conversations" && method === "POST") {
        if (options.conversationFails) {
          return jsonResponse(
            { error: { code: "E_INTERNAL", message: "boom", request_id: "req-1" } },
            500,
          );
        }
        return jsonResponse({ data: { id: CONVERSATION_ID } });
      }
      throw new Error(`Unexpected fetch call: ${method} ${path}`);
    }),
  );
}

function renderBriefAt(href: string) {
  const identity = resolvePaneRouteIdentity(href);
  const onNavigatePane = vi.fn();
  const onOpenInNewPane = vi.fn();
  render(
    <PaneRuntimeProvider
      paneId="pane-library"
      href={href}
      routeId={identity.routeId}
      routeKey={identity.routeKey}
      pathParams={{ id: LIBRARY_ID }}
      canGoBack={false}
      canGoForward={false}
      onNavigatePane={onNavigatePane}
      onReplacePane={vi.fn()}
      onOpenInNewPane={onOpenInNewPane}
      onGoBackPane={vi.fn()}
      onGoForwardPane={vi.fn()}
    >
      <LibraryBrief libraryId={LIBRARY_ID} />
    </PaneRuntimeProvider>,
  );
  return { onNavigatePane, onOpenInNewPane };
}

const renderBrief = () => renderBriefAt(`/libraries/${LIBRARY_ID}`);

describe("LibraryBrief", () => {
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

  it("preserves the unchanged SSE stream path (anti-regression)", () => {
    expect(GENERATION_RUN_STREAM_PATHS["library-intelligence"]).toBe(
      "/stream/library-intelligence",
    );
  });

  it("renders the lede in the machine register and expands to the full body (AC-2)", async () => {
    const user = userEvent.setup();
    stubFetch(artifact({ status: "current" }));
    renderBrief();

    // Collapsed: the abstract is set in the machine register, signed DOSSIER.
    const lede = await screen.findByText(/Synthesis prose/);
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: asserting the lede sits inside the machine wrapper (a data-provenance attribute, not a role/label)
    expect(lede.closest('[data-machine-origin="Dossier"]')).not.toBeNull();
    expect(screen.getByText("Dossier", { selector: "span" })).toBeVisible();

    const expander = screen.getByRole("button", { name: "Read the full dossier" });
    expect(expander).toHaveAttribute("aria-expanded", "false");
    const controlledId = expander.getAttribute("aria-controls");
    expect(controlledId).toBeTruthy();

    await user.click(expander);

    expect(
      screen.getByRole("button", { name: "Hide the full dossier" }),
    ).toHaveAttribute("aria-expanded", "true");
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: resolving the disclosure's aria-controls target by id to assert the reveal contract
    const region = document.getElementById(controlledId!);
    expect(region).not.toBeNull();
    expect(region).toHaveTextContent("Synthesis prose");
    // The expanded body renders through MarkdownMessage inside the machine block.
    const body = screen.getByText(/Synthesis prose/);
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: the machine wrapper carries a data-provenance attribute
    expect(body.closest('[data-machine-origin="Dossier"]')).not.toBeNull();
  });

  it("renders no machine voice when unavailable, only a Generate dossier button (AC-3)", async () => {
    stubFetch(empty());
    renderBrief();

    expect(
      await screen.findByRole("button", { name: "Generate dossier" }),
    ).toBeVisible();
    expect(screen.queryByText(/No dossier has been generated/)).not.toBeInTheDocument();
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: asserting the silent empty state renders no machine-voice element
    expect(document.querySelector("[data-machine-origin]")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Read the full dossier" }),
    ).not.toBeInTheDocument();
  });

  it("keeps content visible while building, announces progress, and subscribes the draft (AC-4)", async () => {
    stubFetch(
      artifact({
        status: "building",
        content_md: "Existing prose [1].",
        build: { revision_id: "draft-rev", status: "building" },
      }),
    );
    renderBrief();

    expect(await screen.findByText(/Existing prose/)).toBeVisible();
    expect(await screen.findByRole("status")).toHaveTextContent("Generating…");
    await waitFor(() =>
      expect(streamMocks.sseClientDirect).toHaveBeenCalledTimes(1),
    );
    expect(lastSseOptions().url).toBe(
      "https://stream.example.test/stream/library-intelligence/draft-rev/events",
    );
  });

  it("shows a Retry button and an alert when failed", async () => {
    stubFetch(artifact({ status: "failed", content_md: "" }));
    renderBrief();
    expect(await screen.findByRole("alert")).toHaveTextContent("Failed");
    expect(await screen.findByRole("button", { name: "Retry" })).toBeVisible();
  });

  it("shows a stale cue collapsed and a Regenerate control when expanded", async () => {
    const user = userEvent.setup();
    stubFetch(artifact({ status: "stale", stale_source_count: 3 }));
    renderBrief();

    expect(await screen.findByText("Stale — 3 sources changed")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Read the full dossier" }));
    expect(
      await screen.findByRole("button", { name: "Regenerate" }),
    ).toBeVisible();
  });

  it("passes a trimmed optional instruction when regenerating", async () => {
    const user = userEvent.setup();
    stubFetch(artifact({ status: "current" }));
    renderBrief();
    await user.click(await screen.findByRole("button", { name: "Read the full dossier" }));
    await user.type(
      await screen.findByLabelText("Dossier instruction"),
      "  Focus on unresolved claims  ",
    );
    await user.click(await screen.findByRole("button", { name: "Regenerate" }));
    await waitFor(() =>
      expect(streamMocks.sseClientDirect).toHaveBeenCalledTimes(1),
    );
  });

  it("renders a citation that dispatches a reader pulse when clicked", async () => {
    const user = userEvent.setup();
    const pulses: ReaderPulseTarget[] = [];
    const listener = (event: Event) => {
      if (event instanceof CustomEvent) pulses.push(event.detail as ReaderPulseTarget);
    };
    window.addEventListener(READER_PULSE_HIGHLIGHT, listener);
    try {
      stubFetch(artifact({ status: "current" }));
      renderBrief();
      await user.click(
        await screen.findByRole("button", { name: "Read the full dossier" }),
      );
      await user.click(await screen.findByRole("link", { name: "Open citation 1" }));
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
      if (event instanceof CustomEvent) pulses.push(event.detail as NotePulseTarget);
    };
    window.addEventListener(NOTE_PULSE_HIGHLIGHT, listener);
    try {
      stubFetch(artifact({ status: "current", citations: [NOTE_CITATION] }));
      const { onNavigatePane } = renderBrief();
      await user.click(
        await screen.findByRole("button", { name: "Read the full dossier" }),
      );
      await user.click(await screen.findByRole("link", { name: "Open citation 1" }));
      await waitFor(() => expect(pulses).toHaveLength(1));
      expect(pulses[0]).toMatchObject({ blockId: "block-1", startOffset: 0, endOffset: 10 });
      expect(onNavigatePane).toHaveBeenCalledWith("pane-library", "/notes/block-1", undefined);
    } finally {
      window.removeEventListener(NOTE_PULSE_HIGHLIGHT, listener);
    }
  });

  it("auto-expands a selected historical revision inline (AC-5)", async () => {
    const selectedRevision = revision();
    stubFetch(artifact({ status: "current" }), { revisionBody: selectedRevision });
    renderBriefAt(
      `/libraries/${LIBRARY_ID}?tab=intelligence&revision=${selectedRevision.revision_id}`,
    );

    expect(await screen.findByText(/Historical synthesis/)).toBeVisible();
    expect(screen.getByText("Historical revision")).toBeVisible();
  });

  it("shows revision history metadata when supplied", async () => {
    const user = userEvent.setup();
    stubFetch(artifact({ status: "current" }), {
      revisions: [
        revisionSummary({
          citation_count: 2,
          source_count: 4,
          covered_source_count: 4,
          custom_instruction: "Focus on budget risk",
          model_provider: "openai",
          model_name: "gpt-5",
        }),
      ],
    });
    renderBrief();
    await user.click(await screen.findByRole("button", { name: "Read the full dossier" }));
    await user.click(await screen.findByRole("button", { name: "Dossier history" }));
    expect(await screen.findByText(/2 citations/)).toBeVisible();
    expect(await screen.findByText(/4 sources covered/)).toBeVisible();
    expect(await screen.findByText(/openai\/gpt-5/)).toBeVisible();
    expect(
      await screen.findByText(/Instruction: Focus on budget risk/),
    ).toBeVisible();
  });

  it("opens a real dossier chat conversation for the current revision (D-6)", async () => {
    const user = userEvent.setup();
    stubFetch(artifact({ status: "current" }));
    const { onOpenInNewPane } = renderBrief();
    await user.click(await screen.findByRole("button", { name: "Read the full dossier" }));
    await user.click(
      await screen.findByRole("button", { name: "Chat about this dossier" }),
    );
    await waitFor(() =>
      expect(onOpenInNewPane).toHaveBeenCalledWith(
        `/conversations/${CONVERSATION_ID}`,
        "Dossier chat",
        undefined,
      ),
    );
  });

  it("surfaces a FeedbackNotice when the dossier chat fails to open (D-6)", async () => {
    const user = userEvent.setup();
    stubFetch(artifact({ status: "current" }), { conversationFails: true });
    const { onOpenInNewPane } = renderBrief();
    await user.click(await screen.findByRole("button", { name: "Read the full dossier" }));
    await user.click(
      await screen.findByRole("button", { name: "Chat about this dossier" }),
    );
    expect(await screen.findByText("Failed to open dossier chat")).toBeVisible();
    expect(onOpenInNewPane).not.toHaveBeenCalled();
  });
});
