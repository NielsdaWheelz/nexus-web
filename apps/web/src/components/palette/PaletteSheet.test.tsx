import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import CommandPalette from "@/components/palette/CommandPalette";
import { OPEN_COMMAND_PALETTE_EVENT } from "@/components/commandPaletteEvents";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";

const workspacePrimaryMetrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

function mockMatchMedia({
  mobile,
  reducedMotion = false,
}: {
  mobile: boolean;
  reducedMotion?: boolean;
}) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: query.includes("max-width") ? mobile : reducedMotion && query.includes("reduce"),
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

function mockApi() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/me/palette-history") {
      return jsonResponse({ data: { recent: [], frecency_boosts: {} } });
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
    withRenderEnvironment(
      <KeybindingsProvider>
        <FeedbackProvider>
          <WorkspaceStoreProvider
            workspacePrimaryMetrics={workspacePrimaryMetrics}
            initialHref="/libraries"
          >
            <CommandPalette />
          </WorkspaceStoreProvider>
        </FeedbackProvider>
      </KeybindingsProvider>,
      { initialViewport: "mobile" },
    ),
  );
}

function open() {
  act(() => window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT)));
}

describe("PaletteSheet (mobile bottom sheet)", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, "", "/libraries");
    vi.stubGlobal("innerWidth", 390); // mobile viewport
    mockMatchMedia({ mobile: true });
    vi.spyOn(history, "pushState").mockImplementation(() => {});
    vi.spyOn(history, "back").mockImplementation(() => {});
    // setPointerCapture isn't implemented for synthetic pointer events in the test env.
    vi.spyOn(Element.prototype, "setPointerCapture").mockImplementation(() => {});
    mockApi();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens as a bottom sheet dialog with a grabber and focused combobox", async () => {
    renderPalette();
    open();

    await screen.findByRole("dialog", { name: "Command palette" });

    // Grabber element is present (the drag handle at the top of the sheet). It is
    // aria-hidden decorative, so there is no role/label to query it by.
    // eslint-disable-next-line testing-library/no-node-access
    expect(document.querySelector("[data-grabber]")).not.toBeNull();

    // Combobox has focus via useDialogOverlay's initialFocus
    const input = screen.getByRole("combobox", { name: /search commands/i });
    expect(input).toHaveFocus();
  });

  it("closes when the Android / browser back button fires popstate", async () => {
    renderPalette();
    open();

    await screen.findByRole("dialog", { name: "Command palette" });

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
    });
  });

  it("closes the sheet and pops the synthetic history entry when selecting a result", async () => {
    renderPalette();
    open();

    const input = await screen.findByRole("combobox", { name: /search commands/i });
    await userEvent.type(input, "keyboard");

    // Wait for the matching static command to appear then select it
    await screen.findByRole("option", { name: /keyboard shortcuts/i });
    await userEvent.keyboard("{Enter}");

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
    });

    // history.back() must have been called to pop the synthetic entry
    expect(history.back).toHaveBeenCalled();
  });

  it("drag down past the threshold on the grabber dismisses the sheet", async () => {
    renderPalette();
    open();

    await screen.findByRole("dialog", { name: "Command palette" });

    // The grabber is aria-hidden decorative, so there is no role/label to query it by.
    // eslint-disable-next-line testing-library/no-node-access
    const grabber = document.querySelector("[data-grabber]")!;

    fireEvent.pointerDown(grabber, { clientY: 100, pointerId: 1, bubbles: true });
    fireEvent.pointerMove(grabber, { clientY: 197, pointerId: 1, bubbles: true });
    fireEvent.pointerUp(grabber, { clientY: 197, pointerId: 1, bubbles: true });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
    });
  });

  it("a drag shorter than the threshold leaves the sheet open", async () => {
    renderPalette();
    open();

    await screen.findByRole("dialog", { name: "Command palette" });

    // eslint-disable-next-line testing-library/no-node-access
    const grabber = document.querySelector("[data-grabber]")!;

    fireEvent.pointerDown(grabber, { clientY: 100, pointerId: 1, bubbles: true });
    fireEvent.pointerMove(grabber, { clientY: 140, pointerId: 1, bubbles: true });
    fireEvent.pointerUp(grabber, { clientY: 140, pointerId: 1, bubbles: true });

    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
  });

  it("reduced-motion disables drag dismissal", async () => {
    mockMatchMedia({ mobile: true, reducedMotion: true });

    renderPalette();
    open();

    await screen.findByRole("dialog", { name: "Command palette" });

    // eslint-disable-next-line testing-library/no-node-access
    const grabber = document.querySelector("[data-grabber]")!;

    // Same past-threshold gesture as the dismissal test; reduced motion must suppress it.
    fireEvent.pointerDown(grabber, { clientY: 100, pointerId: 1, bubbles: true });
    fireEvent.pointerMove(grabber, { clientY: 197, pointerId: 1, bubbles: true });
    fireEvent.pointerUp(grabber, { clientY: 197, pointerId: 1, bubbles: true });

    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
  });
});
