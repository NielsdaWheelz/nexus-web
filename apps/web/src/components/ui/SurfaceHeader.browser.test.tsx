import { render, screen, within } from "@testing-library/react";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { OfflineMediaProvider } from "@/lib/offlineMedia/OfflineMediaProvider";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
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
import { canonicalResourceRef } from "@/lib/sharing/targets";
import type { PaneHeaderModel } from "@/lib/panes/paneHeaderModel";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import SurfaceHeader from "./SurfaceHeader";

// The system under test is the desktop pane header hub. It composes pane,
// reader-view, and canonical resource actions into its single More menu.
// Only the snapshot-resolve fetch boundary is stubbed.

const ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const MEDIA_REF = `media:${MEDIA_ID}`;
const MEDIA_HREF = `/media/${MEDIA_ID}`;
const RESOLVE_PATH = "/api/resource-items/action-snapshots/resolve";
const MEDIA_FACTS_REVISION = "4".repeat(64);
const MISSING_FACTS_REVISION = "0".repeat(64);

const workspacePrimaryMetrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

const mediaSubject = {
  ref: canonicalResourceRef({ scheme: "media", id: MEDIA_ID }),
};

const MEDIA_SNAPSHOT = {
  ref: MEDIA_REF,
  activation: {
    resourceRef: MEDIA_REF,
    kind: "route",
    href: MEDIA_HREF,
    unresolvedReason: null,
  },
  missing: false,
  factsRevision: MEDIA_FACTS_REVISION,
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

const readerSettingsAction: ActionDescriptor = {
  kind: "command",
  id: "ViewAction.Reader.Settings",
  label: "Reader settings",
  onSelect: () => {},
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
      const url = new URL(
        request?.url ?? String(input),
        window.location.origin,
      );
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
                  kind: "none",
                  href: null,
                  unresolvedReason: null,
                },
                missing: true,
                factsRevision: MISSING_FACTS_REVISION,
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
                            <GlobalPlayerProvider>
                              <ResourceActionRuntimeProvider>
                                <SurfaceHeader
                                header={sectionHeader}
                                identityId="pane-identity"
                                actionSubject={mediaSubject}
                                paneActions={[
                                  {
                                    kind: "command",
                                    id: "Pane.Refresh",
                                    label: "Refresh",
                                    onSelect: () => {},
                                  },
                                ]}
                                menuActions={[readerSettingsAction]}
                                navigation={{
                                  canGoBack: false,
                                  canGoForward: false,
                                  onBack: () => {},
                                  onForward: () => {},
                                }}
                                />
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

  it("composes pane, View, and canonical resource actions in exactly one More menu", async () => {
    installBff();
    renderHeader();

    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reader settings" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();

    const moreButtons = await screen.findAllByRole("button", { name: "More" });
    expect(moreButtons).toHaveLength(1);
    const [more] = moreButtons;
    if (!more) throw new Error("SurfaceHeader did not render More");
    await userEvent.click(more);
    const menu = screen.getByRole("menu");

    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent?.trim()),
    ).toEqual([
      "Refresh",
      "Reader settings",
      "Open",
      "Libraries…",
      "Chat about this…",
      "Share…",
      "Remove from Nexus",
    ]);
  });
});
