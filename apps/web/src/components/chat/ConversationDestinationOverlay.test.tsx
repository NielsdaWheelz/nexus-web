import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConversationDestinationOverlay, {
  type ConversationDestinationOverlayProps,
} from "./ConversationDestinationOverlay";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import type { ConversationListItem } from "@/lib/conversations/types";

// The render-environment `currentInstant` (2026-06-03T12:00:00Z) is the clock the
// relative-time cells are formatted against, so these fixtures are deterministic.
function conversation(overrides: Partial<ConversationListItem> = {}): ConversationListItem {
  return {
    id: "c1",
    title: "Design review",
    message_count: 4,
    updated_at: "2026-06-03T09:00:00.000Z", // 3 hours before currentInstant
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: { code, message: code, request_id: "req-x" } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function page(
  data: ConversationListItem[],
  opts: { hasMore?: boolean; nextCursor?: string | null } = {},
): Response {
  return jsonResponse({
    data,
    page: { has_more: opts.hasMore ?? false, next_cursor: opts.nextCursor ?? null },
  });
}

function installFetch(respond: (params: URLSearchParams) => Response) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string | URL) => {
    const raw = String(url);
    calls.push(raw);
    return respond(new URL(raw, "http://localhost").searchParams);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

// Pin matchMedia so `useIsMobileViewport()` is deterministic in headless Chromium.
function setViewport(kind: "desktop" | "mobile") {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: kind === "mobile" && query.includes("max-width"),
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent() {
          return false;
        },
      }) as MediaQueryList,
  );
}

function renderOverlay(
  overrides: Partial<ConversationDestinationOverlayProps> = {},
  viewport: "desktop" | "mobile" = "desktop",
) {
  setViewport(viewport);
  const props: ConversationDestinationOverlayProps = {
    open: true,
    onClose: vi.fn(),
    onSelectConversation: vi.fn(),
    ...overrides,
  };
  const utils = render(
    withRenderEnvironment(
      <ConversationDestinationOverlay {...props} />,
      viewport === "mobile" ? { initialViewport: "mobile" } : {},
    ),
  );
  return { ...utils, props };
}

let fakeHistoryState: unknown = null;

