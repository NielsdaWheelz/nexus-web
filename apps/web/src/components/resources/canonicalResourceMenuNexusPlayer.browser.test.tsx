import { createRef, type ReactNode } from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
import {
  ResourceActionRuntimeProvider,
  useResourceActionMenuModel,
} from "@/lib/actions/resourceActionRuntime";
import {
  ResourceActionOverlays,
  ResourceOverlaysProvider,
} from "@/lib/resources/resourceOverlaysController";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import {
  createDefaultWorkspaceState,
  getWorkspacePrimaryPanes,
} from "@/lib/workspace/schema";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";
import {
  useWorkspaceStore,
  WorkspaceStoreProvider,
} from "@/lib/workspace/store";
import { absent, present } from "@/lib/api/presence";
import {
  assumeMediaId,
  type FooterAudioActivation,
  type PlayerDescriptor,
} from "@/lib/lectern/contract";
import { projectNexusSearchEntries } from "@/lib/nexus/results";
import type { SearchResultRowViewModel } from "@/lib/search/types";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import SwitchboardRow from "@/components/switchboard/SwitchboardRow";
import Nexus from "@/components/nexus/Nexus";
import DesktopListeningShelf from "@/components/player/DesktopListeningShelf";
import type { PresentPlayerChrome } from "@/components/player/PlayerControls";
import type { PlayerCaptureController } from "@/lib/walknotes/usePlayerCapture";

// LEAF-slice proof (Nexus + players). The system under test is the shared,
// canonical resource dropdown rendered by two leaf surfaces:
//   1. a resource Nexus/switchboard row whose secondary/overflow menu comes
//      from the shared semantic model, and
//   2. a now-playing media player (its recording actions are ResourceActionMenu,
//      and the player-controls menu no longer carries Player.OpenTrack /
//      Player.OpenSource).
// Only the BFF fetch boundary is stubbed; the real runtime, planner, catalog,
// and ActionMenu compose the observed menu.

const ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const MEDIA_REF = `media:${MEDIA_ID}`;
const MEDIA_HREF = `/media/${MEDIA_ID}`;
const RESOLVE_PATH = "/api/resource-items/action-snapshots/resolve";
const MEDIA_FACTS_REVISION = "6".repeat(64);
const MISSING_FACTS_REVISION = "0".repeat(64);

const workspacePrimaryMetrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

const mediaSubject = {
  ref: canonicalResourceRef({ scheme: "media", id: MEDIA_ID }),
};
const mediaActivation = {
  resourceRef: MEDIA_REF,
  kind: "route" as const,
  href: MEDIA_HREF,
  unresolvedReason: null,
};

// A schema-valid media snapshot whose capabilities arrive out of catalog order
// and span several semantic groups plus a Danger action, so the observed menu
// proves the shared planner — not the surface — owns membership and order. It
// includes the canonical Lectern relationship (Absent -> "Add to Lectern").
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
    {
      kind: "LecternMembership",
      availability: { kind: "Available" },
      state: "Absent",
    },
    { kind: "Open", availability: { kind: "Available" } },
    { kind: "Share", availability: { kind: "Available" } },
  ],
} as const;

// Catalog-owned semantic-group order with Danger terminal. This
// is the AC1/AC3 oracle — from the catalog + planner, not the wire order above.
const EXPECTED_MENU_ORDER = [
  "Open",
  "Add to Lectern",
  "Chat about this…",
  "Share…",
  "Remove from Nexus",
];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

interface Bff {
  readonly resolveCalls: unknown[];
}

function installBff(): Bff {
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
      const path = url.pathname;

      if (path === RESOLVE_PATH && method === "POST") {
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
      if (path === "/api/lectern") {
        return jsonResponse({ data: { items: [] } });
      }
      // Every other mount-time BFF chatter (workspace/player runtime, etc.) is
      // not the system under test; answer benignly so the tree mounts.
      return jsonResponse({ data: null });
    },
  );
  return { resolveCalls };
}

