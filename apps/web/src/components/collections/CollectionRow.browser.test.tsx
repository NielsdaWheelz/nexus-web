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
import { absent, present } from "@/lib/api/presence";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import type { CollectionRowView } from "@/lib/collections/types";
import type { SortableActivatorProps } from "@/components/sortable/SortableList";
import CollectionRow from "./CollectionRow";

// The system under test is CollectionRow's single contextual menu wired to the
// real resource runtime, planner, catalog, and ActionMenu. Only the BFF fetch
// boundary is stubbed: deliberately scrambled capabilities prove the canonical
// resource suffix remains planner-owned. A second external row proves More is
// absent when no row action exists.

const ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const MEDIA_REF = `media:${MEDIA_ID}`;
const MEDIA_HREF = `/media/${MEDIA_ID}`;
const RESOLVE_PATH = "/api/resource-items/action-snapshots/resolve";
const MEDIA_FACTS_REVISION = "3".repeat(64);
const MISSING_FACTS_REVISION = "0".repeat(64);

const workspacePrimaryMetrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

const mediaSubject = {
  ref: canonicalResourceRef({ scheme: "media", id: MEDIA_ID }),
};

// A schema-valid resolve response with capabilities intentionally out of catalog
// order, spanning all seven groups, so the row menu proves catalog order with
// Danger terminal regardless of the wire order.
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
    {
      kind: "Recovery",
      availability: { kind: "Available" },
      offer: {
        kind: "RetrySource",
        expectedAttemptId: "44444444-4444-4444-8444-444444444444",
        input: "RefetchSource",
      },
    },
    { kind: "Share", availability: { kind: "Available" } },
    {
      kind: "LecternMembership",
      availability: { kind: "Available" },
      state: "Absent",
    },
  ],
} as const;

const EXPECTED_MENU_ORDER = [
  "Open",
  "Mark as finished",
  "Libraries…",
  "Add to Lectern",
  "Chat about this…",
  "Share…",
  "Retry source processing",
  "Remove from Nexus",
];

const SNAPSHOTS_BY_REF: Record<string, unknown> = {
  [MEDIA_REF]: MEDIA_SNAPSHOT,
};

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
      if (path === "/api/lectern") {
        return jsonResponse({ data: { items: [] } });
      }
      // Every other mount-time BFF chatter is not the system under test; answer
      // benignly so the tree mounts.
      return jsonResponse({ data: null });
    },
  );
  return { resolveCalls };
}

function baseRow(overrides: Partial<CollectionRowView>): CollectionRowView {
  return {
    id: MEDIA_ID,
    kind: "media",
    primary: { kind: "link", href: MEDIA_HREF, paneLabelHint: "Field Guide" },
    title: { text: "Field Guide" },
    contributors: [],
    publicationDate: absent(),
    context: absent(),
    activity: absent(),
    exceptionalStatus: absent(),
    localAvailability: absent(),
    connections: absent(),
    relatedMediaId: absent(),
    actionSubject: mediaSubject,
    selected: false,
    ...overrides,
  };
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

function renderRow(
  row: CollectionRowView,
  reorder?: SortableActivatorProps,
) {
  return renderInRuntime(
    <CollectionRow row={row} as="div" reorder={reorder} />,
  );
}

function reorderActivator(
  overrides: Partial<SortableActivatorProps> = {},
): SortableActivatorProps {
  return {
    setActivatorNodeRef: vi.fn(),
    listeners: {},
    canMoveUp: true,
    canMoveDown: true,
    disabled: false,
    isDragging: false,
    moveUp: vi.fn(),
    moveDown: vi.fn(),
    consumeClickSuppression: vi.fn(() => false),
    ...overrides,
  };
}

function menuLabels(menu: HTMLElement): string[] {
  return within(menu).getAllByRole("none").map((container) => {
    const item =
      within(container).queryByRole("menuitem") ??
      within(container).getByRole("menuitemcheckbox");
    return item.textContent?.trim() ?? "";
  });
}

describe("CollectionRow resource dropdown", () => {
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

  it("composes occurrence commands before the canonical resource suffix", async () => {
    const bff = installBff();
    const reorder = reorderActivator({ canMoveUp: false });
    renderRow(
      baseRow({
        connections: present({
          total: 1,
          dominantKind: absent(),
          topPeers: [
            {
              ref: "media:22222222-2222-4222-8222-222222222222",
              scheme: "media",
              id: "22222222-2222-4222-8222-222222222222",
              label: "Connected essay",
              description: null,
              activation: {
                resourceRef: "media:22222222-2222-4222-8222-222222222222",
                kind: "route",
                href: "/media/22222222-2222-4222-8222-222222222222",
                unresolvedReason: null,
              },
              href: "/media/22222222-2222-4222-8222-222222222222",
              missing: false,
            },
          ],
        }),
      }),
      reorder,
    );

    const trigger = await screen.findByRole("button", {
      name: "More actions for Field Guide",
    });
    await waitFor(() => expect(trigger).toBeEnabled());
    expect(
      screen.getAllByRole("button", { name: "More actions for Field Guide" }),
      "a sortable resource row must have exactly one visible More trigger",
    ).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: "Reorder Field Guide" }),
      "reorder must not retain a separate row control",
    ).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "Show connections and related for Field Guide",
      }),
      "connections must not retain a separate row control",
    ).toBeNull();
    await userEvent.click(trigger);
    const menu = screen.getByRole("menu");

    const names = menuLabels(menu);
    expect(
      names,
      "row occurrence commands must precede the unchanged canonical resource suffix",
    ).toEqual([
      "Move up",
      "Move down",
      "Show connections and related",
      ...EXPECTED_MENU_ORDER,
    ]);
    const moveUp = screen.getByRole("menuitem", { name: "Move up" });
    expect(moveUp).toHaveAttribute("aria-disabled", "true");
    expect(moveUp).toHaveAccessibleDescription("This item is already first");

    expect(bff.resolveCalls).toHaveLength(1);
    expect(bff.resolveCalls[0]).toEqual({ refs: [MEDIA_REF] });
  });

  it("renders no resource menu for a non-resource (external) row", async () => {
    installBff();
    renderRow(
      baseRow({
        id: "external-essay",
        kind: "contributor_work",
        primary: {
          kind: "link",
          href: "https://example.com/essay",
          paneLabelHint: "External Essay",
        },
        title: { text: "External Essay" },
        // A non-resource / external row is a plain link with no action subject.
        actionSubject: null,
      }),
    );

    // The plain link renders...
    expect(
      await screen.findByRole("link", { name: "External Essay" }),
    ).toBeTruthy();
    // ...but there is NO resource dropdown of any kind on the row.
    expect(
      screen.queryByRole("button", { name: "More actions for External Essay" }),
      "an external / non-resource row wrongly rendered a resource menu",
    ).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
