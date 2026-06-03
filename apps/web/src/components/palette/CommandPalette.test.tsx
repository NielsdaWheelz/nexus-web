import { act, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CommandPalette from "@/components/palette/CommandPalette";
import { OPEN_COMMAND_PALETTE_EVENT } from "@/components/commandPaletteEvents";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";

const workspacePrimaryMetrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

function mockApi(
  recents: { target_key: string; target_href: string; title_snapshot: string; last_used_at: string }[] = [],
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/me/palette-history") {
      return jsonResponse({
        data: {
          recent: recents.map((row) => ({ ...row, target_kind: "href", source: "recent" })),
          frecency_boosts: {},
        },
      });
    }
    if (url.pathname === "/api/me/palette-selections" && init?.method === "POST") {
      return jsonResponse({ data: null });
    }
    if (url.pathname === "/api/oracle/readings") return jsonResponse({ data: [] });
    if (url.pathname === "/api/search") {
      return jsonResponse({ results: [], page: { has_more: false, next_cursor: null } });
    }
    throw new Error(`Unexpected fetch: ${url.pathname}`);
  });
}

function renderPalette() {
  return render(
    <FeedbackProvider>
      <WorkspaceStoreProvider workspacePrimaryMetrics={workspacePrimaryMetrics} initialHref="/libraries">
        <CommandPalette />
      </WorkspaceStoreProvider>
    </FeedbackProvider>,
  );
}

function open() {
  act(() => window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT)));
}

async function selectionBody(fetchMock: ReturnType<typeof mockApi>): Promise<Record<string, unknown>> {
  return await waitFor(() => {
    const call = [...fetchMock.mock.calls]
      .reverse()
      .find(([url, init]) => String(url) === "/api/me/palette-selections" && init?.method === "POST");
    if (!call) throw new Error("no selection POST yet");
    return JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
  });
}

describe("CommandPalette", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, "", "/libraries");
    vi.stubGlobal("innerWidth", 1280); // desktop surface
    mockApi();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens with dialog + combobox + listbox semantics and keeps focus on the input while arrowing", async () => {
    renderPalette();
    open();

    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    const input = screen.getByRole("combobox", { name: "Search commands" });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(input).toHaveFocus();

    await userEvent.keyboard("{ArrowDown}");
    expect(input).toHaveFocus(); // focus never leaves the input
    expect(input.getAttribute("aria-activedescendant")).toMatch(/^palette-option-/);
    expect(dialog).toBeInTheDocument();
  });

  it("logs an href selection with the exact wire body", async () => {
    const fetchMock = mockApi();
    renderPalette();
    open();
    const input = await screen.findByRole("combobox", { name: "Search commands" });
    await userEvent.type(input, "keyboard");
    await userEvent.keyboard("{Enter}");

    expect(await selectionBody(fetchMock)).toEqual({
      query: "keyboard",
      target_key: "/settings/keybindings",
      target_kind: "href",
      target_href: "/settings/keybindings",
      title_snapshot: "Keyboard Shortcuts",
      source: "static",
    });
  });

  it("logs an action selection with target_href null", async () => {
    const fetchMock = mockApi();
    renderPalette();
    open();
    const input = await screen.findByRole("combobox", { name: "Search commands" });
    await userEvent.type(input, "new conversation");
    await userEvent.keyboard("{Enter}");

    expect(await selectionBody(fetchMock)).toMatchObject({
      target_key: "create-conversation",
      target_kind: "action",
      target_href: null,
      source: "static",
    });
  });

  it("logs an Ask AI selection as wire kind prefill / source ai", async () => {
    const fetchMock = mockApi();
    renderPalette();
    open();
    const input = await screen.findByRole("combobox", { name: "Search commands" });
    await userEvent.type(input, "summarize this");
    await userEvent.click(await screen.findByRole("option", { name: /Ask AI about/ }));

    expect(await selectionBody(fetchMock)).toMatchObject({
      target_kind: "prefill",
      target_key: "prefill:conversation:summarize this",
      target_href: null,
      source: "ai",
    });
  });

  it("drills into an item's actions on ArrowRight and pops back preserving the query", async () => {
    mockApi([
      { target_key: "/some/doc", target_href: "/some/doc", title_snapshot: "Some Doc", last_used_at: "2026-01-01" },
    ]);
    renderPalette();
    open();
    const input = await screen.findByRole("combobox", { name: "Search commands" });
    await userEvent.type(input, "some doc");
    await screen.findByRole("option", { name: /Some Doc/ });

    await userEvent.keyboard("{ArrowRight}");
    expect(await screen.findByRole("option", { name: /^Open/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Copy link/ })).toBeInTheDocument();

    await userEvent.keyboard("{ArrowLeft}");
    expect(await screen.findByRole("option", { name: /Some Doc/ })).toBeInTheDocument();
    expect(input).toHaveValue("some doc"); // query preserved across drill/back
  });

  it("closes on Escape and on a backdrop click", async () => {
    renderPalette();
    open();
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();

    open();
    const reopened = await screen.findByRole("dialog", { name: "Command palette" });
    // The scrim is the dialog's portal parent; a backdrop has no ARIA role to query by.
    // eslint-disable-next-line testing-library/no-node-access
    await userEvent.click(reopened.parentElement as HTMLElement);
    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
    expect(dialog).not.toBe(reopened);
  });

  it("shows a lane chip for a sigil and Backspace at the start clears the lane", async () => {
    renderPalette();
    open();
    const input = await screen.findByRole("combobox", { name: "Search commands" });

    await userEvent.type(input, ">");
    expect(screen.getByText(/Actions/)).toBeInTheDocument(); // lane chip
    expect(input).toHaveValue(""); // sigil is shown as the chip, not in the field

    await userEvent.keyboard("{Backspace}");
    expect(screen.queryByText(/Actions ›/)).not.toBeInTheDocument(); // lane cleared
  });
});
