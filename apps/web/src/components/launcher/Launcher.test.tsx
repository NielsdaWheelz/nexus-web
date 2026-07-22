/**
 * Launcher — desktop surface DOM/interaction tests (S8, spec §15).
 *
 * Real Chromium, real providers, fetch boundary stubbed (the controller fetches
 * recents/oracle/search on open). These focus on the UI contract the e2e + the
 * pure provider/ranking unit tests do NOT cover: the lane-chip row, the sigil
 * legend, the bare-URL hard-signal row, and the embedded Add/Create panels that
 * push inside the same dialog. No vi.mock of internal modules.
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { createDefaultWorkspaceState } from "@/lib/workspace/schema";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";

const workspacePrimaryMetrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

// Drive the responsive shell independently of the headless Chromium width. Most tests
// stay on desktop; the returned controller lets the continuity test publish real media
// query changes through RenderEnvironmentProvider.
function mockMatchMedia(mobile: boolean) {
  const listeners = new Set<EventListenerOrEventListenerObject>();
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        get matches() {
          return query.includes("max-width") ? mobile : false;
        },
        media: query,
        onchange: null,
        addEventListener(
          _event: string,
          listener: EventListenerOrEventListenerObject,
        ) {
          if (query.includes("max-width")) listeners.add(listener);
        },
        removeEventListener(
          _event: string,
          listener: EventListenerOrEventListenerObject,
        ) {
          listeners.delete(listener);
        },
        addListener(listener: EventListenerOrEventListenerObject) {
          if (query.includes("max-width")) listeners.add(listener);
        },
        removeListener(listener: EventListenerOrEventListenerObject) {
          listeners.delete(listener);
        },
        dispatchEvent() {
          return false;
        },
      }) as MediaQueryList,
  );
  return {
    setMobile(next: boolean) {
      mobile = next;
      const event = new Event("change");
      for (const listener of listeners) {
        if (typeof listener === "function") listener(event);
        else listener.handleEvent(event);
      }
    },
  };
}

let viewport: ReturnType<typeof mockMatchMedia>;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

let handleFromUrlRequest:
  | ((init: RequestInit | undefined) => Promise<Response>)
  | null = null;
let handleMediaRequest:
  | ((url: URL, init: RequestInit | undefined) => Promise<Response>)
  | null = null;

function deferFromUrlRequest() {
  let signal: AbortSignal | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  handleFromUrlRequest = async (init) => {
    signal = init?.signal ?? undefined;
    markStarted();
    return new Promise<Response>((_resolve, reject) => {
      const rejectAbort = () =>
        reject(new DOMException("The request was aborted.", "AbortError"));
      if (signal?.aborted) rejectAbort();
      else signal?.addEventListener("abort", rejectAbort, { once: true });
    });
  };
  return {
    started,
    get signal() {
      return signal;
    },
  };
}

function mockApi() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/me/palette-history") {
        return jsonResponse({ data: { recent: [], frecency_boosts: {} } });
      }
      if (
        url.pathname === "/api/me/palette-selections" &&
        init?.method === "POST"
      ) {
        return jsonResponse({ data: null });
      }
      if (url.pathname === "/api/oracle/readings")
        return jsonResponse({ data: [] });
      // The Launcher now renders inside a LecternProvider (useLectern → dispatch's
      // queue-add owner), which fires one reconciliation GET on mount.
      if (url.pathname === "/api/lectern")
        return jsonResponse({ data: { items: [] } });
      if (url.pathname === "/api/search") {
        return jsonResponse({
          results: [],
          page: { has_more: false, next_cursor: null },
        });
      }
      if (url.pathname === "/api/browse")
        return jsonResponse({ data: { sections: {} } });
      if (url.pathname === "/api/web/search")
        return jsonResponse({ data: { results: [] } });
      if (url.pathname === "/api/libraries/writable-destinations") {
        return jsonResponse({
          data: [],
          page: { has_more: false, next_cursor: null },
        });
      }
      if (url.pathname === "/api/media/from-url" && handleFromUrlRequest) {
        return handleFromUrlRequest(init);
      }
      if (handleMediaRequest) return handleMediaRequest(url, init);
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
            initialState={createDefaultWorkspaceState(
              "/libraries",
              workspacePrimaryMetrics,
            )}
          >
            <LecternProvider>
              <Launcher />
            </LecternProvider>
          </WorkspaceStoreProvider>
        </FeedbackProvider>
      </KeybindingsProvider>,
    ),
  );
}

// Render an opener button alongside the Launcher so return-focus has a real trigger
// to restore to (or deliberately not, on a navigating dispatch).
function renderLauncherWithOpener() {
  return render(
    withRenderEnvironment(
      <KeybindingsProvider>
        <FeedbackProvider>
          <WorkspaceStoreProvider
            workspacePrimaryMetrics={workspacePrimaryMetrics}
            initialState={createDefaultWorkspaceState(
              "/libraries",
              workspacePrimaryMetrics,
            )}
          >
            <LecternProvider>
              <button type="button" data-testid="launcher-opener">
                Opener
              </button>
              <Launcher />
            </LecternProvider>
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
  return within(screen.getByRole("group", { name: "Lanes" })).getByRole(
    "button",
    { name },
  );
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, "", "/libraries");
  vi.stubGlobal("innerWidth", 1280); // desktop surface
  handleFromUrlRequest = null;
  handleMediaRequest = null;
  viewport = mockMatchMedia(false);
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
  const ALL_LANES = ["Open", "Search", "Browse", "Create", "Ask", "Go to"];

  it("renders the six lane chips inside a role=group labelled Lanes, all unpressed at rest", async () => {
    await openDialog();
    const group = screen.getByRole("group", { name: "Lanes" });
    const chips = within(group).getAllByRole("button");

    expect(chips).toHaveLength(6);
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
    expect(screen.queryByText("Add content")).not.toBeInTheDocument();

    // The glyph keys are present in the legend.
    const glyphs = screen
      .getAllByText((_, node) => node?.tagName === "KBD")
      .map((n) => n.textContent);
    expect(glyphs).toEqual(expect.arrayContaining([">", "@", "?"]));
    expect(glyphs).not.toContain("+");
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
    const addRow = await within(listbox).findByRole("option", {
      name: /Add example\.com to library/i,
    });
    expect(addRow).toBeInTheDocument();
    // Hard signal ⇒ it ranks first in the querying list.
    expect(within(listbox).getAllByRole("option")[0]).toBe(addRow);
  });
});

// ---------------------------------------------------------------------------
// Embedded feature panels push inside the same dialog (spec §8.2 / §8.3)
// ---------------------------------------------------------------------------

describe("Launcher — embedded panels", () => {
  it("opens Add content directly from tagged intent and clean Back returns to Launcher root", async () => {
    renderLauncher();
    open({
      kind: "Add",
      seed: { kind: "Content", initialFocus: "Url", initialDestinations: [] },
    });

    const dialog = await screen.findByRole("dialog", { name: "Add content" });
    expect(
      within(dialog).getByRole("heading", { name: "Add content" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(dialog).getByRole("textbox", { name: "Links" }),
      ).toHaveFocus(),
    );
    const back = within(dialog).getByRole("button", { name: "Back" });
    expect(back).toBeInTheDocument();
    // The root omni-input is gone while the panel is open.
    expect(
      screen.queryByRole("combobox", { name: "Search, add, or ask" }),
    ).not.toBeInTheDocument();

    // Back returns to the root list (the omni-input + lane chips reappear).
    await userEvent.click(back);
    expect(
      await screen.findByRole("combobox", { name: "Search, add, or ask" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Lanes" })).toBeInTheDocument();
  });

  it("guards dirty Add dismissal and Keep working restores the workbench", async () => {
    renderLauncher();
    open({
      kind: "Add",
      seed: { kind: "Content", initialFocus: "Url", initialDestinations: [] },
    });
    const links = await screen.findByRole("textbox", { name: "Links" });
    fireEvent.change(links, { target: { value: "https://example.com/draft" } });

    await userEvent.keyboard("{Escape}");

    const confirmation = await screen.findByRole("dialog", {
      name: "Discard unfinished work?",
    });
    expect(
      screen.getByRole("dialog", { name: "Add content" }),
    ).toBeInTheDocument();
    await userEvent.click(
      within(confirmation).getByRole("button", { name: "Keep working" }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Discard unfinished work?" }),
    ).not.toBeInTheDocument();
    expect(links).toHaveValue("https://example.com/draft");
  });

  it("guards dirty Add before an external open event replaces it", async () => {
    renderLauncher();
    open({
      kind: "Add",
      seed: { kind: "Content", initialFocus: "Url", initialDestinations: [] },
    });
    const links = await screen.findByRole("textbox", { name: "Links" });
    fireEvent.change(links, {
      target: { value: "https://example.com/keep-me" },
    });

    open({ kind: "Root", lane: "go" });

    const confirmation = await screen.findByRole("dialog", {
      name: "Discard unfinished work?",
    });
    expect(links).toHaveValue("https://example.com/keep-me");
    await userEvent.click(
      within(confirmation).getByRole("button", { name: "Discard" }),
    );

    expect(
      await screen.findByRole("dialog", { name: "Launcher" }),
    ).toBeInTheDocument();
    expect(laneChip("Go to")).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.queryByRole("textbox", { name: "Links" }),
    ).not.toBeInTheDocument();
  });

  it("returns idle OPML to Content and normalizes focus to Links", async () => {
    renderLauncher();
    open({ kind: "Add", seed: { kind: "Opml", initialDestinations: [] } });
    const opmlDialog = await screen.findByRole("dialog", {
      name: "Import OPML",
    });

    await userEvent.click(
      within(opmlDialog).getByRole("button", { name: "Back" }),
    );

    const contentDialog = await screen.findByRole("dialog", {
      name: "Add content",
    });
    await waitFor(() =>
      expect(
        within(contentDialog).getByRole("textbox", { name: "Links" }),
      ).toHaveFocus(),
    );
  });

  it("honors a direct File focus seed without adding a chooser step", async () => {
    renderLauncher();
    open({
      kind: "Add",
      seed: { kind: "Content", initialFocus: "File", initialDestinations: [] },
    });
    const dialog = await screen.findByRole("dialog", { name: "Add content" });

    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Choose PDF or EPUB" }),
      ).toHaveFocus(),
    );
  });

  it("remounts panel-local state for a clean Add-to-Add replacement", async () => {
    renderLauncher();
    open({
      kind: "Add",
      seed: { kind: "Content", initialFocus: "Url", initialDestinations: [] },
    });
    const firstDialog = await screen.findByRole("dialog", {
      name: "Add content",
    });
    const libraries = within(firstDialog).getByRole("button", {
      name: /Libraries My Library only Change/,
    });
    await userEvent.click(libraries);
    expect(
      await within(firstDialog).findByRole("combobox", {
        name: "Libraries",
      }),
    ).toBeInTheDocument();
    expect(libraries).toHaveAttribute("aria-expanded", "true");

    open({
      kind: "Add",
      seed: { kind: "Content", initialFocus: "File", initialDestinations: [] },
    });

    const replacement = screen.getByRole("dialog", { name: "Add content" });
    await waitFor(() =>
      expect(
        within(replacement).getByRole("button", { name: "Choose PDF or EPUB" }),
      ).toHaveFocus(),
    );
    expect(
      within(replacement).getByRole("button", {
        name: /Libraries My Library only Change/,
      }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      within(replacement).queryByRole("combobox", {
        name: "Libraries",
      }),
    ).not.toBeInTheDocument();
  });

  it("preserves Add work across desktop-mobile-desktop shell remounts", async () => {
    renderLauncher();
    open({
      kind: "Add",
      seed: { kind: "Content", initialFocus: "Url", initialDestinations: [] },
    });

    const desktopDialog = await screen.findByRole("dialog", {
      name: "Add content",
    });
    const draftUrl = "https://example.com/unreviewed";
    fireEvent.change(
      within(desktopDialog).getByRole("textbox", { name: "Links" }),
      {
        target: { value: draftUrl },
      },
    );
    fireEvent.change(
      within(desktopDialog).getByLabelText("Choose PDF or EPUB files"),
      {
        target: {
          files: [
            new File(["%PDF-1.7"], "paper.pdf", { type: "application/pdf" }),
          ],
        },
      },
    );
    expect(
      await within(desktopDialog).findByText("paper.pdf"),
    ).toBeInTheDocument();

    act(() => viewport.setMobile(true));
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Add content" })).not.toBe(
        desktopDialog,
      ),
    );
    const mobileDialog = screen.getByRole("dialog", { name: "Add content" });
    await waitFor(() =>
      expect(
        within(mobileDialog).getByRole("heading", { name: "Add content" }),
      ).toHaveFocus(),
    );
    expect(
      within(mobileDialog).getByRole("textbox", { name: "Links" }),
    ).toHaveValue(draftUrl);
    expect(
      within(mobileDialog).getByLabelText("Items to add"),
    ).toHaveTextContent("paper.pdf");

    act(() => viewport.setMobile(false));
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Add content" })).not.toBe(
        mobileDialog,
      ),
    );
    const restoredDesktopDialog = screen.getByRole("dialog", {
      name: "Add content",
    });
    await waitFor(() =>
      expect(
        within(restoredDesktopDialog).getByRole("textbox", { name: "Links" }),
      ).toHaveFocus(),
    );
    expect(
      within(restoredDesktopDialog).getByRole("textbox", { name: "Links" }),
    ).toHaveValue(draftUrl);
    expect(
      within(restoredDesktopDialog).getByLabelText("Items to add"),
    ).toHaveTextContent("paper.pdf");
  });

  it("restores staged-only Add focus through the panel-owned fallback after viewport remounts", async () => {
    renderLauncher();
    open({
      kind: "Add",
      seed: { kind: "Content", initialFocus: "Url", initialDestinations: [] },
    });
    const desktopDialog = await screen.findByRole("dialog", {
      name: "Add content",
    });
    fireEvent.change(
      within(desktopDialog).getByLabelText("Choose PDF or EPUB files"),
      {
        target: {
          files: [
            new File(["%PDF-1.7"], "staged-only.pdf", {
              type: "application/pdf",
            }),
          ],
        },
      },
    );
    expect(
      await within(desktopDialog).findByText("staged-only.pdf"),
    ).toBeInTheDocument();
    expect(
      within(desktopDialog).queryByRole("textbox", { name: "Links" }),
    ).not.toBeInTheDocument();

    act(() => viewport.setMobile(true));
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Add content" })).not.toBe(
        desktopDialog,
      ),
    );
    const mobileDialog = screen.getByRole("dialog", { name: "Add content" });
    await waitFor(() =>
      expect(
        within(mobileDialog).getByRole("heading", { name: "Add content" }),
      ).toHaveFocus(),
    );

    act(() => viewport.setMobile(false));
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Add content" })).not.toBe(
        mobileDialog,
      ),
    );
    const restoredDesktopDialog = screen.getByRole("dialog", {
      name: "Add content",
    });
    await waitFor(() =>
      expect(
        within(restoredDesktopDialog).getByLabelText("Items to add"),
      ).toHaveFocus(),
    );
    expect(
      within(restoredDesktopDialog).getByRole("button", { name: "Add more" }),
    ).toBeInTheDocument();
  });

  it("stops and aborts an active Add request before closing", async () => {
    const request = deferFromUrlRequest();

    renderLauncher();
    open({
      kind: "Add",
      seed: { kind: "Content", initialFocus: "Url", initialDestinations: [] },
    });
    const dialog = await screen.findByRole("dialog", { name: "Add content" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Links" }), {
      target: { value: "https://example.com/deferred" },
    });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Review links" }),
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Add 1 item" }),
    );
    await request.started;

    expect(request.signal?.aborted).toBe(false);
    expect(
      within(dialog).getByRole("button", { name: "Add more" }),
    ).toBeDisabled();
    expect(within(dialog).getByRole("button", { busy: true })).toBeDisabled();
    await waitFor(() => {
      const event = new Event("beforeunload", { cancelable: true });
      expect(window.dispatchEvent(event)).toBe(false);
      expect(event.defaultPrevented).toBe(true);
    });

    await userEvent.click(
      within(dialog).getByRole("button", { name: "Close Add content" }),
    );
    const confirmation = await screen.findByRole("dialog", {
      name: "Stop active work?",
    });
    await userEvent.click(
      within(confirmation).getByRole("button", { name: "Stop and close" }),
    );

    expect(request.signal?.aborted).toBe(true);
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Add content" }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() => {
      const event = new Event("beforeunload", { cancelable: true });
      expect(window.dispatchEvent(event)).toBe(true);
      expect(event.defaultPrevented).toBe(false);
    });
  });

  it("guards an active Add request before a global destination shortcut navigates", async () => {
    localStorage.setItem(
      "nexus.keybindings.v1",
      JSON.stringify({ libraries: "Meta+l" }),
    );
    const request = deferFromUrlRequest();
    renderLauncher();
    open({
      kind: "Add",
      seed: { kind: "Content", initialFocus: "Url", initialDestinations: [] },
    });
    const dialog = await screen.findByRole("dialog", { name: "Add content" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Links" }), {
      target: { value: "https://example.com/deferred-shortcut" },
    });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Review links" }),
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Add 1 item" }),
    );
    await request.started;

    fireEvent.keyDown(document, { key: "l", metaKey: true });

    const confirmation = await screen.findByRole("dialog", {
      name: "Stop active work?",
    });
    expect(dialog).toBeInTheDocument();
    expect(request.signal?.aborted).toBe(false);
    await userEvent.click(
      within(confirmation).getByRole("button", { name: "Stop and close" }),
    );

    expect(request.signal?.aborted).toBe(true);
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Add content" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("keeps a pre-identity defect inside the mobile Add history gateway and retries with the same key", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const idempotencyKeys: string[] = [];
    let calls = 0;
    handleFromUrlRequest = async (init) => {
      calls += 1;
      idempotencyKeys.push(
        new Headers(init?.headers).get("Idempotency-Key") ?? "",
      );
      if (calls === 1) return jsonResponse({ data: {} });
      return jsonResponse({
        data: {
          media_id: "media-retried",
          source_attempt_id: "attempt-retried",
          source_type: "generic_web_url",
          source_attempt_status: "queued",
          idempotency_outcome: "reused",
          processing_status: "pending",
          ingest_enqueued: true,
        },
      });
    };

    try {
      act(() => viewport.setMobile(true));
      renderLauncher();
      open({
        kind: "Add",
        seed: { kind: "Content", initialFocus: "Url", initialDestinations: [] },
      });
      const dialog = await screen.findByRole("dialog", { name: "Add content" });
      fireEvent.change(within(dialog).getByRole("textbox", { name: "Links" }), {
        target: { value: "https://example.com/defect" },
      });
      await userEvent.click(
        within(dialog).getByRole("button", { name: "Review links" }),
      );
      await userEvent.click(
        within(dialog).getByRole("button", { name: "Add 1 item" }),
      );

      const fallback = await screen.findByRole("dialog", {
        name: "Add needs attention",
      });
      expect(
        within(fallback).getByRole("button", { name: "Continue Add" }),
      ).toHaveFocus();

      act(() => window.history.back());
      const confirmation = await screen.findByRole("dialog", {
        name: "Discard unfinished work?",
      });
      await userEvent.click(
        within(confirmation).getByRole("button", { name: "Keep working" }),
      );
      await userEvent.click(
        within(fallback).getByRole("button", { name: "Continue Add" }),
      );

      const restored = await screen.findByRole("dialog", {
        name: "Add content",
      });
      expect(within(restored).getByLabelText("Items to add")).toHaveTextContent(
        "https://example.com/defect",
      );
      await userEvent.click(
        within(restored).getByRole("button", { name: "Add 1 item" }),
      );
      await waitFor(() =>
        expect(
          within(restored).getByText("Already in Nexus · processing"),
        ).toBeInTheDocument(),
      );
      expect(idempotencyKeys).toHaveLength(2);
      expect(idempotencyKeys[0]).not.toBe("");
      expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("stops a known-identity defect and clears an already-open Stop confirmation", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    let rejectUpload!: (error: unknown) => void;
    let markUploadStarted!: () => void;
    const uploadStarted = new Promise<void>((resolve) => {
      markUploadStarted = resolve;
    });
    handleMediaRequest = async (url) => {
      if (url.pathname === "/api/media/upload/init") {
        return jsonResponse({
          data: {
            media_id: "media-known",
            source_attempt_id: "attempt-known",
            source_type: "upload",
            source_attempt_status: "accepted",
            idempotency_outcome: "created",
            processing_status: "pending",
            ingest_enqueued: false,
            upload_url: "https://uploads.example/known.pdf",
            expires_at: "2026-01-01T00:00:00Z",
          },
        });
      }
      if (url.href === "https://uploads.example/known.pdf") {
        markUploadStarted();
        return new Promise<Response>((_resolve, reject) => {
          rejectUpload = reject;
        });
      }
      throw new Error(`Unexpected fetch: ${url.href}`);
    };

    try {
      renderLauncher();
      open({
        kind: "Add",
        seed: {
          kind: "Content",
          initialFocus: "File",
          initialDestinations: [],
        },
      });
      const dialog = await screen.findByRole("dialog", { name: "Add content" });
      fireEvent.change(
        within(dialog).getByLabelText("Choose PDF or EPUB files"),
        {
          target: {
            files: [
              new File(["%PDF-1.7"], "known.pdf", {
                type: "application/pdf",
              }),
            ],
          },
        },
      );
      await userEvent.click(
        within(dialog).getByRole("button", { name: "Add 1 item" }),
      );
      await uploadStarted;
      await userEvent.click(
        within(dialog).getByRole("button", { name: "Close Add content" }),
      );
      await screen.findByRole("dialog", { name: "Stop active work?" });

      act(() => rejectUpload(new Error("unclassified PUT failure")));
      const fallback = await screen.findByRole("dialog", {
        name: "Add needs attention",
      });
      const confirmation = screen.getByRole("dialog", {
        name: "Stop active work?",
      });
      await userEvent.click(
        within(confirmation).getByRole("button", { name: "Keep working" }),
      );
      await userEvent.click(
        within(fallback).getByRole("button", {
          name: "Stop and review status",
        }),
      );

      const restored = await screen.findByRole("dialog", {
        name: "Add content",
      });
      expect(
        within(restored).getByText("Saved · status unknown"),
      ).toBeInTheDocument();
      expect(
        within(restored).getByRole("button", { name: "Remove known.pdf" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("dialog", { name: "Stop active work?" }),
      ).not.toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("selecting 'Create note…' pushes the CreatePanel inside the same dialog and Escape pops back to the root list", async () => {
    await openDialog({ kind: "Root", lane: "create" });

    const createNote = await screen.findByRole("option", {
      name: /Create note/i,
    });
    await userEvent.click(createNote);

    const dialog = screen.getByRole("dialog", { name: "Launcher" });
    // CreatePanel shows the quick-note editor + a "New note" back header.
    expect(
      await within(dialog).findByRole("button", { name: "New note" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("textbox", { name: "Quick note to today" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Search, add, or ask" }),
    ).not.toBeInTheDocument();

    // Escape on a sub-page pops one level (back to root), it does not dismiss the launcher.
    await userEvent.keyboard("{Escape}");
    expect(
      screen.getByRole("dialog", { name: "Launcher" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("combobox", { name: "Search, add, or ask" }),
    ).toBeInTheDocument();
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
    await openDialog({ kind: "Root", lane: "go" });

    // The "Libraries" destination is an href row (/libraries, not externalShell).
    const libraries = await screen.findByRole("option", { name: /Libraries/i });
    fireEvent.mouseMove(libraries);

    // Hover is intent for the imminent Enter — the libraries pane's chunk warms immediately.
    expect(preloadPane).toHaveBeenCalledWith("libraries");
  });

  it("does not warm a pane for a Create row (no destination pane)", async () => {
    await openDialog({ kind: "Root", lane: "create" });

    // "Create note" dispatches kind:"create-page" — no href, no pre-known pane.
    const createNote = await screen.findByRole("option", {
      name: /Create note/i,
    });
    fireEvent.mouseMove(createNote);

    expect(preloadPane).not.toHaveBeenCalled();
  });

  it("warms oracle pane on hover after shell dissolution", async () => {
    await openDialog({ kind: "Root", lane: "go" });

    // Oracle is now a regular pane destination (externalShell:false) — hovering
    // it should warm the oracle pane chunk.
    const oracle = await screen.findByRole("option", { name: /Oracle/i });
    fireEvent.mouseMove(oracle);

    expect(preloadPane).toHaveBeenCalledWith("oracle");
  });
});

// ---------------------------------------------------------------------------
// Return-focus: a navigating dispatch must not yank focus back to the opener (it
// fights the destination it just navigated to); dismissal keeps the a11y contract.
// ---------------------------------------------------------------------------

describe("Launcher — return-focus on close", () => {
  it("does NOT restore opener focus after a navigating command", async () => {
    renderLauncherWithOpener();
    const opener = screen.getByTestId("launcher-opener");
    opener.focus();
    expect(opener).toHaveFocus();

    open({ kind: "Root", lane: "go" });
    const dialog = await screen.findByRole("dialog", { name: "Launcher" });
    const combobox = within(dialog).getByRole("combobox", {
      name: "Search, add, or ask",
    });
    // Initial focus moves into the box — this is the moment the opener is captured.
    await waitFor(() => expect(combobox).toHaveFocus());

    // "Libraries" is an in-app href row: selecting it navigates and closes.
    await userEvent.click(
      await within(dialog).findByRole("option", { name: /Libraries/i }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Launcher" }),
      ).not.toBeInTheDocument(),
    );
    // Focus was released to the destination, not restored to the opener.
    expect(opener).not.toHaveFocus();
  });

  it("restores opener focus on Escape (dismissal is unchanged)", async () => {
    renderLauncherWithOpener();
    const opener = screen.getByTestId("launcher-opener");
    opener.focus();

    open({ kind: "Root", lane: "go" });
    const dialog = await screen.findByRole("dialog", { name: "Launcher" });
    const combobox = within(dialog).getByRole("combobox", {
      name: "Search, add, or ask",
    });
    await waitFor(() => expect(combobox).toHaveFocus());

    await userEvent.keyboard("{Escape}");

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Launcher" }),
      ).not.toBeInTheDocument(),
    );
    expect(opener).toHaveFocus();
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

    const browseRow = await screen.findByRole("option", {
      name: /Browse the web for "quantum"/i,
    });
    fireEvent.click(browseRow);

    // The dialog stays open — set-lane never closes the launcher.
    expect(
      screen.getByRole("dialog", { name: "Launcher" }),
    ).toBeInTheDocument();
    // The Browse lane chip is now active.
    expect(laneChip("Browse")).toHaveAttribute("aria-pressed", "true");
    // The query is preserved in the input.
    expect(
      screen.getByRole("combobox", { name: "Search, add, or ask" }),
    ).toHaveValue("quantum");
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
    expect(
      screen.getByRole("combobox", { name: "Search, add, or ask" }),
    ).toHaveValue("kafka");
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
    expect(
      screen.getByRole("combobox", { name: "Search, add, or ask" }),
    ).toHaveValue("foo");
  });
});
