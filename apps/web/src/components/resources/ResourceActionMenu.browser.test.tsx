import type { ReactNode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
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
import ResourceActionMenu from "./ResourceActionMenu";

// The system under test is ResourceActionMenu wired to the real runtime,
// planner, catalog projector, and ActionMenu. Only the BFF fetch boundary is
// stubbed: the snapshot-resolve endpoint serves a schema-valid media snapshot
// whose capabilities arrive in a deliberately scrambled order, so the observed
// dropdown proves the PLANNER — not the wire — owns membership and order.

const ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const MEDIA_REF = `media:${MEDIA_ID}`;
const MEDIA_HREF = `/media/${MEDIA_ID}`;
const RETRY_PATH = `/api/media/${MEDIA_ID}/retry`;
const RESOLVE_PATH = "/api/resource-items/action-snapshots/resolve";

const LIBRARY_ID = "22222222-2222-4222-8222-222222222222";
const LIBRARY_REF = `library:${LIBRARY_ID}`;
const LIBRARY_HREF = `/libraries/${LIBRARY_ID}`;
const LIBRARY_GET_PATH = `/api/libraries/${LIBRARY_ID}`;

const workspacePrimaryMetrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

const mediaTarget = routeResourceActionSubject({
  scheme: "media",
  id: MEDIA_ID,
  href: MEDIA_HREF,
});

// A schema-valid resolve response. Capabilities are intentionally out of catalog
// order and mix all three groups plus a danger action and a server-Blocked
// action, so the composed menu proves catalog order + danger-last + blocked copy.
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
    { kind: "RemoveMedia", availability: { kind: "Available" } },
    { kind: "Chat", availability: { kind: "Available" } },
    { kind: "LibraryPlacement", availability: { kind: "Available" } },
    { kind: "Open", availability: { kind: "Available" } },
    { kind: "Consumption", availability: { kind: "Available" }, state: "Unread" },
    { kind: "RetryProcessing", availability: { kind: "Available" } },
    { kind: "Share", availability: { kind: "Available" } },
    {
      kind: "LecternMembership",
      availability: { kind: "Available" },
      state: "Absent",
    },
    {
      kind: "RefreshSource",
      availability: { kind: "Blocked", reason: "Processing" },
    },
  ],
} as const;

// Catalog-owned order (core -> operations -> relationships), then every danger
// action hoisted into one final terminal group. This is the AC1/AC5 oracle: it
// comes from the catalog + planner contract, not from the wire order above.
const EXPECTED_MENU_ORDER = [
  "Open",
  "Share…",
  "Chat about this resource",
  "Retry processing",
  "Refresh source",
  "Mark as finished",
  "Libraries…",
  "Add to Lectern",
  "Remove media",
];

// A library target whose snapshot exposes the LibrarySettings operation. Clicking
// it must dispatch through the runtime to the app-level overlay controller and
// open the (self-loading) Library settings dialog — the proof that the formerly
// throwing EditAuthors/LibrarySettings/PodcastSettings/Subscribe/RefreshPodcast
// dispatch is now exhaustive and non-fatal.
const libraryTarget = routeResourceActionSubject({
  scheme: "library",
  id: LIBRARY_ID,
  href: LIBRARY_HREF,
});

const LIBRARY_SNAPSHOT = {
  ref: LIBRARY_REF,
  activation: {
    resourceRef: LIBRARY_REF,
    kind: "route",
    href: LIBRARY_HREF,
    unresolvedReason: null,
  },
  missing: false,
  factsRevision: "library-rev-1",
  capabilities: [
    { kind: "Open", availability: { kind: "Available" } },
    { kind: "LibrarySettings", availability: { kind: "Available" } },
  ],
} as const;

const SNAPSHOTS_BY_REF: Record<string, unknown> = {
  [MEDIA_REF]: MEDIA_SNAPSHOT,
  [LIBRARY_REF]: LIBRARY_SNAPSHOT,
};

