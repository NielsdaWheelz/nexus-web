import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import LibraryChatTab from "@/components/chat/LibraryChatTab";
import type { ContextItem } from "@/lib/api/sse/requests";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const LIB_RESEARCH_ID = "22222222-2222-4222-8222-222222222222";
const LIB_NOTES_ID = "33333333-3333-4333-8333-333333333333";
const LIB_DEFAULT_ID = "44444444-4444-4444-8444-444444444444";
const PENDING_CONTEXTS: ContextItem[] = [
  {
    kind: "object_ref",
    type: "highlight",
    id: "55555555-5555-4555-8555-555555555555",
    exact: "Pending library quote",
    color: "yellow",
  },
];

function pathOf(input: RequestInfo | URL): string {
  if (input instanceof Request) {
    return new URL(input.url).pathname;
  }
  return new URL(String(input), "http://localhost").pathname;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

interface LibraryMembership {
  id: string;
  name: string;
  color: string | null;
  is_default?: boolean;
  is_in_library: boolean;
  can_add: boolean;
  can_remove: boolean;
}

function stubLibraryChatFetch(libraries: LibraryMembership[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = pathOf(input);
      if (path === `/api/media/${MEDIA_ID}/libraries`) {
        return jsonResponse({ data: libraries });
      }
      if (path.startsWith("/api/chat-singletons/library/")) {
        return jsonResponse({
          data: { conversation_id: null, message_count: 0 },
        });
      }
      throw new Error(`Unexpected fetch call: ${path}`);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LibraryChatTab", () => {
  it("renders one row per non-default library the doc belongs to", async () => {
    stubLibraryChatFetch([
      {
        id: LIB_DEFAULT_ID,
        name: "My Library",
        color: null,
        is_default: true,
        is_in_library: true,
        can_add: false,
        can_remove: false,
      },
      {
        id: LIB_RESEARCH_ID,
        name: "Research",
        color: null,
        is_default: false,
        is_in_library: true,
        can_add: false,
        can_remove: true,
      },
      {
        id: LIB_NOTES_ID,
        name: "Notes",
        color: null,
        is_default: false,
        is_in_library: true,
        can_add: false,
        can_remove: true,
      },
    ]);

    render(<LibraryChatTab mediaId={MEDIA_ID} onOpenChat={vi.fn()} />);

    expect(
      await screen.findByRole("button", { name: /research/i }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: /notes/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /my library/i }),
    ).not.toBeInTheDocument();
  });

  it("renders the empty state when no additional libraries contain the doc", async () => {
    stubLibraryChatFetch([
      {
        id: LIB_DEFAULT_ID,
        name: "My Library",
        color: null,
        is_default: true,
        is_in_library: true,
        can_add: false,
        can_remove: false,
      },
    ]);

    render(<LibraryChatTab mediaId={MEDIA_ID} onOpenChat={vi.fn()} />);

    expect(
      await screen.findByText(/isn't in any additional libraries yet/i),
    ).toBeInTheDocument();
  });

  it("invokes onOpenChat with libraryId and libraryName when a row is tapped", async () => {
    stubLibraryChatFetch([
      {
        id: LIB_RESEARCH_ID,
        name: "Research",
        color: null,
        is_default: false,
        is_in_library: true,
        can_add: false,
        can_remove: true,
      },
    ]);
    const onOpenChat = vi.fn();

    render(<LibraryChatTab mediaId={MEDIA_ID} onOpenChat={onOpenChat} />);

    const row = await screen.findByRole("button", { name: /research/i });
    fireEvent.click(row);

    expect(onOpenChat).toHaveBeenCalledWith(null, LIB_RESEARCH_ID, "Research");
  });

  it("passes pending context to the selected library row", async () => {
    stubLibraryChatFetch([
      {
        id: LIB_RESEARCH_ID,
        name: "Research",
        color: null,
        is_default: false,
        is_in_library: true,
        can_add: false,
        can_remove: true,
      },
    ]);
    const onOpenChat = vi.fn();

    render(
      <LibraryChatTab
        mediaId={MEDIA_ID}
        pendingContexts={PENDING_CONTEXTS}
        onRemovePendingContext={vi.fn()}
        onOpenChat={onOpenChat}
      />,
    );

    expect(await screen.findByText("Pending context")).toBeInTheDocument();
    expect(screen.getByText("Pending library quote")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /research/i }));

    expect(onOpenChat).toHaveBeenCalledWith(
      null,
      LIB_RESEARCH_ID,
      "Research",
      PENDING_CONTEXTS,
    );
  });

  it("removes pending context from the strip", async () => {
    stubLibraryChatFetch([]);
    const onRemovePendingContext = vi.fn();

    render(
      <LibraryChatTab
        mediaId={MEDIA_ID}
        pendingContexts={PENDING_CONTEXTS}
        onRemovePendingContext={onRemovePendingContext}
        onOpenChat={vi.fn()}
      />,
    );

    await screen.findByText("Pending library quote");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect(onRemovePendingContext).toHaveBeenCalledWith(0);
  });
});
