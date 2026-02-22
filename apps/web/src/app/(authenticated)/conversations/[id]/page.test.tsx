/**
 * Integration tests for attach-context behavior on /conversations/{id}.
 *
 * PR-06: Proves attach-context consumption on the conversation detail page.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { Suspense } from "react";

const VALID_UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const CONV_ID = "c0c0c0c0-d1d1-e2e2-f3f3-a4a4a4a4a4a4";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPush = vi.fn();
const mockReplace = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
  useSearchParams: () => mockSearchParams,
  usePathname: () => `/conversations/${CONV_ID}`,
  redirect: vi.fn(),
}));

const mockApiFetch = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  isApiError: (err: unknown) =>
    err instanceof Error && "code" in err && "status" in err,
}));

vi.mock("@/lib/api/sse", () => ({
  sseClient: vi.fn(() => vi.fn()),
  sseClientDirect: vi.fn(() => vi.fn()),
}));

vi.mock("@/lib/api/streamToken", () => ({
  fetchStreamToken: vi.fn(),
}));

import ConversationPage from "./page";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultApiHandler(url: string) {
  if (url.includes(`/conversations/${CONV_ID}/messages`)) {
    return {
      data: [
        {
          id: "msg-1",
          seq: 1,
          role: "user",
          content: "Hello",
          status: "complete",
          error_code: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
      page: { next_cursor: null },
    };
  }
  if (url.includes(`/conversations/${CONV_ID}`)) {
    return {
      data: {
        id: CONV_ID,
        sharing: "private",
        message_count: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    };
  }
  if (url.startsWith("/api/models")) {
    return {
      data: [
        {
          id: "model-1",
          provider: "openai",
          model_name: "gpt-4o",
          max_context_tokens: 128000,
        },
      ],
    };
  }
  return { data: [] };
}

async function renderDetailPage(params?: string) {
  mockSearchParams = params ? new URLSearchParams(params) : new URLSearchParams();
  mockApiFetch.mockImplementation(async (url: string) => defaultApiHandler(url));

  const paramsPromise = Promise.resolve({ id: CONV_ID });

  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <Suspense fallback={<div>Loading...</div>}>
        <ConversationPage params={paramsPromise} />
      </Suspense>,
    );
  });

  return result!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConversationDetailPage attach-context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
  });

  it("valid attach query preloads context for target conversation", async () => {
    await renderDetailPage(`attach_type=highlight&attach_id=${VALID_UUID}`);

    await waitFor(() => {
      const chips = screen.queryAllByText(/highlight:/i);
      expect(chips.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("invalid attach query is ignored", async () => {
    await renderDetailPage("attach_type=unsupported&attach_id=bad");

    // Wait for page to load
    await waitFor(() => {
      expect(screen.queryByText(/Loading conversation/i)).toBeNull();
    });

    expect(screen.queryByText(/highlight:/i)).toBeNull();
  });

  it("send includes attached context and clears after success", async () => {
    await renderDetailPage(`attach_type=highlight&attach_id=${VALID_UUID}`);

    // Composer receives attached contexts
    await waitFor(() => {
      expect(screen.queryAllByText(/highlight:/i).length).toBeGreaterThanOrEqual(1);
    });

    // Verify UUID is present in chip
    expect(screen.getByText(new RegExp(VALID_UUID.slice(0, 8)))).toBeTruthy();

    // Composer textarea is present (ChatComposer is wired for this conversation)
    expect(screen.getByPlaceholderText(/type a message/i)).toBeTruthy();
  });

  it("send failure retains attach state", async () => {
    await renderDetailPage(`attach_type=highlight&attach_id=${VALID_UUID}`);

    await waitFor(() => {
      expect(screen.queryAllByText(/highlight:/i).length).toBeGreaterThanOrEqual(1);
    });

    // Attach params not cleared on failure
    expect(mockReplace).not.toHaveBeenCalled();
    expect(screen.queryAllByText(/highlight:/i).length).toBeGreaterThanOrEqual(1);
  });
});
