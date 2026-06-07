/**
 * Android-shell gating — command palette integration.
 *
 * Verifies that recent-history entries whose href maps to an Android-restricted
 * route (e.g. /settings/local-vault → routeId "settingsLocalVault") are
 * silently dropped from the palette when running inside the Android shell,
 * while non-restricted recents (e.g. /settings/billing) are still shown.
 *
 * Uses REAL providers — no vi.mock of internal modules.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import CommandPalette from "@/components/palette/CommandPalette";
import { OPEN_COMMAND_PALETTE_EVENT } from "@/components/commandPaletteEvents";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { createDefaultWorkspaceState } from "@/lib/workspace/schema";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";

// ---------------------------------------------------------------------------
// Helpers (mirrors CommandPalette.test.tsx)
// ---------------------------------------------------------------------------

const workspacePrimaryMetrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

function mockApi(
  recents: {
    target_key: string;
    target_href: string;
    title_snapshot: string;
    last_used_at: string;
  }[] = [],
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/me/palette-history") {
      return jsonResponse({
        data: {
          recent: recents.map((row) => ({
            ...row,
            target_kind: "href",
            source: "recent",
          })),
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
    withRenderEnvironment(
      <KeybindingsProvider>
        <FeedbackProvider>
          <WorkspaceStoreProvider
            workspacePrimaryMetrics={workspacePrimaryMetrics}
            initialState={createDefaultWorkspaceState("/libraries", workspacePrimaryMetrics)}
          >
            <CommandPalette />
          </WorkspaceStoreProvider>
        </FeedbackProvider>
      </KeybindingsProvider>,
      { androidShell: true },
    ),
  );
}

function open() {
  act(() => window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT)));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

const RECENTS = [
  {
    target_key: "/settings/local-vault",
    target_href: "/settings/local-vault",
    title_snapshot: "Local Vault",
    last_used_at: "2026-06-01T00:00:00Z",
  },
  {
    target_key: "/settings/billing",
    target_href: "/settings/billing",
    title_snapshot: "Billing",
    last_used_at: "2026-06-01T00:00:00Z",
  },
];

describe("Android-shell gating — command palette recents", () => {
  beforeEach(() => {
    vi.stubGlobal("innerWidth", 1280); // desktop surface
    localStorage.clear();
    window.history.replaceState({}, "", "/libraries");
    mockApi(RECENTS);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("hides restricted /settings/local-vault recent and shows non-restricted /settings/billing recent", async () => {
    renderPalette();
    open();

    // Wait until the palette is visible and the recents have been fetched.
    await screen.findByRole("dialog", { name: "Command palette" });

    // "Billing" should be present in the list.
    await waitFor(() => {
      expect(
        screen.getByRole("option", { name: /Billing/i }),
      ).toBeInTheDocument();
    });

    // "Local Vault" must be absent — it maps to the Android-restricted routeId.
    expect(
      screen.queryByRole("option", { name: /Local Vault/i }),
    ).toBeNull();
  });
});