function renderInRuntime(node: ReactNode) {
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
                                {node}
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

// A top-level media search row carrying primary Open and one action subject.
function mediaSearchRow(): SearchResultRowViewModel {
  return {
    key: "row-1",
    score: 1,
    resourceRef: MEDIA_REF,
    ownerResourceRef: MEDIA_REF,
    activation: mediaActivation,
    actionSubject: mediaSubject,
    citationTarget: null,
    paneLabelHint: "Field Recording",
    type: "media",
    mediaId: MEDIA_ID,
    contextRef: null,
    typeLabel: "Media",
    primaryText: "Field Recording",
    snippetSegments: [],
    sourceMeta: null,
    publicationDate: absent(),
    contributorCredits: [],
    noteBody: null,
    noteOrigin: null,
  };
}

function footerActivation(): FooterAudioActivation {
  return {
    kind: "FooterAudio",
    streamUrl: "https://external.invalid/audio.mp3",
    sourceUrl: "https://external.invalid/source",
    positionMs: 0,
    writeRevision: 0,
    resetEpoch: 0,
    playbackRate: { value: 1, source: "Product", podcastPreference: absent() },
    pauseShorteningMode: absent(),
    consumptionOverrideRevision: absent(),
    durationMs: present(120_000),
    artworkUrl: absent(),
    chapters: [],
  };
}

function canonicalPlayerModel(): PresentPlayerChrome {
  const descriptor: PlayerDescriptor = {
    mediaId: assumeMediaId(MEDIA_ID),
    title: "Field Recording",
    subtitle: absent(),
    activation: footerActivation(),
  };
  return {
    kind: "Canonical",
    state: {
      kind: "Active",
      session: { descriptor, origin: { kind: "Direct" } },
      phase: "Paused",
    },
    persistence: { kind: "Ready" },
    nextPreview: { kind: "None" },
  };
}

function noopCapture(): PlayerCaptureController {
  return {
    waypointCount: 0,
    isRecording: false,
    reviewOpen: false,
    announcement: "",
    openReview: () => {},
    closeReview: () => {},
    announceMaterialized: () => {},
    captureTap: () => {},
    handlePointerDown: () => {},
    handlePointerUp: () => {},
    handlePointerCancel: () => {},
    closeForPlayerDismissal: () => {},
  };
}

// Reads the identity of the pane the workspace is currently showing. The Nexus
// controller observes exactly this to decide whether a navigation landed behind
// the modal.
function WorkspaceLocationProbe() {
  const { state } = useWorkspaceStore();
  const active = getWorkspacePrimaryPanes(state).find(
    (pane) => pane.id === state.activePrimaryPaneId,
  );
  return (
    <output aria-label="Active workspace location">
      {active?.currentVisit.href ?? ""}
    </output>
  );
}

// Stands in for a resource Nexus/switchboard row's overflow: it renders the
// SAME canonical descriptors the migrated rows render for `actionSubject`
// (`useResourceActionMenuModel`), so selecting one fires the identical,
// Nexus-unaware resource-runtime dispatch. Rendered as a sibling of the Nexus so
// the click can be dispatched without contending with the modal overlay.
function ResourceActionProbe({
  actionSubject,
}: {
  actionSubject: typeof mediaSubject;
}) {
  const model = useResourceActionMenuModel(actionSubject);
  return (
    <div aria-label="Resource overflow probe">
      {model.descriptors.map((descriptor) =>
        descriptor.kind === "command" ? (
          <button
            key={descriptor.id}
            type="button"
            onClick={(event) =>
              descriptor.onSelect({ triggerEl: event.currentTarget })
            }
          >
            {descriptor.label}
          </button>
        ) : null,
      )}
    </div>
  );
}

describe("canonical resource dropdown on the Nexus + player leaf surfaces", () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    await page.viewport(1_280, 800);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
    await page.viewport(1_280, 800);
  });

  it("gives a resource switchboard row the shared canonical semantic plan", async () => {
    installBff();

    // A media search row becomes a resource entry carrying its subject and
    // primary Open activation; secondary actions remain peer/view controls.
    const [entry] = projectNexusSearchEntries({
      query: "field",
      rows: [mediaSearchRow()],
      panes: [],
      frecencyByHref: {},
    });
    expect(
      entry,
      "the media search row did not project a resource entry",
    ).toBeTruthy();
    expect(
      entry!.actionSubject?.ref,
      "the resource entry did not carry its canonical resource identity",
    ).toBe(MEDIA_REF);
    expect(
      entry!.secondaryActions,
      "the resource entry still carried a private NexusAction secondary array",
    ).toEqual([]);
    expect(
      entry!.primaryAction.availability.kind === "Available" &&
        entry!.primaryAction.availability.target.kind,
      "the resource entry lost its primary Open activation",
    ).toBe("ResourceOpen");

    renderInRuntime(
      <SwitchboardRow
        entry={entry!}
        active={false}
        onActive={() => {}}
        onActivate={() => {}}
        onUnavailable={() => {}}
      />,
    );

    // The row's always-present overflow becomes enabled once the snapshot is
    // ready (zero network on open). Opening it shows the canonical dropdown.
    const trigger = await screen.findByRole("button", {
      name: "Actions for Field Recording",
    });
    await waitFor(() => expect(trigger).toBeEnabled());
    await userEvent.click(trigger);
    const menu = screen.getByRole("menu");
    const names = within(menu).getAllByRole("none").map((container) => {
      const item =
        within(container).queryByRole("menuitem") ??
        within(container).getByRole("menuitemcheckbox");
      return item.textContent?.trim() ?? "";
    });

    expect(
      names,
      "the resource row did not render the shared catalog-ordered dropdown",
    ).toEqual(EXPECTED_MENU_ORDER);
    // Open is retained in the menu even though it is the row primary (AC3).
    expect(names[0]).toBe("Open");
    // The canonical Lectern relationship appears exactly once, as the
    // state-machine verb "Add to Lectern".
    expect(names.filter((name) => name === "Add to Lectern")).toHaveLength(1);
    expect(
      within(menu).queryByRole("menuitem", { name: /queue-add/i }),
      "a residual ad-hoc queue-add action survived on the resource row",
    ).toBeNull();
  });

  it("renders the now-playing media's canonical dropdown and drops Player.OpenTrack/Player.OpenSource", async () => {
    const bff = installBff();

    renderInRuntime(
      <DesktopListeningShelf
        model={canonicalPlayerModel()}
        capture={noopCapture()}
        onOpenTarget={() => {}}
        onOpenLectern={() => {}}
        onOpenPlayback={() => {}}
        onDismiss={() => {}}
        suspended={false}
        playbackButtonRef={createRef<HTMLButtonElement>()}
      />,
    );

    // The player's recording actions are the ONE canonical ResourceActionMenu,
    // wired to the now-playing media resource. Its trigger appears once the
    // media snapshot is ready, then opens the shared catalog-ordered dropdown.
    const recordingActions = await screen.findByRole("button", {
      name: "Recording actions",
    });
    await waitFor(() => expect(recordingActions).toBeEnabled());
    await userEvent.click(recordingActions);
    const resourceMenu = screen.getByRole("menu");
    expect(
      within(resourceMenu).getByRole("menuitem", { name: "Open" }),
      "the player's canonical resource menu did not expose Open",
    ).toBeTruthy();
    // It resolved the now-playing media's canonical ref.
    expect(bff.resolveCalls).toContainEqual({ refs: [MEDIA_REF] });
    await userEvent.keyboard("{Escape}");

    // The player-controls menu is a separate non-resource control and carries
    // neither recording navigation nor source navigation.
    const playerControls = await screen.findByRole("button", {
      name: "More player controls",
    });
    await userEvent.click(playerControls);
    const controlsMenu = screen.getByRole("menu");
    expect(
      within(controlsMenu).queryByRole("menuitem", { name: "Open recording" }),
      "the player-controls menu still carried the deleted Player.OpenTrack item",
    ).toBeNull();
    expect(
      within(controlsMenu).queryByRole("menuitem", { name: "Open source" }),
      "the player-controls menu still carried the deleted Player.OpenSource item",
    ).toBeNull();
    expect(
      within(controlsMenu).queryByRole("menuitem", { name: "Open preview" }),
      "a canonical recording wrongly exposed the preview-only open control",
    ).toBeNull();
  });

  // FIX 1 proof. The resource overflow dropdown dispatches through the shared,
  // Nexus-unaware resource runtime (invoke), so a navigating action activates a
  // pane WITHOUT any menu->Nexus callback (there is none by contract). The open
  // full-screen Nexus must observe the workspace navigation and dismiss, or the
  // destination pane opens behind it (AC3: dropdown Open closes the Nexus too).
  it("dismisses the open Nexus when a resource overflow action navigates a pane", async () => {
    window.history.replaceState({}, "", "/libraries");
    installBff();
    renderInRuntime(
      <>
        <WorkspaceLocationProbe />
        <ResourceActionProbe actionSubject={mediaSubject} />
        <Nexus />
      </>,
    );

    const probe = screen.getByLabelText("Resource overflow probe");
    const openAction = await within(probe).findByRole("button", {
      name: "Open",
    });

    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    await screen.findByRole("dialog", { name: "Nexus" });
    expect(
      screen.getByRole("status", { name: "Active workspace location" }),
      "the workspace did not start on the pre-navigation location",
    ).toHaveTextContent("/libraries");

    // Real runtime + shared workspace store: Open activates the media pane.
    fireEvent.click(openAction);

    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Active workspace location" }),
        "the resource Open never activated the destination pane",
      ).toHaveTextContent(MEDIA_HREF),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Nexus" }),
        "the destination pane activated behind a still-open Nexus (FIX 1 regressed)",
      ).toBeNull(),
    );
  });

  // FIX 1 over-close guard. A resource action that does not activate a pane must
  // leave the Nexus open. Declining the shared danger confirm makes this a pure
  // no-navigation path, proving the observation fires only on real navigation —
  // never on unrelated resource-runtime work (Add to Lectern, Share, etc.).
  it("leaves the open Nexus open when a resource overflow action does not navigate", async () => {
    window.history.replaceState({}, "", "/libraries");
    installBff();
    // Decline the Danger confirmation: removal performs no navigation.
    vi.stubGlobal("confirm", () => false);
    renderInRuntime(
      <>
        <WorkspaceLocationProbe />
        <ResourceActionProbe actionSubject={mediaSubject} />
        <Nexus />
      </>,
    );

    const probe = screen.getByLabelText("Resource overflow probe");
    const removeAction = await within(probe).findByRole("button", {
      name: "Remove from Nexus",
    });

    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    await screen.findByRole("dialog", { name: "Nexus" });

    fireEvent.click(removeAction);

    // Flush the runtime's async dispatch; nothing navigates, so no dismissal is
    // ever scheduled and the Nexus (and the active location) stay put.
    await Promise.resolve();
    await Promise.resolve();
    expect(
      screen.getByRole("dialog", { name: "Nexus" }),
      "a non-navigating resource action wrongly dismissed the Nexus",
    ).toBeTruthy();
    expect(
      screen.getByRole("status", { name: "Active workspace location" }),
    ).toHaveTextContent("/libraries");
  });
});