// getMemberLibrary self-load fixture (strict LibraryOut envelope).
const LIBRARY_OUT = {
  data: {
    id: LIBRARY_ID,
    name: "Field Notes",
    color: null,
    ownerUserHandle: "nus1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB",
    isDefault: false,
    role: "admin",
    systemKey: null,
    canRename: true,
    canDelete: true,
    canEditEntries: true,
    canManageMembers: true,
    canTransferOwnership: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

interface Bff {
  readonly resolveCalls: unknown[];
  readonly retryCalls: number[];
}

function installBff(): Bff {
  const resolveCalls: unknown[] = [];
  const retryCalls: number[] = [];
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
        resolveCalls.push(body);
        const refs: string[] = Array.isArray(body?.refs) ? body.refs : [];
        const snapshots = refs.map(
          (ref) =>
            SNAPSHOTS_BY_REF[ref] ?? {
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
      if (path === LIBRARY_GET_PATH && method === "GET") {
        return jsonResponse(LIBRARY_OUT);
      }
      if (path === RETRY_PATH && method === "POST") {
        retryCalls.push(Date.now());
        // Keep the retry dispatch in flight forever: the busy key stays set, so
        // the reopened menu must render the action as busy + aria-disabled.
        return new Promise<Response>(() => {});
      }
      if (path === "/api/lectern") {
        return jsonResponse({ data: { items: [] } });
      }
      // Every other mount-time BFF chatter (workspace session, etc.) is not the
      // system under test; answer benignly so the tree mounts.
      return jsonResponse({ data: null });
    },
  );
  return { resolveCalls, retryCalls };
}

function renderResourceMenu(
  menu: ReactNode = <ResourceActionMenu target={mediaTarget} />,
) {
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
                              {menu}
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

async function openMenu(): Promise<HTMLElement> {
  const trigger = await screen.findByRole("button", { name: "More actions" });
  await userEvent.click(trigger);
  return screen.getByRole("menu");
}

describe("ResourceActionMenu component contract", () => {
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

  it("presents the catalog-owned order with danger last and preserves a server-blocked reason", async () => {
    const bff = installBff();
    renderResourceMenu();

    const menu = await openMenu();

    // AC1 (Open promoted into the menu) + AC5 (planner-owned catalog order,
    // danger action hoisted last regardless of the scrambled wire order).
    const names = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent?.trim());
    expect(
      names,
      "resource dropdown did not render the catalog-owned order with danger last",
    ).toEqual(EXPECTED_MENU_ORDER);
    expect(names[0], "Open was not promoted to the top of the menu").toBe("Open");
    expect(
      names[names.length - 1],
      "the danger action was not hoisted to the end of the menu",
    ).toBe("Remove media");

    // The composer owns separators: one before each non-first visual group
    // (operations, relationships, danger) => 3 rules for these 4 groups.
    expect(
      within(menu).getAllByRole("separator"),
      "group-boundary separators were not rendered",
    ).toHaveLength(3);

    // AC10: a server-Blocked action stays visible + keyboard-discoverable, is
    // aria-disabled, and publishes its unavailable reason as an accessible
    // description (not the busy label).
    const blocked = within(menu).getByRole("menuitem", { name: "Refresh source" });
    expect(blocked.getAttribute("aria-disabled")).toBe("true");
    expect(blocked).toHaveAccessibleDescription(
      "This resource is still processing.",
    );

    // Opening the menu performed no request: the snapshot was prefetched exactly
    // once and the trigger only appeared after it was ready.
    expect(
      bff.resolveCalls,
      "opening the menu re-resolved the snapshot instead of reading the prefetched cache",
    ).toHaveLength(1);
    expect(bff.resolveCalls[0]).toEqual({ refs: [MEDIA_REF] });
    expect(bff.retryCalls).toHaveLength(0);
  });

  it("marks an in-flight action busy and aria-disabled after it is invoked", async () => {
    const bff = installBff();
    renderResourceMenu();

    const menu = await openMenu();
    // Invoke a real dispatch whose BFF call is held in flight forever.
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: "Retry processing" }),
    );
    await waitFor(() => expect(bff.retryCalls).toHaveLength(1));

    // Reopen: the same action is now the busy verb and cannot be executed again.
    const reopened = await openMenu();
    const busy = await within(reopened).findByRole("menuitem", {
      name: "Retrying...",
    });
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect(
      within(reopened).queryByRole("menuitem", { name: "Retry processing" }),
      "the busy action still offered its idle, executable label",
    ).toBeNull();
  });

  it("renders through a caller-supplied trigger (player/header reuse of the same component)", async () => {
    installBff();
    renderResourceMenu(
      <ResourceActionMenu
        target={mediaTarget}
        renderTrigger={(triggerProps) => (
          <button {...triggerProps}>Recording options</button>
        )}
      />,
    );

    // The custom trigger receives the wired ActionMenu props (aria-label "More
    // actions") and renders the caller's own content, then opens the same
    // canonical menu — proving surfaces reuse ONE component with a bespoke trigger.
    const trigger = await screen.findByRole("button", { name: "More actions" });
    expect(trigger.textContent).toContain("Recording options");
    await userEvent.click(trigger);
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Open" })).toBeTruthy();
  });

  it("dispatches the LibrarySettings operation to the app-level overlay controller and opens the settings dialog", async () => {
    const bff = installBff();
    renderResourceMenu(<ResourceActionMenu target={libraryTarget} />);

    const menu = await openMenu();
    const settings = within(menu).getByRole("menuitem", { name: "Settings" });
    const resolvesBeforeOpen = bff.resolveCalls.length;

    // Before this change the runtime dispatched LibrarySettings by THROWING a
    // "not yet wired" defect, crashing the workspace the instant the action was
    // invoked. Clicking it must now dispatch through the runtime to the shared
    // ResourceOverlays controller without crashing.
    await userEvent.click(settings);

    // The single app-level overlay self-loads the library (one GET) and reveals
    // the Library settings dialog — proving the intent dispatched, not threw.
    expect(
      await screen.findByText("Library settings"),
      "invoking Settings did not open the app-level Library settings overlay",
    ).toBeTruthy();
    expect(
      screen.getByText("Library name"),
      "the opened overlay was not the Library settings dialog",
    ).toBeTruthy();

    // Opening a settings overlay is NOT a mutation: it must not mark the action
    // busy or fire a snapshot re-resolve. The resolve count is unchanged by open.
    expect(
      bff.resolveCalls.length,
      "opening the settings overlay wrongly re-resolved snapshots as if a mutation completed",
    ).toBe(resolvesBeforeOpen);
  });
});
