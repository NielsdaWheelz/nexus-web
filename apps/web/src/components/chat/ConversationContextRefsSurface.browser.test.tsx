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
import type { ContextRefOut } from "@/lib/resourceGraph/contextRefs";
import ConversationContextRefsSurface from "./ConversationContextRefsSurface";

// The system under test is the migrated ConversationContextRefsSurface wired to
// the REAL resource-action runtime, planner, catalog projector, ActionMenu, and
// the new separate context-edge control. Only the BFF fetch boundary is stubbed:
// the snapshot-resolve endpoint serves a schema-valid media snapshot whose
// capabilities are the canonical resource actions. The proof is the AC4 taxonomy
// split — the resource dropdown holds the resource actions and NOT the context
// edge command; the separate context-edge control holds the edge command and NOT
// any resource action.

const ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONVERSATION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const MEDIA_REF = `media:${MEDIA_ID}`;
const MEDIA_HREF = `/media/${MEDIA_ID}`;
const RESOLVE_PATH = "/api/resource-items/action-snapshots/resolve";
const CONTEXT_LABEL = "Field Notes";

const workspacePrimaryMetrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

const mediaTarget = routeResourceActionSubject({
  scheme: "media",
  id: MEDIA_ID,
  href: MEDIA_HREF,
});

// A schema-valid resolve response carrying only the three canonical CORE
// resource actions. Crucially it carries NO context-edge capability — the
// context edge is not a resource-snapshot fact.
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
  ],
} as const;

const CONTEXT_REF: ContextRefOut = {
  id: "edge-1",
  conversation_id: CONVERSATION_ID,
  resource_ref: MEDIA_REF,
  activation: mediaTarget.activation,
  actionTarget: mediaTarget,
  label: CONTEXT_LABEL,
  summary: "A media resource in the conversation context.",
  missing: false,
  created_at: "2026-01-01T00:00:00Z",
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function installBff(): { readonly removeCalls: string[] } {
  const removeCalls: string[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request?.url ?? String(input), window.location.origin);
      const method = init?.method ?? request?.method ?? "GET";
      const path = url.pathname;

      if (path === RESOLVE_PATH && method === "POST") {
        const body =
          typeof init?.body === "string" ? JSON.parse(init.body) : null;
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
      if (path === "/api/lectern") {
        return jsonResponse({ data: { items: [] } });
      }
      return jsonResponse({ data: null });
    },
  );
  return { removeCalls };
}

function renderSurface() {
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
                    "/conversations",
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
                              <ConversationContextRefsSurface
                                contextRefs={[CONTEXT_REF]}
                                removeContextRef={async () => {}}
                                onOpenResource={() => {}}
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

describe("ConversationContextRefsSurface AC4 taxonomy split", () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    await page.viewport(1_024, 768);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
    await page.viewport(1_024, 768);
  });

  it("keeps resource actions in the canonical dropdown and the context-edge command in its own separate control", async () => {
    installBff();
    renderSurface();

    // Two DISTINCT, separately-labelled triggers exist: the canonical resource
    // dropdown and the separate context-edge control. They are never one menu.
    const resourceTrigger = await screen.findByRole("button", {
      name: `Actions for ${CONTEXT_LABEL}`,
    });
    const edgeTrigger = screen.getByRole("button", {
      name: `Remove ${CONTEXT_LABEL} from context`,
    });
    expect(resourceTrigger).not.toBe(edgeTrigger);

    // 1) The RESOURCE dropdown holds the canonical resource actions and does NOT
    //    contain the context-edge command (AC4).
    await userEvent.click(resourceTrigger);
    const resourceMenu = screen.getByRole("menu");
    expect(
      within(resourceMenu).getByRole("menuitem", { name: "Open" }),
    ).toBeTruthy();
    expect(
      within(resourceMenu).getByRole("menuitem", {
        name: "Chat about this resource",
      }),
    ).toBeTruthy();
    expect(
      within(resourceMenu).queryByRole("menuitem", {
        name: "Remove from conversation context",
      }),
      "the context-edge command leaked into the canonical resource dropdown",
    ).toBeNull();

    // Close the resource dropdown before opening the separate control.
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();

    // 2) The SEPARATE context-edge control holds the edge command and does NOT
    //    contain any resource action (AC4).
    await userEvent.click(edgeTrigger);
    const edgeMenu = screen.getByRole("menu");
    expect(
      within(edgeMenu).getByRole("menuitem", {
        name: "Remove from conversation context",
      }),
    ).toBeTruthy();
    expect(
      within(edgeMenu).queryByRole("menuitem", { name: "Open" }),
      "a resource action leaked into the separate context-edge control",
    ).toBeNull();
    expect(
      within(edgeMenu).queryByRole("menuitem", {
        name: "Chat about this resource",
      }),
      "a resource action leaked into the separate context-edge control",
    ).toBeNull();
  });
});
