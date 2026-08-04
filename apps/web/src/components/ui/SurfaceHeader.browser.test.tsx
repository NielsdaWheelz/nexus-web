import { render, screen, within } from "@testing-library/react";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { OfflineMediaProvider } from "@/lib/offlineMedia/OfflineMediaProvider";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { ResourceActionRuntimeProvider } from "@/lib/actions/resourceActionRuntime";
import {
  ResourceActionOverlays,
  ResourceOverlaysProvider,
} from "@/lib/resources/resourceOverlaysController";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import { createDefaultWorkspaceState } from "@/lib/workspace/schema";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import { routeResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import type { PaneHeaderModel } from "@/lib/panes/paneHeaderModel";
import type { PaneViewMenuPublication } from "@/lib/panes/panePublications";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import SurfaceHeader from "./SurfaceHeader";

// The system under test is the desktop pane header hub. It renders the ONE
// canonical ResourceActionMenu (wired to the real runtime + planner) for the
// pane's `resourceTarget`, so the open pane's own menu now INCLUDES Open (AC6),
// while the pane refresh and the pane's view menu (reader settings) are ejected
// into SEPARATE controls that never appear inside the resource dropdown (AC4).
// Only the snapshot-resolve fetch boundary is stubbed.

const ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const MEDIA_REF = `media:${MEDIA_ID}`;
const MEDIA_HREF = `/media/${MEDIA_ID}`;
const RESOLVE_PATH = "/api/resource-items/action-snapshots/resolve";

const workspacePrimaryMetrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

const mediaTarget = routeResourceActionSubject({
  scheme: "media",
  id: MEDIA_ID,
  href: MEDIA_HREF,
});

const MEDIA_SNAPSHOT = {
  ref: MEDIA_REF,
  activation: {
    resourceRef: MEDIA_REF,
    kind: "route",
    href: MEDIA_HREF,
    unresolvedReason: null,
  },
  missing: false,
  factsRevision: "facts-rev-1",
  capabilities: [
    { kind: "Open", availability: { kind: "Available" } },
    { kind: "Share", availability: { kind: "Available" } },
    { kind: "Chat", availability: { kind: "Available" } },
    { kind: "LibraryPlacement", availability: { kind: "Available" } },
    { kind: "RemoveMedia", availability: { kind: "Available" } },
  ],
} as const;

const sectionHeader: PaneHeaderModel = {
  kind: "Section",
  title: "Document",
  titlePending: false,
  context: { kind: "Absent" },
  meta: { kind: "None" },
};

const readerSettingsViewMenu: PaneViewMenuPublication = {
  label: "Reader settings",
  icon: <span aria-hidden="true">gear</span>,
  actions: [
    {
      kind: "command",
      id: "ViewAction.Reader.Settings",
      label: "Reader settings",
      onSelect: () => {},
    } satisfies ActionDescriptor,
  ],
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function installBff(): { readonly resolveCalls: unknown[] } {
  const resolveCalls: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request?.url ?? String(input), window.location.origin);
      const method = init?.method ?? request?.method ?? "GET";
      if (url.pathname === RESOLVE_PATH && method === "POST") {
        const body =
          typeof init?.body === "string" ? JSON.parse(init.body) : null;
        resolveCalls.push(body);
        const refs: string[] = Array.isArray(body?.refs) ? body.refs : [];
        const snapshots = refs.map((ref) =>
          ref === MEDIA_REF
            ? MEDIA_SNAPSHOT
            : {
                ref,
                activation: {
                  resourceRef: ref,
                  kind: "route",
                  href: "/",
                  unresolvedReason: null,
                },
                missing: true,
                factsRevision: "missing",
                capabilities: [],
              },
        );
        return jsonResponse({ data: { snapshots } });
      }
      if (url.pathname === "/api/lectern") {
        return jsonResponse({ data: { items: [] } });
      }
      // Benign answer to every other mount-time BFF chatter.
      return jsonResponse({ data: null });
    },
  );
  return { resolveCalls };
}

function renderHeader() {
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
                        <OfflineMediaProvider
                          accountId={ACCOUNT_ID}
                          transport={null}
                        >
                          <ResourceOverlaysProvider>
                            <ResourceActionRuntimeProvider>
                              <SurfaceHeader
                                header={sectionHeader}
                                identityId="pane-identity"
                                resourceTarget={mediaTarget}
                                viewMenu={readerSettingsViewMenu}
                                controls={
                                  <button
                                    type="button"
                                    aria-label="Refresh"
                                    data-action-id="Pane.Refresh"
                                  >
                                    Refresh
                                  </button>
                                }
                                navigation={{
                                  canGoBack: false,
                                  canGoForward: false,
                                  onBack: () => {},
                                  onForward: () => {},
                                }}
                              />
                              <ResourceActionOverlays />
                            </ResourceActionRuntimeProvider>
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

describe("SurfaceHeader pane hub", () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    await page.viewport(1_280, 768);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
    await page.viewport(1_280, 768);
  });

  it("renders the canonical resource dropdown with Open (AC6), keeping refresh and the view menu as separate controls (AC4)", async () => {
    installBff();
    renderHeader();

    // The refresh affordance is a dedicated control on the header, NOT a menu
    // item — present without opening any dropdown.
    const refresh = await screen.findByRole("button", { name: "Refresh" });
    expect(refresh.getAttribute("data-action-id")).toBe("Pane.Refresh");

    // The resource dropdown is the canonical ResourceActionMenu (label "Options"),
    // appearing only after its snapshot prefetch resolves.
    const optionsTrigger = await screen.findByRole("button", { name: "Options" });
    await userEvent.click(optionsTrigger);
    const menu = screen.getByRole("menu");

    // AC6: Open is present in the OPEN pane's own menu (the old CurrentPane
    // projection dropped it).
    expect(
      within(menu).getByRole("menuitem", { name: "Open" }),
      "Open was not present in the open pane's own resource menu (AC6)",
    ).toBeTruthy();
    expect(
      within(menu).getByRole("menuitem", { name: "Chat about this resource" }),
    ).toBeTruthy();

    // AC4: the pane refresh is NOT inside the resource dropdown — it is a separate
    // control (asserted above as a top-level button).
    expect(
      within(menu).queryByRole("menuitem", { name: "Refresh" }),
      "the pane refresh leaked into the resource dropdown (AC4)",
    ).toBeNull();

    // AC4: the reader-view action is NOT inside the resource dropdown; it lives in
    // the pane's own separate view menu.
    expect(
      within(menu).queryByRole("menuitem", { name: "Reader settings" }),
      "a reader view action leaked into the resource dropdown (AC4)",
    ).toBeNull();
  });

  it("hosts reader-view actions in a separate view menu that never carries Open", async () => {
    installBff();
    renderHeader();

    // Ensure the runtime has resolved (resource dropdown present) before probing
    // the sibling view menu.
    await screen.findByRole("button", { name: "Options" });

    const viewTrigger = screen.getByRole("button", { name: "Reader settings" });
    await userEvent.click(viewTrigger);
    const viewMenu = screen.getByRole("menu");

    expect(
      within(viewMenu).getByRole("menuitem", { name: "Reader settings" }),
    ).toBeTruthy();
    // The view menu is a NON-resource control: it must not carry resource core.
    expect(
      within(viewMenu).queryByRole("menuitem", { name: "Open" }),
      "the pane view menu wrongly carried the resource Open action",
    ).toBeNull();
  });
});
