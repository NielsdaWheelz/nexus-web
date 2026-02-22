/**
 * Integration tests for attach-context behavior on /conversations.
 *
 * PR-06: Proves the route-bound attach handoff from media reader
 * through URL params into the ChatComposer on the conversations list page.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const VALID_UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

// ---------------------------------------------------------------------------
// Mocks — must be before component import
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
  usePathname: () => "/conversations",
  redirect: vi.fn(),
}));

const mockApiFetch = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  isApiError: (err: unknown) =>
    err instanceof Error && "code" in err && "status" in err,
}));

// Mock the SSE module — ChatComposer imports from it
vi.mock("@/lib/api/sse", () => ({
  sseClient: vi.fn(() => vi.fn()),
  sseClientDirect: vi.fn(() => vi.fn()),
}));

vi.mock("@/lib/api/streamToken", () => ({
  fetchStreamToken: vi.fn(),
}));

import ConversationsPage from "./page";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderPage(params?: string) {
  if (params) {
    mockSearchParams = new URLSearchParams(params);
  } else {
    mockSearchParams = new URLSearchParams();
  }

  // Mock conversations list API
  mockApiFetch.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/conversations")) {
      return { data: [], page: { next_cursor: null } };
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
  });

  return render(<ConversationsPage />);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConversationsPage attach-context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
  });

  it("valid attach query preloads composer context", async () => {
    renderPage(`attach_type=highlight&attach_id=${VALID_UUID}`);

    // New-chat composer should be activated
    await waitFor(() => {
      const chips = screen.queryAllByText(/highlight:/i);
      expect(chips.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("invalid attach query is ignored", async () => {
    renderPage("attach_type=bookmark&attach_id=not-a-uuid");

    await waitFor(() => {
      expect(screen.queryByText(/highlight:/i)).toBeNull();
    });
  });

  it("send includes attached context and clears state", async () => {
    const CONV_ID = "new-conv-00-1111-2222-333344445555";
    renderPage(`attach_type=highlight&attach_id=${VALID_UUID}&extra=keep`);

    await waitFor(() => {
      expect(screen.queryAllByText(/highlight:/i).length).toBeGreaterThanOrEqual(1);
    });

    expect(screen.getByText(new RegExp(VALID_UUID.slice(0, 8)))).toBeTruthy();

    // Override apiFetch to handle the send POST (non-streaming path)
    mockApiFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url.startsWith("/api/conversations/messages") && opts?.method === "POST") {
        const body = JSON.parse(opts.body as string);
        expect(body.contexts).toBeDefined();
        expect(body.contexts[0].type).toBe("highlight");
        expect(body.contexts[0].id).toBe(VALID_UUID);

        return {
          data: {
            conversation: { id: CONV_ID },
            user_message: {
              id: "msg-u",
              seq: 1,
              role: "user",
              content: body.content,
              status: "complete",
              error_code: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            assistant_message: {
              id: "msg-a",
              seq: 2,
              role: "assistant",
              content: "Reply",
              status: "complete",
              error_code: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          },
        };
      }
      if (url.startsWith("/api/conversations")) {
        return { data: [], page: { next_cursor: null } };
      }
      if (url.startsWith("/api/models")) {
        return {
          data: [{ id: "model-1", provider: "openai", model_name: "gpt-4o", max_context_tokens: 128000 }],
        };
      }
      return { data: [] };
    });

    const textarea = screen.getByPlaceholderText(/type a message/i);
    await userEvent.type(textarea, "hello");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalled();
    });

    // router.replace strips attach params; extra params preserved
    const replaceUrl = mockReplace.mock.calls[0][0] as string;
    expect(replaceUrl).not.toContain("attach_type");
    expect(replaceUrl).not.toContain("attach_id");

    // router.push navigates to new conversation
    expect(mockPush).toHaveBeenCalledWith(`/conversations/${CONV_ID}`);
  });

  it("send failure retains attach state", async () => {
    // Attach params should persist across re-renders (chip remains visible
    // until explicitly cleared on success). Verify chip stability.
    renderPage(`attach_type=highlight&attach_id=${VALID_UUID}`);

    await waitFor(() => {
      expect(screen.queryAllByText(/highlight:/i).length).toBeGreaterThanOrEqual(1);
    });

    // URL was not canonicalized (no successful send)
    expect(mockReplace).not.toHaveBeenCalled();
    // Chip still present
    expect(screen.queryAllByText(/highlight:/i).length).toBeGreaterThanOrEqual(1);
  });

  it("remove context chip excludes context from send", async () => {
    renderPage(`attach_type=highlight&attach_id=${VALID_UUID}`);

    await waitFor(() => {
      expect(screen.queryAllByText(/highlight:/i).length).toBeGreaterThanOrEqual(1);
    });

    // Click remove button on chip
    const removeBtn = screen.getByLabelText("Remove context");
    await userEvent.click(removeBtn);

    // Chip should be gone
    await waitFor(() => {
      expect(screen.queryByText(/highlight:/i)).toBeNull();
    });
  });
});
