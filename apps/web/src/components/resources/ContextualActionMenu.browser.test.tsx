import type { ReactNode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import { ResourceActionRuntimeProvider } from "@/lib/actions/resourceActionRuntime";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { OfflineMediaProvider } from "@/lib/offlineMedia/OfflineMediaProvider";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import {
  ResourceActionOverlays,
  ResourceOverlaysProvider,
} from "@/lib/resources/resourceOverlaysController";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";
import { createDefaultWorkspaceState } from "@/lib/workspace/schema";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import ContextualActionMenu from "./ContextualActionMenu";

const ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const MEDIA_REF = `media:${MEDIA_ID}`;
const RESOLVE_PATH = "/api/resource-items/action-snapshots/resolve";

const workspacePrimaryMetrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

const mediaSubject = {
  ref: canonicalResourceRef({ scheme: "media", id: MEDIA_ID }),
};

const snapshot = {
  ref: MEDIA_REF,
  activation: {
    resourceRef: MEDIA_REF,
    kind: "route",
    href: `/media/${MEDIA_ID}`,
    unresolvedReason: null,
  },
  missing: false,
  factsRevision: "1".repeat(64),
  capabilities: [
    { kind: "RemoveMedia", availability: { kind: "Available" } },
    { kind: "Open", availability: { kind: "Available" } },
    { kind: "Chat", availability: { kind: "Available" } },
  ],
} as const;

function response(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installBff({
  failFirstResolve = false,
}: {
  readonly failFirstResolve?: boolean;
} = {}) {
  const resolveCalls: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(
        request?.url ?? String(input),
        window.location.origin,
      );
      const method = init?.method ?? request?.method ?? "GET";
      if (url.pathname === RESOLVE_PATH && method === "POST") {
        resolveCalls.push(init?.body);
        if (failFirstResolve && resolveCalls.length === 1) {
          throw new Error("temporary snapshot failure");
        }
        return response({ data: { snapshots: [snapshot] } });
      }
      return response({ data: null });
    },
  );
  return { resolveCalls };
}

function renderMenu(menu: ReactNode) {
  return render(
    withRenderEnvironment(
      <AuthenticatedAccountProvider
        account={{ accountId: ACCOUNT_ID, calendarTimeZone: "UTC" }}
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
                    <LibraryPlacementControllerProvider>
                      <ShareControllerProvider>
                        <OfflineMediaProvider accountId={ACCOUNT_ID} transport={null}>
                          <ResourceOverlaysProvider>
                            <GlobalPlayerProvider>
                              <ResourceActionRuntimeProvider>
                                {menu}
                                <ResourceActionOverlays />
                              </ResourceActionRuntimeProvider>
                            </GlobalPlayerProvider>
                          </ResourceOverlaysProvider>
                        </OfflineMediaProvider>
                      </ShareControllerProvider>
                    </LibraryPlacementControllerProvider>
                  </LecternProvider>
                </WorkspaceStoreProvider>
              </PaneReturnMementoProvider>
            </FeedbackProvider>
          </KeybindingsProvider>
        </MobileChromeProvider>
      </AuthenticatedAccountProvider>,
    ),
  );
}

async function openMore(): Promise<HTMLElement> {
  const trigger = await screen.findByRole("button", { name: "More" });
  await userEvent.click(trigger);
  return screen.getByRole("menu");
}

describe("ContextualActionMenu", () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    await page.viewport(1_024, 768);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("keeps local pane commands available and appends the canonical resource plan as one ordered suffix", async () => {
    const bff = installBff();
    const refresh = vi.fn();
    renderMenu(
      <ContextualActionMenu
        label="More"
        sections={[
          {
            id: "Pane",
            actions: [
              {
                kind: "command",
                id: "Pane.Refresh",
                label: "Refresh",
                onSelect: refresh,
              },
            ],
          },
          {
            id: "View",
            actions: [
              {
                kind: "command",
                id: "View.Reader.Settings",
                label: "Reader settings",
                onSelect: () => undefined,
              },
            ],
          },
        ]}
        actionSubject={mediaSubject}
      />,
    );

    await waitFor(() => expect(bff.resolveCalls).toHaveLength(1));
    const menu = await openMore();
    expect(bff.resolveCalls).toHaveLength(1);
    const labels = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent?.trim());
    expect(labels).toEqual([
      "Refresh",
      "Reader settings",
      "Open",
      "Chat about this…",
      "Remove from Nexus",
    ]);
    // One boundary separates Pane from View, one starts the resource suffix,
    // and the canonical planner retains its own Chat/Danger group boundaries.
    expect(within(menu).getAllByRole("separator")).toHaveLength(4);

    await userEvent.click(within(menu).getByRole("menuitem", { name: "Refresh" }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(bff.resolveCalls).toHaveLength(1);
  });

  it("keeps local commands usable through a resource Error and exposes Retry", async () => {
    const bff = installBff({ failFirstResolve: true });
    const refresh = vi.fn();
    renderMenu(
      <ContextualActionMenu
        label="More"
        sections={[
          {
            id: "Pane",
            actions: [
              {
                kind: "command",
                id: "Pane.Refresh",
                label: "Refresh",
                onSelect: refresh,
              },
            ],
          },
        ]}
        actionSubject={mediaSubject}
      />,
    );

    await waitFor(() => expect(bff.resolveCalls).toHaveLength(1));
    const menu = await openMore();
    expect(within(menu).getByRole("menuitem", { name: "Refresh" })).toBeEnabled();
    expect(
      within(menu).getByRole("menuitem", { name: "Retry actions" }),
    ).toBeEnabled();

    await userEvent.click(within(menu).getByRole("menuitem", { name: "Refresh" }));
    expect(refresh).toHaveBeenCalledTimes(1);

    const retryMenu = await openMore();
    await userEvent.click(
      within(retryMenu).getByRole("menuitem", { name: "Retry actions" }),
    );
    await waitFor(() => expect(bff.resolveCalls).toHaveLength(2));
  });
});
