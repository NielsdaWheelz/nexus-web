/**
 * Launcher — desktop surface DOM/interaction tests (S8, spec §15).
 *
 * Real Chromium, real providers, fetch boundary stubbed (the controller fetches
 * recents/oracle/search on open). These focus on the UI contract the e2e + the
 * pure provider/ranking unit tests do NOT cover: the lane-chip row, the sigil
 * legend, the bare-URL hard-signal row, and the embedded Add/Create panels that
 * push inside the same dialog. No vi.mock of internal modules.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";

// preloadPane dynamically imports the real pane body; stub that chunk-warm side effect
// (the documented heavy-chunk exception, same as paneWarm.test.tsx) so the launcher's
// prefetch-on-intent surface (hover/arrow → setActiveId → warmPane) can be asserted via
// the pane id it warms. usePaneWarm + the fetch boundary stay real.
const preloadPane = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/lib/panes/paneRenderRegistry", () => ({ preloadPane }));
import Launcher from "./Launcher";
import { dispatchOpenLauncher } from "@/lib/launcher/launcherEvents";
import type { OpenLauncherDetail } from "@/lib/launcher/launcherEvents";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { createDefaultWorkspaceState } from "@/lib/workspace/schema";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";

const workspacePrimaryMetrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

// Force the desktop surface (LauncherSurface) regardless of the headless Chromium width:
// the render-environment provider publishes matchMedia("(max-width: 768px)") on mount.
function mockMatchMedia(mobile: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: query.includes("max-width") ? mobile : false,
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
    if (url.pathname === "/api/browse") return jsonResponse({ data: { sections: {} } });
    if (url.pathname === "/api/web/search") return jsonResponse({ data: { results: [] } });
    throw new Error(`Unexpected fetch: ${url.pathname}`);
  });
}

function renderLauncher() {
  return render(
    withRenderEnvironment(
      <KeybindingsProvider>
        <FeedbackProvider>
          <WorkspaceStoreProvider
            workspacePrimaryMetrics={workspacePrimaryMetrics}
            initialState={createDefaultWorkspaceState("/libraries", workspacePrimaryMetrics)}
          >
            <Launcher />
          </WorkspaceStoreProvider>
        </FeedbackProvider>
      </KeybindingsProvider>,
    ),
  );
}

function open(detail?: OpenLauncherDetail) {
  act(() => dispatchOpenLauncher(detail));
}

async function openDialog(detail?: OpenLauncherDetail): Promise<HTMLElement> {
  renderLauncher();
  open(detail);
  return screen.findByRole("dialog", { name: "Launcher" });
}

function laneChip(name: string): HTMLElement {
  return within(screen.getByRole("group", { name: "Lanes" })).getByRole("button", { name });
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, "", "/libraries");
  vi.stubGlobal("innerWidth", 1280); // desktop surface
  mockMatchMedia(false);
  mockApi();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Lane chips (spec §15 — AC-4 visible lane affordance)
// ---------------------------------------------------------------------------

describe("Launcher — lane chips", () => {
  const ALL_LANES = ["Open", "Search", "Browse", "Add", "Create", "Ask", "Go to"];

  it("renders the seven lane chips inside a role=group labelled Lanes, all unpressed at rest", async () => {
    await openDialog();
    const group = screen.getByRole("group", { name: "Lanes" });
    const chips = within(group).getAllByRole("button");

    expect(chips).toHaveLength(7);
    expect(chips.map((c) => c.textContent)).toEqual(ALL_LANES);
    for (const chip of chips) {
      expect(chip).toHaveAttribute("aria-pressed", "false");
    }
  });

  it("clicking a sigil-lane chip (Open) presses it and shows the lane indicator in the input", async () => {
    await openDialog();

    fireEvent.click(laneChip("Open"));

    expect(laneChip("Open")).toHaveAttribute("aria-pressed", "true");
    // Sibling chips stay unpressed — exactly one lane is active.
    expect(laneChip("Search")).toHaveAttribute("aria-pressed", "false");
    // The input row surfaces the active lane as a chip indicator ("Open ›").
    expect(screen.getByText("Open ›")).toBeInTheDocument();
  });

  it("clicking a sigil-less lane chip (Go to) presses it", async () => {
    await openDialog();

    fireEvent.click(laneChip("Go to"));

    expect(laneChip("Go to")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Go to ›")).toBeInTheDocument();
  });

  it("clicking the active chip again clears back to the blended (all) view", async () => {
    await openDialog();

    fireEvent.click(laneChip("Open"));
    expect(laneChip("Open")).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(laneChip("Open"));
    expect(laneChip("Open")).toHaveAttribute("aria-pressed", "false");
    // No lane indicator once cleared.
    expect(screen.queryByText("Open ›")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Sigil legend (typing "?" alone)
// ---------------------------------------------------------------------------

describe("Launcher — sigil legend", () => {
  it("shows the sigil reference rows when the input is exactly '?'", async () => {
    await openDialog();
    const input = screen.getByRole("combobox", { name: "Search, add, or ask" });

    await userEvent.click(input);
    await userEvent.type(input, "?");

    // The four sigil reference rows render as a legend under the input.
    expect(await screen.findByText("Go to commands")).toBeInTheDocument();
    expect(screen.getByText("Open existing")).toBeInTheDocument();
    expect(screen.getByText("Ask AI")).toBeInTheDocument();
    expect(screen.getByText("Add content")).toBeInTheDocument();

    // The glyph keys are present in the legend.
    const glyphs = screen.getAllByText((_, node) => node?.tagName === "KBD").map((n) => n.textContent);
    expect(glyphs).toEqual(expect.arrayContaining([">", "@", "?", "+"]));
  });

  it("does not show the legend once free text follows the '?' sigil", async () => {
    await openDialog();
    const input = screen.getByRole("combobox", { name: "Search, add, or ask" });

    await userEvent.click(input);
    await userEvent.type(input, "?how do I");

    expect(screen.queryByText("Go to commands")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// URL paste → "Add <host> to library" hard-signal row on top
// ---------------------------------------------------------------------------

describe("Launcher — bare URL hard signal", () => {
  it("surfaces an 'Add <host> to library' row as the top option when the input is a bare URL", async () => {
    await openDialog();
    const input = screen.getByRole("combobox", { name: "Search, add, or ask" });

    await userEvent.click(input);
    // type() would treat "[" etc specially, but a plain URL has none of those chars.
    await userEvent.type(input, "https://example.com/article");

    const listbox = await screen.findByRole("listbox");
    const addRow = await within(listbox).findByRole("option", { name: /Add example\.com to library/i });
    expect(addRow).toBeInTheDocument();
    // Hard signal ⇒ it ranks first in the querying list.
    expect(within(listbox).getAllByRole("option")[0]).toBe(addRow);
  });
});

// ---------------------------------------------------------------------------
// Embedded feature panels push inside the same dialog (spec §8.2 / §8.3)
// ---------------------------------------------------------------------------

describe("Launcher — embedded panels", () => {
  it("selecting 'Add from URL…' pushes the AddPanel inside the same Launcher dialog with a Back affordance", async () => {
    // Open on the add lane so the add rows are front-and-center.
    await openDialog({ lane: "add" });

    const addFromUrl = await screen.findByRole("option", { name: /Add from URL/i });
    await userEvent.click(addFromUrl);

    // The dialog stays mounted; the root list is replaced by the AddPanel content.
    const dialog = screen.getByRole("dialog", { name: "Launcher" });
    expect(within(dialog).getByRole("heading", { name: "Add content" })).toBeInTheDocument();
    const back = within(dialog).getByRole("button", { name: "Back" });
    expect(back).toBeInTheDocument();
    // The root omni-input is gone while the panel is open.
    expect(screen.queryByRole("combobox", { name: "Search, add, or ask" })).not.toBeInTheDocument();

    // Back returns to the root list (the omni-input + lane chips reappear).
    await userEvent.click(back);
    expect(await screen.findByRole("combobox", { name: "Search, add, or ask" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Lanes" })).toBeInTheDocument();
  });

  it("selecting 'Create note…' pushes the CreatePanel inside the same dialog and Escape pops back to the root list", async () => {
    await openDialog({ lane: "create" });

    const createNote = await screen.findByRole("option", { name: /Create note/i });
    await userEvent.click(createNote);

    const dialog = screen.getByRole("dialog", { name: "Launcher" });
    // CreatePanel shows the quick-note editor + a "New note" back header.
    expect(await within(dialog).findByRole("button", { name: "New note" })).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: "Quick note to today" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Search, add, or ask" })).not.toBeInTheDocument();

    // Escape on a sub-page pops one level (back to root), it does not dismiss the launcher.
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Launcher" })).toBeInTheDocument();
    expect(await screen.findByRole("combobox", { name: "Search, add, or ask" })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Prefetch-on-intent: hovering / arrow-keying a row (both call setActiveId) warms the
// destination pane when the row has a pre-known pane (href / route-resource); create/ask/
// external rows have no pane and must not warm. preloadPane is the asserted warm signal.
// ---------------------------------------------------------------------------

describe("Launcher — prefetch-on-intent", () => {
  afterEach(() => {
    preloadPane.mockClear();
  });

  it("warms the destination pane when hovering an in-app go-to row", async () => {
    await openDialog({ lane: "go" });

    // The "Libraries" destination is an href row (/libraries, not externalShell).
    const libraries = await screen.findByRole("option", { name: /Libraries/i });
    fireEvent.mouseMove(libraries);

    // Hover is intent for the imminent Enter — the libraries pane's chunk warms immediately.
    expect(preloadPane).toHaveBeenCalledWith("libraries");
  });

  it("does not warm a pane for a Create row (no destination pane)", async () => {
    await openDialog({ lane: "create" });

    // "Create note" dispatches kind:"create-page" — no href, no pre-known pane.
    const createNote = await screen.findByRole("option", { name: /Create note/i });
    fireEvent.mouseMove(createNote);

    expect(preloadPane).not.toHaveBeenCalled();
  });

  it("does not warm a pane for the externalShell Oracle row", async () => {
    await openDialog({ lane: "go" });

    // Oracle is a full-shell destination (externalShell:true) — the launcher must not
    // warm a pane for it even though it is an href row.
    const oracle = await screen.findByRole("option", { name: /Oracle/i });
    fireEvent.mouseMove(oracle);

    expect(preloadPane).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// set-lane: selecting "Browse the web for X" switches lane in-place (spec §14)
// ---------------------------------------------------------------------------

describe("Launcher — set-lane target", () => {
  it("selecting 'Browse the web for X' switches to the browse lane with the query seeded, Launcher stays open", async () => {
    await openDialog();
    const input = screen.getByRole("combobox", { name: "Search, add, or ask" });

    await userEvent.click(input);
    await userEvent.type(input, "quantum");

    const browseRow = await screen.findByRole("option", { name: /Browse the web for "quantum"/i });
    fireEvent.click(browseRow);

    // The dialog stays open — set-lane never closes the launcher.
    expect(screen.getByRole("dialog", { name: "Launcher" })).toBeInTheDocument();
    // The Browse lane chip is now active.
    expect(laneChip("Browse")).toHaveAttribute("aria-pressed", "true");
    // The query is preserved in the input.
    expect(screen.getByRole("combobox", { name: "Search, add, or ask" })).toHaveValue("quantum");
  });
});

// ---------------------------------------------------------------------------
// URL-param lane seed: ?launcher=1&lane=<x>&q=<q> (spec §14)
// ---------------------------------------------------------------------------

describe("Launcher — URL-param lane seed", () => {
  it("opens on the browse lane with the query seeded when ?launcher=1&lane=browse&q=kafka", async () => {
    window.history.replaceState({}, "", "/?launcher=1&lane=browse&q=kafka");
    renderLauncher();

    // The controller's mount effect fires and opens the dialog automatically.
    const dialog = await screen.findByRole("dialog", { name: "Launcher" });
    expect(dialog).toBeInTheDocument();
    expect(laneChip("Browse")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("combobox", { name: "Search, add, or ask" })).toHaveValue("kafka");
  });

  it("falls back to the blended (all) view when ?lane=invalid", async () => {
    window.history.replaceState({}, "", "/?launcher=1&lane=invalid&q=foo");
    renderLauncher();

    await screen.findByRole("dialog", { name: "Launcher" });
    // No lane chip pressed — falls back to 'all'.
    const group = screen.getByRole("group", { name: "Lanes" });
    const chips = within(group).getAllByRole("button");
    for (const chip of chips) {
      expect(chip).toHaveAttribute("aria-pressed", "false");
    }
    expect(screen.getByRole("combobox", { name: "Search, add, or ask" })).toHaveValue("foo");
  });
});