beforeEach(() => {
  fakeHistoryState = null;
  vi.spyOn(history, "pushState").mockImplementation((state) => {
    fakeHistoryState = state;
  });
  vi.spyOn(history, "replaceState").mockImplementation((state) => {
    fakeHistoryState = state;
  });
  vi.spyOn(history, "back").mockImplementation(() => {
    fakeHistoryState = null;
  });
  vi.spyOn(history, "state", "get").mockImplementation(() => fakeHistoryState);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ConversationDestinationOverlay", () => {
  it("lists recent owned chats with title, updated time, and message count", async () => {
    const { calls } = installFetch(() =>
      page([conversation({ id: "c1", title: "Design review", message_count: 4 })]),
    );
    renderOverlay();

    const option = await screen.findByRole("option", { name: /Design review/ });
    expect(option).toHaveTextContent("4 messages");
    expect(option).toHaveTextContent(/ago/); // relative updated time

    // The first load asks for recent conversations with no title query.
    expect(calls[0]).toContain("/api/conversations?limit=25");
    expect(calls[0]).not.toContain("q=");
  });

  it("uses the singular '1 message' label", async () => {
    installFetch(() => page([conversation({ message_count: 1 })]));
    renderOverlay();
    expect(await screen.findByRole("option", { name: /Design review/ })).toHaveTextContent(
      "1 message",
    );
  });

  it("focuses the search field and wires the combobox to its listbox", async () => {
    installFetch(() =>
      page([
        conversation({ id: "c1", title: "First chat" }),
        conversation({ id: "c2", title: "Second chat" }),
      ]),
    );
    renderOverlay();

    const combobox = screen.getByRole("combobox");
    await waitFor(() => expect(combobox).toHaveFocus());

    const listbox = screen.getByRole("listbox");
    expect(combobox).toHaveAttribute("aria-controls", listbox.id);
    expect(combobox).toHaveAttribute("aria-expanded", "true");

    // First row is active by default; activedescendant points at it; rows are not
    // tab stops (roving via aria-activedescendant).
    const first = await screen.findByRole("option", { name: /First chat/ });
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(combobox.getAttribute("aria-activedescendant")).toBe(first.id);
    expect(first).not.toHaveAttribute("tabindex");
  });

  it("moves the active row with ArrowDown and selects it with Enter", async () => {
    const onSelectConversation = vi.fn();
    installFetch(() =>
      page([
        conversation({ id: "c1", title: "First chat" }),
        conversation({ id: "c2", title: "Second chat" }),
      ]),
    );
    renderOverlay({ onSelectConversation });

    await screen.findByRole("option", { name: /Second chat/ });
    const combobox = screen.getByRole("combobox");
    fireEvent.keyDown(combobox, { key: "ArrowDown" });
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /Second chat/ })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    fireEvent.keyDown(combobox, { key: "Enter" });
    expect(onSelectConversation).toHaveBeenCalledWith("c2");
  });

  it("selects a chat on click", async () => {
    const onSelectConversation = vi.fn();
    installFetch(() => page([conversation({ id: "c9", title: "Clickable chat" })]));
    renderOverlay({ onSelectConversation });
    fireEvent.click(await screen.findByRole("option", { name: /Clickable chat/ }));
    expect(onSelectConversation).toHaveBeenCalledWith("c9");
  });

  it("debounces typing before querying the title search, and resets to page one", async () => {
    const { calls } = installFetch((params) => {
      const q = params.get("q") ?? "";
      return page(
        q === "beta"
          ? [conversation({ id: "c2", title: "Beta chat" })]
          : [conversation({ id: "c1", title: "Alpha chat" })],
      );
    });
    renderOverlay();
    await screen.findByRole("option", { name: /Alpha chat/ });

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "beta" } });
    // The query is debounced: no request carries q=beta synchronously.
    expect(calls.some((url) => url.includes("q=beta"))).toBe(false);

    // After the debounce it fires exactly one q=beta request and swaps the results.
    await waitFor(() => expect(calls.some((url) => url.includes("q=beta"))).toBe(true));
    expect(await screen.findByRole("option", { name: /Beta chat/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Alpha chat/ })).not.toBeInTheDocument();
  });

  it("shows the empty state when the owner has no chats", async () => {
    installFetch(() => page([]));
    renderOverlay();
    expect(await screen.findByText("You have no chats yet.")).toBeInTheDocument();
  });

  it("shows a search-specific empty state when nothing matches", async () => {
    installFetch((params) =>
      page((params.get("q") ?? "") ? [] : [conversation({ title: "Only chat" })]),
    );
    renderOverlay();
    await screen.findByRole("option", { name: /Only chat/ });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "zzz" } });
    expect(await screen.findByText("No chats match your search.")).toBeInTheDocument();
  });

  it("surfaces a load error with a Retry that refetches", async () => {
    let call = 0;
    installFetch(() => {
      call += 1;
      return call === 1
        ? errorResponse(400, "E_BAD_REQUEST")
        : page([conversation({ title: "Recovered chat" })]);
    });
    renderOverlay();

    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load chats");
    fireEvent.click(retry);
    expect(await screen.findByRole("option", { name: /Recovered chat/ })).toBeInTheDocument();
  });

  it("loads another cursor page on demand", async () => {
    installFetch((params) => {
      const cursor = params.get("cursor");
      return cursor
        ? page([conversation({ id: "c2", title: "Older chat" })])
        : page([conversation({ id: "c1", title: "Newer chat" })], {
            hasMore: true,
            nextCursor: "cur-2",
          });
    });
    renderOverlay();
    await screen.findByRole("option", { name: /Newer chat/ });
    // Let the pagination hook's post-render effects (generation bump + cursor
    // adoption) flush before paging, so loadMore runs against the settled cursor.
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Load more chats" }));
    expect(await screen.findByRole("option", { name: /Older chat/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Newer chat/ })).toBeInTheDocument();
  });

  it("closes on Escape without selecting", async () => {
    installFetch(() => page([conversation({ title: "Some chat" })]));
    const { props } = renderOverlay();
    await screen.findByRole("option", { name: /Some chat/ });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onSelectConversation).not.toHaveBeenCalled();
  });

  it("renders in a MobileSheet and selects a row there too", async () => {
    const onSelectConversation = vi.fn();
    installFetch(() => page([conversation({ id: "cm", title: "Mobile chat" })]));
    renderOverlay({ onSelectConversation }, "mobile");
    expect(screen.getByRole("dialog", { name: "Ask in existing chat" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("option", { name: /Mobile chat/ }));
    expect(onSelectConversation).toHaveBeenCalledWith("cm");
  });

  describe("focus handoff", () => {
    function Harness({
      onSelectConversation,
    }: {
      onSelectConversation: (id: string) => void;
    }) {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Ask in existing chat
          </button>
          <ConversationDestinationOverlay
            open={open}
            onClose={() => setOpen(false)}
            onSelectConversation={onSelectConversation}
          />
        </>
      );
    }

    function renderHarness(onSelectConversation = vi.fn()) {
      setViewport("desktop");
      render(withRenderEnvironment(<Harness onSelectConversation={onSelectConversation} />));
      return { onSelectConversation };
    }

    it("does NOT return focus to the opener after a successful pick", async () => {
      const onSelectConversation = vi.fn();
      installFetch(() => page([conversation({ id: "cx", title: "Picked chat" })]));
      renderHarness(onSelectConversation);

      const trigger = screen.getByRole("button", { name: "Ask in existing chat" });
      trigger.focus();
      fireEvent.click(trigger);
      const dialog = await screen.findByRole("dialog", { name: "Ask in existing chat" });
      fireEvent.click(await within(dialog).findByRole("option", { name: /Picked chat/ }));

      await waitFor(() => expect(onSelectConversation).toHaveBeenCalledWith("cx"));
      expect(trigger).not.toHaveFocus();
    });

    it("DOES return focus to the opener when dismissed with Escape", async () => {
      installFetch(() => page([conversation({ title: "Kept chat" })]));
      renderHarness();

      const trigger = screen.getByRole("button", { name: "Ask in existing chat" });
      trigger.focus();
      fireEvent.click(trigger);
      const combobox = await screen.findByRole("combobox");
      fireEvent.keyDown(combobox, { key: "Escape" });

      await waitFor(() => expect(trigger).toHaveFocus());
    });
  });
});
