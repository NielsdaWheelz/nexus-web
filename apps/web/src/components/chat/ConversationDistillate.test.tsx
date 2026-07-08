import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConversationDistillate from "@/components/chat/ConversationDistillate";

// The distillate runs the real useArtifactStream/useGenerationRun; only the
// external streaming transport is mocked. fetch is stubbed at the boundary.
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

const CONVERSATION_ID = "conv-1";
const REVISION_ID = "rev-1";
const MESSAGE_ID = "msg-9";

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

const CITATION = {
  ordinal: 1,
  role: "context",
  target_ref: { type: "message", id: MESSAGE_ID },
  activation: {
    resourceRef: `message:${MESSAGE_ID}`,
    kind: "route",
    href: `/conversations/${CONVERSATION_ID}#message-${MESSAGE_ID}`,
    unresolvedReason: null,
  },
  media_id: null,
  locator: null,
  deep_link: `/conversations/${CONVERSATION_ID}#message-${MESSAGE_ID}`,
  snapshot: { title: null, excerpt: "the cited turn" },
};

function distillate(overrides: Record<string, unknown> = {}) {
  return {
    artifact_id: "artifact-1",
    revision_id: REVISION_ID,
    revision_ref: `artifact_revision:${REVISION_ID}`,
    status: "current",
    content_md: "Two ideas were settled here.\n\n- The first claim [1]",
    citations: [CITATION],
    build: null,
    ...overrides,
  };
}

function stubFetch(body: ReturnType<typeof distillate>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = pathOf(input);
      if (path === `/api/conversations/${CONVERSATION_ID}/distillate`) {
        return jsonResponse({ data: body });
      }
      return jsonResponse({ error: { code: "E_NOT_FOUND", message: "no", request_id: "r" } }, 404);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ConversationDistillate", () => {
  it("renders nothing when there is no distillate (silence)", async () => {
    stubFetch(
      distillate({
        status: "unavailable",
        artifact_id: null,
        revision_id: null,
        revision_ref: null,
        content_md: "",
        citations: [],
      }),
    );
    render(<ConversationDistillate conversationId={CONVERSATION_ID} />);
    // Give the resource a tick to resolve, then assert silence.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("conversation-distillate")).toBeNull();
  });

  it("renders a collapsed machine-voice lede that expands to full claims", async () => {
    stubFetch(distillate());
    render(<ConversationDistillate conversationId={CONVERSATION_ID} />);

    const block = await screen.findByTestId("conversation-distillate");
    // Verify the MachineText origin label "Distillate" is present in the block.
    expect(within(block).getByText("Distillate")).toBeTruthy();
    // Collapsed: only the lede line.
    expect(screen.getByText("Two ideas were settled here.")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Show distillate" }));
    await waitFor(() => {
      expect(screen.getByText(/The first claim/)).toBeTruthy();
    });
  });

  it("auto-expands when ?distillate=1 forces it open (AC-10)", async () => {
    stubFetch(distillate());
    render(
      <ConversationDistillate conversationId={CONVERSATION_ID} forceExpand />,
    );
    await waitFor(() => {
      expect(screen.getByText(/The first claim/)).toBeTruthy();
    });
  });
});
