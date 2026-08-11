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

function activityResponse(
  needsAttentionCount: number,
  activeCount: number,
): Response {
  return jsonResponse({
    data: {
      needs_attention_count: needsAttentionCount,
      active_count: activeCount,
      has_more: needsAttentionCount + activeCount > 0,
      items: [],
    },
  });
}

function activityBadge(button: HTMLElement): HTMLSpanElement | null {
  return button.querySelector("span[aria-hidden='true']");
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
  let requestActivity: () => Response | Promise<Response>;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    window.history.replaceState({}, "", "/libraries");
    requestActivity = () => activityResponse(2, 4);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/media/activity") {
        return requestActivity();
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
      await screen.findByRole("button", {
        name: "Activity, 2 imports need attention",
      }),
    );

    expect(await screen.findByRole("dialog", { name: "Activity" })).toBeVisible();
    expect(window.location.pathname).toBe("/libraries");
  });

  it.each([
    ["desktop", 1_280, 900],
    ["mobile", 390, 800],
  ] as const)("keeps an unknown Activity snapshot unbadged in the %s navigation", async (viewport, width, height) => {
    let resolveActivity: (response: Response) => void = () => undefined;
    requestActivity = () =>
      new Promise<Response>((resolve) => {
        resolveActivity = resolve;
      });
    await page.viewport(width, height);
    renderShell(viewport);

    const button = screen.getByRole("button", { name: "Activity" });
    expect(activityBadge(button)).toBeNull();

    // Keep the request unresolved for the assertion, then settle it so this
    // test leaves no pending transport work behind.
    resolveActivity(activityResponse(0, 0));
  });

  it.each([
    ["a known empty snapshot", "desktop", 1_280, 900, 0, 0],
    ["active-only work", "mobile", 390, 800, 0, 4],
  ] as const)("keeps Activity unbadged for %s in the %s navigation", async (_description, viewport, width, height, needsAttentionCount, activeCount) => {
    requestActivity = () => activityResponse(needsAttentionCount, activeCount);
    await page.viewport(width, height);
    renderShell(viewport);

    const button = await screen.findByRole("button", { name: "Activity" });
    expect(activityBadge(button)).toBeNull();
  });

  it.each([
    ["desktop", 1_280, 900],
    ["mobile", 390, 800],
  ] as const)("caps the visible badge without truncating the %s accessible count", async (viewport, width, height) => {
    requestActivity = () => activityResponse(100, 0);
    await page.viewport(width, height);
    renderShell(viewport);

    const button = await screen.findByRole("button", {
      name: "Activity, 100 imports need attention",
    });
    expect(activityBadge(button)?.textContent).toBe("99+");
  });
});
