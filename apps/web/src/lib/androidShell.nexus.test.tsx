/**
 * Android-shell gating — Nexus integration.
 *
 * Verifies that recent-history entries whose href maps to an Android-restricted
 * route (e.g. /settings/local-vault → routeId "settingsLocalVault") are silently
 * dropped from Nexus when running inside the Android shell, while
 * non-restricted recents (e.g. /settings/billing) are still shown. This is the
 * shared Nexus projection equivalent of the route guard; the
 * dispatch-time guard lives in lib/nexus/dispatch.ts.
 *
 * Uses REAL providers — no vi.mock of internal modules; only the fetch boundary is stubbed.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import Nexus from "@/components/nexus/Nexus";
import { requestNexusOpen } from "@/lib/nexus/events";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import { createDefaultWorkspaceState } from "@/lib/workspace/schema";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";

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
    target_href: string;
    label_snapshot: string;
    last_used_at: string;
  }[] = [],
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/me/nexus-history") {
      return jsonResponse({
        data: {
          recent: recents.map((row) => ({
            ...row,
            source: "Recent",
          })),
          frecency_by_href: {},
        },
      });
    }
    if (url.pathname === "/api/me/nexus-selections" && init?.method === "POST") {
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

function renderNexus() {
  return render(
    withRenderEnvironment(
      <AuthenticatedAccountProvider
        account={{ accountId: "account-1", calendarTimeZone: "UTC" }}
      >
        <KeybindingsProvider>
          <PaneReturnMementoProvider>
            <FeedbackProvider>
              <ShareControllerProvider>
                <LecternProvider>
                  <GlobalPlayerProvider accountId="account-1">
                    <WorkspaceStoreProvider
                      workspacePrimaryMetrics={workspacePrimaryMetrics}
                      initialState={createDefaultWorkspaceState(
                        "/libraries",
                        workspacePrimaryMetrics,
                      )}
                    >
                      <Nexus />
                    </WorkspaceStoreProvider>
                  </GlobalPlayerProvider>
                </LecternProvider>
              </ShareControllerProvider>
            </FeedbackProvider>
          </PaneReturnMementoProvider>
        </KeybindingsProvider>
      </AuthenticatedAccountProvider>,
      { androidShell: true },
    ),
  );
}

function open() {
  act(() => requestNexusOpen({ kind: "Root" }));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

const RECENTS = [
  {
    target_href: "/settings/local-vault",
    label_snapshot: "Local Vault",
    last_used_at: "2026-06-01T00:00:00Z",
  },
  {
    target_href: "/settings/billing",
    label_snapshot: "Billing",
    last_used_at: "2026-06-01T00:00:00Z",
  },
];

describe("Android-shell gating — Nexus recents", () => {
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
    renderNexus();
    open();

    // Wait until Nexus is visible and the recents have been fetched.
    await screen.findByRole("dialog", { name: "Nexus" });

    // "Billing" is a non-restricted recent → present in the list.
    await waitFor(() => {
      expect(screen.getByRole("gridcell", { name: /Billing/i })).toBeInTheDocument();
    });

    // "Local Vault" maps to the Android-restricted routeId → must be absent / not offered.
    expect(screen.queryByRole("gridcell", { name: /Local Vault/i })).toBeNull();
  });
});
