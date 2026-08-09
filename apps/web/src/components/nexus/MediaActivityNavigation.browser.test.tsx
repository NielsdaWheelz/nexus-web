import { render, screen } from "@testing-library/react";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import AppNav from "@/components/appnav/AppNav";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { MediaActivityProvider } from "@/lib/media/MediaActivityProvider";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";
import { createDefaultWorkspaceState } from "@/lib/workspace/schema";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import Nexus from "./Nexus";

const workspacePrimaryMetrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

function renderShell(viewport: "desktop" | "mobile") {
  return render(
    withRenderEnvironment(
      <AuthenticatedAccountProvider
        account={{
          accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          calendarTimeZone: "UTC",
        }}
      >
        <MobileChromeProvider>
          <KeybindingsProvider>
            <FeedbackProvider>
              <PaneReturnMementoProvider>
                <WorkspaceStoreProvider
                  initialState={createDefaultWorkspaceState(
                    "/libraries",
                    workspacePrimaryMetrics,
                  )}
                  workspacePrimaryMetrics={workspacePrimaryMetrics}
                >
                  <LecternProvider>
                    <GlobalPlayerProvider>
                      <ShareControllerProvider>
                        <MediaActivityProvider>
                          <AppNav />
                          <Nexus />
                        </MediaActivityProvider>
                      </ShareControllerProvider>
                    </GlobalPlayerProvider>
                  </LecternProvider>
                </WorkspaceStoreProvider>
              </PaneReturnMementoProvider>
            </FeedbackProvider>
          </KeybindingsProvider>
        </MobileChromeProvider>
      </AuthenticatedAccountProvider>,
      { initialViewport: viewport },
    ),
  );
}

describe("Activity app navigation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    window.history.replaceState({}, "", "/libraries");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/media/activity") {
        return jsonResponse({ data: { nonterminal_count: 2, items: [] } });
      }
      if (url.pathname === "/api/lectern") {
        return jsonResponse({ data: { items: [] } });
      }
      if (url.pathname === "/api/me/nexus-history") {
        return jsonResponse({ data: { recent: [], frecency_by_href: {} } });
      }
      if (url.pathname === "/api/me/workspace-session" && init?.method === "PUT") {
        return jsonResponse({ data: null });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url.pathname}`);
    });
  });

  it.each([
    ["desktop", 1_280, 900],
    ["mobile", 390, 800],
  ] as const)("opens Activity from the %s app navigation without routing a pane", async (viewport, width, height) => {
    await page.viewport(width, height);
    renderShell(viewport);

    await userEvent.click(
      await screen.findByRole("button", { name: "Activity, 2 open items" }),
    );

    expect(await screen.findByRole("dialog", { name: "Activity" })).toBeVisible();
    expect(window.location.pathname).toBe("/libraries");
  });
});
