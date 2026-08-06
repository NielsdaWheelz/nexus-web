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
import ResourceActionMenu from "./ResourceActionMenu";

// The system under test is ResourceActionMenu wired to the real runtime,
// planner, catalog, runtime, and ActionMenu. Only the BFF fetch boundary is
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
const MEDIA_FACTS_REVISION = "1".repeat(64);
const LIBRARY_FACTS_REVISION = "2".repeat(64);
const MISSING_FACTS_REVISION = "0".repeat(64);

const workspacePrimaryMetrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

const mediaSubject = {
  ref: canonicalResourceRef({ scheme: "media", id: MEDIA_ID }),
};

// A schema-valid resolve response. Capabilities are intentionally out of catalog
// order and span all seven groups plus a danger action and a server-Blocked
// action, so the menu proves catalog order + danger-last + blocked copy.
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
    { kind: "RemoveMedia", availability: { kind: "Available" } },
    { kind: "Chat", availability: { kind: "Available" } },
    { kind: "LibraryPlacement", availability: { kind: "Available" } },
    { kind: "Open", availability: { kind: "Available" } },
    {
      kind: "Consumption",
      availability: { kind: "Available" },
      state: "Unread",
    },
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

// Catalog-owned seven-group order with Danger terminal. This is the AC1/AC3
// oracle: it comes from the catalog + planner contract, not the wire order.
const EXPECTED_MENU_ORDER = [
  "Open",
  "Mark as finished",
  "Libraries…",
  "Add to Lectern",
  "Chat about this…",
  "Share…",
  "Retry processing",
  "Refresh source",
  "Remove from Nexus",
];

// A library target whose snapshot exposes the LibrarySettings operation. Clicking
// it must dispatch through the runtime to the app-level overlay controller and
// open the self-loading Library settings dialog through the exhaustive runtime.
const librarySubject = {
  ref: canonicalResourceRef({ scheme: "library", id: LIBRARY_ID }),
};

