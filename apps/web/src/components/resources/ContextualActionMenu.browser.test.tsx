import type { ReactNode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import { ResourceActionRuntimeProvider } from "@/lib/actions/resourceActionRuntime";
import type { ResourceActionSnapshot } from "@/lib/actions/resourceActionSnapshot";
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
const MEDIA_REF = canonicalResourceRef({ scheme: "media", id: MEDIA_ID });
const RESOLVE_PATH = "/api/resource-items/action-snapshots/resolve";

const workspacePrimaryMetrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

const mediaSubject = {
  ref: MEDIA_REF,
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
} as const satisfies ResourceActionSnapshot;

function response(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installBff({
  failFirstResolve = false,
  deferResolve = false,
  resolvedSnapshot = snapshot,
}: {
  readonly failFirstResolve?: boolean;
  readonly deferResolve?: boolean;
  readonly resolvedSnapshot?: ResourceActionSnapshot;
} = {}) {
  const resolveCalls: unknown[] = [];
  let releaseResolve: (() => void) | null = null;
  const resolveBoundary = deferResolve
    ? new Promise<void>((resolve) => {
        releaseResolve = resolve;
      })
    : null;
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
        await resolveBoundary;
        return response({ data: { snapshots: [resolvedSnapshot] } });
      }
      return response({ data: null });
    },
  );
  return {
    resolveCalls,
    releaseResolve() {
      if (releaseResolve === null) {
        throw new Error("No deferred resource snapshot resolve is pending.");
      }
      releaseResolve();
      releaseResolve = null;
    },
  };
}

function menuEnvironment(menu: ReactNode) {
  return withRenderEnvironment(
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
  );
}

function renderMenu(menu: ReactNode) {
  const view = render(menuEnvironment(menu));
  return {
    ...view,
    rerenderMenu(nextMenu: ReactNode) {
      view.rerender(menuEnvironment(nextMenu));
    },
  };
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

  it("keeps an open local menu mounted when its resource subject is published", async () => {
    const bff = installBff({
      resolvedSnapshot: {
        ...snapshot,
        capabilities: [
          ...snapshot.capabilities,
          { kind: "LibraryPlacement", availability: { kind: "Available" } },
        ],
      },
    });
    const refresh = vi.fn();
    const sections = [
      {
        id: "Pane" as const,
        actions: [
          {
            kind: "command" as const,
            id: "Pane.Refresh",
            label: "Refresh",
            onSelect: refresh,
          },
        ],
      },
    ];
    const view = renderMenu(
      <ContextualActionMenu label="More" sections={sections} />,
    );

    const menu = await openMore();
    const refreshItem = within(menu).getByRole("menuitem", { name: "Refresh" });
    expect(refreshItem).toBeEnabled();
    refreshItem.focus();
    expect(refreshItem).toHaveFocus();
    expect(bff.resolveCalls).toHaveLength(0);

    view.rerenderMenu(
      <ContextualActionMenu
        label="More"
        sections={sections}
        actionSubject={mediaSubject}
      />,
    );

    await waitFor(() => expect(bff.resolveCalls).toHaveLength(1));
    expect(screen.getByRole("button", { name: "More" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("menu")).toBe(menu);
    expect(within(menu).getByRole("menuitem", { name: "Refresh" })).toBeEnabled();
    expect(refreshItem).toHaveFocus();
    expect(
      within(menu).getByRole("menuitem", { name: "Libraries…" }),
    ).toBeEnabled();
    expect(bff.resolveCalls).toHaveLength(1);
  });

  it("keeps a resource-only trigger disabled until its canonical plan is ready", async () => {
    const bff = installBff({ deferResolve: true });
    renderMenu(
      <ContextualActionMenu
        label="More"
        sections={[]}
        actionSubject={mediaSubject}
      />,
    );

    const trigger = await screen.findByRole("button", { name: "More" });
    await waitFor(() => expect(bff.resolveCalls).toHaveLength(1));
    expect(trigger).toHaveAttribute("aria-disabled", "true");
    expect(trigger).toHaveAccessibleDescription("Actions are still loading.");

    bff.releaseResolve();
    await waitFor(() =>
      expect(trigger).not.toHaveAttribute("aria-disabled", "true"),
    );
    const menu = await openMore();
    expect(within(menu).getByRole("menuitem", { name: "Open" })).toBeEnabled();
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
