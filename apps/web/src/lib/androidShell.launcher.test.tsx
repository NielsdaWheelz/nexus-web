/**
 * Android-shell gating — launcher integration.
 *
 * Verifies that recent-history entries whose href maps to an Android-restricted
 * route (e.g. /settings/local-vault → routeId "settingsLocalVault") are silently
 * dropped from the launcher when running inside the Android shell, while
 * non-restricted recents (e.g. /settings/billing) are still shown. This is the
 * Launcher equivalent of the old command-palette android guard; the pure
 * item-filtering matrix is additionally covered by lib/launcher/providers.test.ts
 * ("android shell filter") and the dispatch-time guard lives in lib/launcher/dispatch.ts.
 *
 * Uses REAL providers — no vi.mock of internal modules; only the fetch boundary is stubbed.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import Launcher from "@/components/launcher/Launcher";
import { dispatchOpenLauncher } from "@/lib/launcher/launcherEvents";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { createDefaultWorkspaceState } from "@/lib/workspace/schema";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";

// ---------------------------------------------------------------------------
// Helpers
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
    if (url.pathname === "/api/lectern") return jsonResponse({ data: { items: [] } });
    throw new Error(`Unexpected fetch: ${url.pathname}`);
  });
}

function renderLauncher() {
  return render(
    withRenderEnvironment(
      <KeybindingsProvider>
        <FeedbackProvider>
          <LecternProvider>
            <WorkspaceStoreProvider
              workspacePrimaryMetrics={workspacePrimaryMetrics}
              initialState={createDefaultWorkspaceState("/libraries", workspacePrimaryMetrics)}
            >
              <Launcher />
            </WorkspaceStoreProvider>
          </LecternProvider>
        </FeedbackProvider>
      </KeybindingsProvider>,
      { androidShell: true },
    ),
  );
}

function open() {
  act(() => dispatchOpenLauncher());
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

describe("Android-shell gating — launcher recents", () => {
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

  it("hides a restricted /settings/local-vault recent and shows a non-restricted /settings/billing recent", async () => {
    renderLauncher();
    open();

    // Wait until the launcher is visible and the recents have been fetched.
    await screen.findByRole("dialog", { name: "Launcher" });

    // "Billing" is a non-restricted recent → present in the list.
    await waitFor(() => {
      expect(screen.getByRole("option", { name: /Billing/i })).toBeInTheDocument();
    });

    // "Local Vault" maps to the Android-restricted routeId → must be absent / not offered.
    expect(screen.queryByRole("option", { name: /Local Vault/i })).toBeNull();
  });
});