const LIBRARY_SNAPSHOT = {
  ref: LIBRARY_REF,
  activation: {
    resourceRef: LIBRARY_REF,
    kind: "route",
    href: LIBRARY_HREF,
    unresolvedReason: null,
  },
  missing: false,
  factsRevision: LIBRARY_FACTS_REVISION,
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

function upstreamUnavailableResponse(): Response {
  return new Response(
    JSON.stringify({
      error: { code: "E_UPSTREAM", message: "Upstream service unavailable" },
    }),
    {
      status: 503,
      headers: { "Content-Type": "application/json" },
    },
  );
}

interface Bff {
  readonly resolveCalls: unknown[];
  readonly retryCalls: number[];
  readonly renameCalls: unknown[];
  readonly removeMediaCalls: number[];
}

interface BffOptions {
  readonly resolve?: (input: {
    readonly attempt: number;
    readonly refs: readonly string[];
    readonly success: () => Response;
  }) => Response | Promise<Response>;
  readonly retryCompletes?: boolean;
  readonly rename?: (input: {
    readonly body: unknown;
    readonly success: () => Response;
  }) => Response | Promise<Response>;
  readonly removeMedia?: () => Response | Promise<Response>;
}

function snapshotResponse(refs: readonly string[]): Response {
  const snapshots = refs.map(
    (ref) =>
      SNAPSHOTS_BY_REF[ref] ?? {
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

function missingSnapshotResponse(refs: readonly string[]): Response {
  return jsonResponse({
    data: {
      snapshots: refs.map((ref) => ({
        ref,
        activation: {
          resourceRef: ref,
          kind: "none",
          href: null,
          unresolvedReason: "Missing",
        },
        missing: true,
        factsRevision: MISSING_FACTS_REVISION,
        capabilities: [],
      })),
    },
  });
}

function installBff(options: BffOptions = {}): Bff {
  const resolveCalls: unknown[] = [];
  const retryCalls: number[] = [];
  const renameCalls: unknown[] = [];
  const removeMediaCalls: number[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(
        request?.url ?? String(input),
        window.location.origin,
      );
      const method = init?.method ?? request?.method ?? "GET";
      const path = url.pathname;

      if (path === RESOLVE_PATH && method === "POST") {
        const body =
          typeof init?.body === "string" ? JSON.parse(init.body) : null;
        resolveCalls.push(body);
        const refs: string[] = Array.isArray(body?.refs) ? body.refs : [];
        const success = () => snapshotResponse(refs);
        return (
          options.resolve?.({
            attempt: resolveCalls.length,
            refs,
            success,
          }) ?? success()
        );
      }
      if (path === LIBRARY_GET_PATH && method === "GET") {
        return jsonResponse(LIBRARY_OUT);
      }
      if (path === LIBRARY_GET_PATH && method === "PATCH") {
        const body =
          typeof init?.body === "string" ? JSON.parse(init.body) : null;
        renameCalls.push(body);
        const name =
          typeof body === "object" &&
          body !== null &&
          "name" in body &&
          typeof body.name === "string"
            ? body.name
            : LIBRARY_OUT.data.name;
        const success = () =>
          jsonResponse({
            data: {
              library: { ...LIBRARY_OUT.data, name },
              collectionRevision: 2,
            },
          });
        return options.rename?.({ body, success }) ?? success();
      }
      if (path === `/api/media/${MEDIA_ID}` && method === "DELETE") {
        removeMediaCalls.push(Date.now());
        return (
          options.removeMedia?.() ??
          jsonResponse({
            data: {
              kind: "Hidden",
              removedFromLibraryIds: [],
              remainingReferenceCount: 1,
              libraryEntriesCollectionRevision: 2,
            },
          })
        );
      }
      if (path === RETRY_PATH && method === "POST") {
        retryCalls.push(Date.now());
        if (options.retryCompletes) {
          return jsonResponse({
            data: {
              media_id: MEDIA_ID,
              source_attempt_id: "33333333-3333-4333-8333-333333333333",
              source_type: "url",
              source_attempt_status: "queued",
              idempotency_outcome: "retrying",
              processing_status: "extracting",
              ingest_enqueued: true,
              capabilities: {
                can_read: false,
                can_highlight: false,
                can_quote: false,
                can_search: false,
                can_play: false,
                can_download_file: false,
                can_delete: true,
                can_retry: false,
                can_refresh_source: false,
                can_retry_metadata: false,
                can_edit_authors: true,
              },
            },
          });
        }
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
  return { resolveCalls, retryCalls, renameCalls, removeMediaCalls };
}

function renderResourceMenu(
  menu: ReactNode = <ResourceActionMenu actionSubject={mediaSubject} />,
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

async function openMenu(): Promise<HTMLElement> {
  const trigger = await screen.findByRole("button", { name: "More actions" });
  await waitFor(() => expect(trigger).toBeEnabled());
  await userEvent.click(trigger);
  return screen.getByRole("menu");
}

function menuLabels(menu: HTMLElement): string[] {
  return within(menu)
    .getAllByRole("none")
    .map((container) => {
      const item =
        within(container).queryByRole("menuitem") ??
        within(container).getByRole("menuitemcheckbox");
      return item.textContent?.trim() ?? "";
    });
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

    // AC3 (Open retained and promoted in the menu) + AC1 (planner-owned catalog
    // order, Danger terminal regardless of the scrambled wire order).
    const names = menuLabels(menu);
    expect(
      names,
      "resource dropdown did not render the catalog-owned order with danger last",
    ).toEqual(EXPECTED_MENU_ORDER);
    expect(names[0], "Open was not promoted to the top of the menu").toBe(
      "Open",
    );
    expect(names[names.length - 1], "the Danger action was not terminal").toBe(
      "Remove from Nexus",
    );

    // ActionMenu renders one separator before each non-first semantic group.
    expect(
      within(menu).getAllByRole("separator"),
      "group-boundary separators were not rendered",
    ).toHaveLength(6);

    // AC10: a server-Blocked action stays visible + keyboard-discoverable, is
    // aria-disabled, and publishes its unavailable reason as an accessible
    // description (not the busy label).
    const blocked = within(menu).getByRole("menuitem", {
      name: "Refresh source",
    });
    expect(blocked.getAttribute("aria-disabled")).toBe("true");
    expect(blocked).toHaveAccessibleDescription(
      "Available when processing finishes.",
    );

    // Opening the menu performed no request: the snapshot was prefetched exactly
    // once; opening the now-enabled trigger does not perform another request.
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

    // Reopen: the stable action keeps its catalog label but is blocked globally
    // by the shared (subject, action ID) busy key.
    const reopened = await openMenu();
    const busy = within(reopened).getByRole("menuitem", {
      name: "Retry processing",
    });
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect(busy).toHaveAccessibleDescription("This action is in progress.");
  });

  it("settles a lost destructive response from a fresh missing snapshot without replaying DELETE", async () => {
    const bff = installBff({
      resolve: ({ attempt, refs, success }) =>
        attempt === 1 ? success() : missingSnapshotResponse(refs),
      removeMedia: () => {
        throw new TypeError("response transport was lost");
      },
    });
    vi.stubGlobal("confirm", () => true);
    renderResourceMenu();

    await userEvent.click(
      within(await openMenu()).getByRole("menuitem", {
        name: "Remove from Nexus",
      }),
    );

    await waitFor(() => expect(bff.removeMediaCalls).toHaveLength(1));
    await waitFor(() => expect(bff.resolveCalls.length).toBeGreaterThan(1));
    const trigger = screen.getByRole("button", { name: "More actions" });
    await waitFor(() =>
      expect(trigger).toHaveAttribute("aria-disabled", "true"),
    );
    expect(trigger).toHaveAccessibleDescription("No actions are available.");
    expect(bff.removeMediaCalls).toHaveLength(1);
  });

  it("renders through a caller-supplied trigger (player/header reuse of the same component)", async () => {
    installBff();
    renderResourceMenu(
      <ResourceActionMenu
        actionSubject={mediaSubject}
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
    renderResourceMenu(<ResourceActionMenu actionSubject={librarySubject} />);

    const menu = await openMenu();
    const settings = within(menu).getByRole("menuitem", {
      name: "Library settings…",
    });
    const resolvesBeforeOpen = bff.resolveCalls.length;

    // Dispatch through the runtime to the shared ResourceOverlays controller.
    await userEvent.click(settings);

    // The single app-level overlay self-loads the library (one GET) and reveals
    // the Library settings dialog — proving the intent dispatched, not threw.
    expect(
      await screen.findByText("Library settings"),
      "invoking Library settings did not open the app-level overlay",
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

  it("keeps an overlay write globally busy and rejects dismissal until reconciliation commits", async () => {
    let finishRename!: () => void;
    const bff = installBff({
      rename: ({ success }) =>
        new Promise<Response>((resolve) => {
          finishRename = () => resolve(success());
        }),
    });
    renderResourceMenu(
      <>
        <ResourceActionMenu actionSubject={librarySubject} />
        <ResourceActionMenu actionSubject={librarySubject} />
      </>,
    );

    const triggers = await screen.findAllByRole("button", {
      name: "More actions",
    });
    await waitFor(() => {
      expect(triggers).toHaveLength(2);
      expect(triggers[0]).toBeEnabled();
      expect(triggers[1]).toBeEnabled();
    });
    await userEvent.click(triggers[0]!);
    await userEvent.click(
      within(screen.getByRole("menu")).getByRole("menuitem", {
        name: "Library settings…",
      }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Library settings",
    });
    await userEvent.fill(
      within(dialog).getByRole("textbox", { name: "Library name" }),
      "Renamed field notes",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(bff.renameCalls).toHaveLength(1));

    // The controller consults the live mutation lease, so Escape/backdrop/close
    // cannot unmount the command owner while delivery is in flight.
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Close dialog" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Library settings" }),
    ).toBeVisible();

    // A simultaneous representation consumes the same exact global busy key.
    // Native click models another host dispatching its already-mounted trigger
    // while the modal is topmost; semantic availability must still agree.
    triggers[1]!.click();
    const simultaneousMenu = await screen.findByRole("menu");
    const busySettings = within(simultaneousMenu).getByRole("menuitem", {
      name: "Library settings…",
    });
    expect(busySettings).toHaveAttribute("aria-disabled", "true");
    expect(busySettings).toHaveAccessibleDescription(
      "This action is in progress.",
    );

    finishRename();
    await waitFor(() => expect(bff.resolveCalls.length).toBeGreaterThan(1));
    await waitFor(() =>
      expect(busySettings).not.toHaveAttribute("aria-disabled", "true"),
    );
  });

  it("keeps the trigger visible and explained while the first snapshot is loading", async () => {
    let completeResolve!: (response: Response) => void;
    const pendingResolve = new Promise<Response>((resolve) => {
      completeResolve = resolve;
    });
    const bff = installBff({ resolve: () => pendingResolve });
    renderResourceMenu();

    const trigger = screen.getByRole("button", { name: "More actions" });
    expect(trigger).toHaveAttribute("aria-disabled", "true");
    expect(trigger).toHaveAccessibleDescription("Actions are still loading.");
    await waitFor(() => expect(bff.resolveCalls).toHaveLength(1));

    completeResolve(snapshotResponse([MEDIA_REF]));
    await waitFor(() =>
      expect(trigger).not.toHaveAttribute("aria-disabled", "true"),
    );
  });

  it("exposes Retry after an initial resolve error and recovers through the same trigger", async () => {
    const bff = installBff({
      resolve: ({ attempt, success }) =>
        attempt === 1 ? upstreamUnavailableResponse() : success(),
    });
    renderResourceMenu();

    const failedMenu = await openMenu();
    await userEvent.click(
      within(failedMenu).getByRole("menuitem", { name: "Retry actions" }),
    );
    await waitFor(() => expect(bff.resolveCalls).toHaveLength(2));

    const recovered = await openMenu();
    expect(
      within(recovered).getByRole("menuitem", { name: "Open" }),
    ).toBeTruthy();
    expect(
      within(recovered).queryByRole("menuitem", { name: "Retry actions" }),
    ).toBeNull();
  });

  it("preserves the last-good plan but blocks it after reconciliation fails", async () => {
    const bff = installBff({
      retryCompletes: true,
      resolve: ({ attempt, success }) =>
        attempt === 1 ? success() : upstreamUnavailableResponse(),
    });
    renderResourceMenu();

    const initial = await openMenu();
    await userEvent.click(
      within(initial).getByRole("menuitem", { name: "Retry processing" }),
    );
    await waitFor(() => expect(bff.resolveCalls).toHaveLength(2));

    const failedReconciliation = await openMenu();
    const retainedOpen = within(failedReconciliation).getByRole("menuitem", {
      name: "Open",
    });
    expect(retainedOpen.getAttribute("aria-disabled")).toBe("true");
    expect(retainedOpen).toHaveAccessibleDescription(
      "Refresh actions before trying this command again.",
    );
    expect(
      within(failedReconciliation).getByRole("menuitem", {
        name: "Retry actions",
      }),
    ).toBeTruthy();
  });
});
