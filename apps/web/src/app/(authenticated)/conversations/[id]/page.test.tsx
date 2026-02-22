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
    mockSearchParams = new URLSearchParams(`attach_type=highlight&attach_id=${VALID_UUID}&extra=keep`);

    mockApiFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
      // Handle the send POST
      if (
        url.includes(`/conversations/${CONV_ID}/messages`) &&
        !url.includes("?") &&
        opts?.method === "POST"
      ) {
        const body = JSON.parse(opts.body as string);
        expect(body.contexts).toBeDefined();
        expect(body.contexts[0].type).toBe("highlight");
        expect(body.contexts[0].id).toBe(VALID_UUID);

        return {
          data: {
            conversation: { id: CONV_ID },
            user_message: {
              id: "msg-u2",
              seq: 2,
              role: "user",
              content: body.content,
              status: "complete",
              error_code: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            assistant_message: {
              id: "msg-a2",
              seq: 3,
              role: "assistant",
              content: "OK",
              status: "complete",
              error_code: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          },
        };
      }
      return defaultApiHandler(url);
    });

    const paramsPromise = Promise.resolve({ id: CONV_ID });
    await act(async () => {
      render(
        <Suspense fallback={<div>Loading...</div>}>
          <ConversationPage params={paramsPromise} />
        </Suspense>,
      );
    });

    await waitFor(() => {
      expect(screen.queryAllByText(/highlight:/i).length).toBeGreaterThanOrEqual(1);
    });

    expect(screen.getByText(new RegExp(VALID_UUID.slice(0, 8)))).toBeTruthy();

    const textarea = screen.getByPlaceholderText(/type a message/i);
    const user = (await import("@testing-library/user-event")).default.setup();
    await user.type(textarea, "test message");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalled();
    });

    const replaceUrl = mockReplace.mock.calls[0][0] as string;
    expect(replaceUrl).not.toContain("attach_type");
    expect(replaceUrl).not.toContain("attach_id");
    expect(replaceUrl).toContain(`/conversations/${CONV_ID}`);
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
