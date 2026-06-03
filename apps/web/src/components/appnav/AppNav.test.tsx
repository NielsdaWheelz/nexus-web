import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, type RenderResult } from "@testing-library/react";
import AppNav from "./AppNav";
import { OPEN_COMMAND_PALETTE_EVENT } from "@/components/commandPaletteEvents";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";

const COLLAPSE_KEY = "nexus.nav.collapsed.v1";

const workspacePrimaryMetrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

// Back AppNav's pins `useResource` through the real fetch boundary. The hook
// hits `/api/pinned-objects?surface_key=navbar` and expects the `{ data: { pins } }`
// envelope; an empty pins list mirrors the old internal mock's payload.
function mockApi() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/pinned-objects") {
      return jsonResponse({ data: { pins: [] } });
    }
    throw new Error(`Unexpected fetch: ${url.pathname}`);
  });
}

// Seed the real workspace store so the single active pane sits on /libraries —
// the same fixture the old internal store mock hard-coded.
function renderNav(): RenderResult {
  return render(
    <MobileChromeProvider>
      <WorkspaceStoreProvider workspacePrimaryMetrics={workspacePrimaryMetrics} initialHref="/libraries">
        <AppNav />
      </WorkspaceStoreProvider>
    </MobileChromeProvider>,
  );
}

describe("AppNav (desktop rail)", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, "", "/libraries");
    vi.stubGlobal("innerWidth", 1280); // desktop surface drives useIsMobileViewport=false
    mockApi();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders grouped destinations and marks the active one with aria-current", () => {
    renderNav();

    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(screen.getByText("Library")).toBeInTheDocument();
    expect(screen.getByText("Tools")).toBeInTheDocument();

    // Active pane is /libraries → exactly the Libraries link is current.
    expect(screen.getByRole("link", { name: "Libraries" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Browse" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Oracle" })).toBeInTheDocument();
  });

  it("moves aria-current when a destination click navigates the active pane", () => {
    renderNav();

    // A real store-driven navigation: clicking Browse drives navigatePane, the
    // active pane's href becomes /browse, and AppNav recomputes the active id.
    fireEvent.click(screen.getByRole("link", { name: "Browse" }));

    expect(screen.getByRole("link", { name: "Browse" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Libraries" })).not.toHaveAttribute("aria-current");
  });

  it("persists collapse and keeps every nav link accessibly named while collapsed", () => {
    renderNav();

    fireEvent.click(screen.getByRole("button", { name: "Collapse navigation" }));

    expect(localStorage.getItem(COLLAPSE_KEY)).toBe("1");
    expect(screen.getByRole("button", { name: "Expand navigation" })).toBeInTheDocument();
    // Visible labels are hidden when collapsed, but the accessible name must survive.
    expect(screen.getByRole("link", { name: "Libraries" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Oracle" })).toBeInTheDocument();
  });

  it("opens the command palette from the command bar", () => {
    const onOpen = vi.fn();
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen);
    renderNav();

    fireEvent.click(screen.getByRole("button", { name: "Search or ask anything" }));

    expect(onOpen).toHaveBeenCalledTimes(1);
    window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen);
  });

  it("opens an account menu with Settings and Sign Out", async () => {
    renderNav();

    fireEvent.click(screen.getByRole("button", { name: "Account" }));

    expect(await screen.findByRole("menuitem", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Sign Out" })).toBeInTheDocument();
  });
});

describe("AppNav (mobile sheet)", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, "", "/libraries");
    vi.stubGlobal("innerWidth", 390); // mobile viewport drives useIsMobileViewport=true
    mockApi();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("closes an open NavSheet when OPEN_COMMAND_PALETTE_EVENT fires", () => {
    renderNav();

    // Open the sheet via the mobile top-bar brand button.
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBeInTheDocument();

    // Dispatch the palette event — the sheet's useEffect listener calls setSheetOpen(false).
    act(() => {
      window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT));
    });

    expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument();
  });
});
