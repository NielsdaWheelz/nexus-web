import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import { ResourceActionRuntimeProvider } from "@/lib/actions/resourceActionRuntime";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { MediaActivityProvider } from "@/lib/media/MediaActivityProvider";
import { OfflineMediaProvider } from "@/lib/offlineMedia/OfflineMediaProvider";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import {
  ResourceActionOverlays,
  ResourceOverlaysProvider,
} from "@/lib/resources/resourceOverlaysController";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";
import { createDefaultWorkspaceState } from "@/lib/workspace/schema";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import MediaActivityPage from "./MediaActivityPage";

const ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const MEDIA_REF = `media:${MEDIA_ID}`;
const ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const RESOLVE_PATH = "/api/resource-items/action-snapshots/resolve";
const FACTS_REVISION = "3".repeat(64);

const workspacePrimaryMetrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

function activityResponse() {
  return {
    data: {
      nonterminal_count: 1,
      items: [
        {
          media_id: MEDIA_ID,
          title: "A 712-page systems book",
          media_kind: "pdf",
          source_attempt_id: ATTEMPT_ID,
          status: "NeedsAttention",
          stage: { kind: "Present", value: "Extract" },
          waiting_reason: { kind: "Absent" },
          failure_code: { kind: "Present", value: "E_SOURCE_TOO_LARGE" },
          request_id: { kind: "Present", value: "req_activity_123" },
          progress: {
            kind: "Present",
            value: {
              kind: "Counted",
              stage: "Extract",
              completed: 84,
              total: 712,
              unit: "Page",
              run_count: 2,
              updated_at: "2026-08-07T12:00:00Z",
            },
          },
          run_count: 2,
          queue_attempts: 4,
          queue_max_attempts: 4,
          created_at: "2026-08-07T11:00:00Z",
          updated_at: "2026-08-07T12:00:00Z",
          capabilities: {
            can_open: false,
            can_repair_source: true,
            can_repair_search: false,
            can_remove: true,
          },
        },
      ],
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The one media action snapshot the canonical dropdown resolves for the row.
 * A source the bounded parser rejected keeps exactly one capability: removal.
 */
function mediaSnapshot(capabilities: readonly unknown[]) {
  return {
    ref: MEDIA_REF,
    activation: {
      resourceRef: MEDIA_REF,
      kind: "route",
      href: `/media/${MEDIA_ID}`,
      unresolvedReason: null,
    },
    missing: false,
    factsRevision: FACTS_REVISION,
    capabilities,
  };
}

interface RecordedRequest {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
}

/**
 * The BFF boundary. Activity and the resource-action snapshot resolve are the
 * system under test; the surrounding providers' mount-time chatter is answered
 * benignly so the tree mounts.
 */
function installBff(input: {
  readonly activity: () => unknown;
  readonly capabilities?: readonly unknown[];
  readonly onDelete?: () => Response;
}): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal(
    "fetch",
    async (target: RequestInfo | URL, init?: RequestInit) => {
      const request = target instanceof Request ? target : null;
      const url = new URL(request?.url ?? String(target), window.location.origin);
      const method = init?.method ?? request?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      requests.push({ path: url.pathname, method, body });

      if (url.pathname === "/api/media/activity") {
        return jsonResponse(input.activity());
      }
      if (url.pathname === `/api/media/${MEDIA_ID}/repair`) {
        return jsonResponse(
          {
            data: {
              media_id: MEDIA_ID,
              scope: (body as { scope: string }).scope,
              job_id: JOB_ID,
            },
          },
          202,
        );
      }
      if (url.pathname === RESOLVE_PATH && method === "POST") {
        const refs: string[] = Array.isArray((body as { refs?: unknown })?.refs)
          ? (body as { refs: string[] }).refs
          : [];
        return jsonResponse({
          data: {
            snapshots: refs.map(() => mediaSnapshot(input.capabilities ?? [])),
          },
        });
      }
      if (url.pathname === `/api/media/${MEDIA_ID}` && method === "DELETE") {
        if (!input.onDelete) throw new Error("Unexpected media deletion");
        return input.onDelete();
      }
      if (url.pathname === "/api/lectern") {
        return jsonResponse({ data: { items: [] } });
      }
      return jsonResponse({ data: null });
    },
  );
  return requests;
}

function renderActivity() {
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
                    "/nexus",
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
                                <MediaActivityProvider>
                                  <MediaActivityPage
                                    onBack={() => undefined}
                                    onOpenMedia={() => undefined}
                                  />
                                </MediaActivityProvider>
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

describe("Nexus Activity workflow", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders factual progress and replays only the offered source repair", async () => {
    const requests = installBff({ activity: activityResponse });

    const view = renderActivity();

    expect(await screen.findByRole("heading", { name: "Activity" })).toBeVisible();
    expect(await screen.findByText("Needs repair")).toBeVisible();
    expect(screen.getByText("Extracting page 84 of 712")).toBeVisible();
    expect(screen.getByText("PDF")).toBeVisible();
    await userEvent.click(screen.getByText("Details"));
    expect(screen.getByText(/Aug 7, 2026/)).toBeVisible();
    expect(screen.getByText("E_SOURCE_TOO_LARGE")).toBeVisible();
    expect(screen.getByText("req_activity_123")).toBeVisible();
    const pipeline = screen.getByRole("list", {
      name: "Upload, validate, extract, index",
    });
    for (const step of ["Upload", "Validate", "Extract", "Index"]) {
      expect(within(pipeline).getByText(step)).toBeVisible();
    }
    expect(screen.queryByRole("button", { name: "Repair search" })).toBeNull();
    expect(view.container.textContent).not.toMatch(
      /%|\bETA\b|out of memory|\/host\//i,
    );
    expect(
      requests.filter((request) => request.path === "/api/media/activity"),
      "mount and opening refreshes were not single-flight",
    ).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "Repair source" }));

    await vi.waitFor(() =>
      expect(
        requests.filter((request) => request.path.endsWith("/repair")),
      ).toEqual([
        {
          path: `/api/media/${MEDIA_ID}/repair`,
          method: "POST",
          body: { scope: "Source" },
        },
      ]),
    );
    await vi.waitFor(() =>
      expect(
        requests.filter((request) => request.path === "/api/media/activity")
          .length,
      ).toBeGreaterThanOrEqual(2),
    );
  });

  it("sends Search only for an exact search repair capability", async () => {
    const base = activityResponse();
    const item = base.data.items[0]!;
    const requests = installBff({
      activity: () => ({
        data: {
          ...base.data,
          items: [
            {
              ...item,
              failure_code: { kind: "Absent" as const },
              request_id: { kind: "Absent" as const },
              capabilities: {
                ...item.capabilities,
                can_repair_source: false,
                can_repair_search: true,
              },
            },
          ],
        },
      }),
    });

    renderActivity();
    await userEvent.click(
      await screen.findByRole("button", { name: "Repair search" }),
    );

    await vi.waitFor(() =>
      expect(
        requests
          .filter((request) => request.path.endsWith("/repair"))
          .map((request) => request.body),
      ).toEqual([{ scope: "Search" }]),
    );
    expect(screen.queryByRole("button", { name: "Repair source" })).toBeNull();
    expect(screen.queryByText("Code")).toBeNull();
    expect(screen.queryByText("Request ID")).toBeNull();
  });

  it("removes a terminally rejected source through the canonical resource dropdown", async () => {
    // The stuck row: the bounded parser rejected the source, so nothing is
    // repairable or openable. Removal is the only remaining verb, and it is
    // offered by the shared resource menu — never a page-local delete button.
    const base = activityResponse();
    const item = base.data.items[0]!;
    let removed = false;
    const requests = installBff({
      activity: () =>
        removed
          ? { data: { nonterminal_count: 0, items: [] } }
          : {
              data: {
                ...base.data,
                items: [
                  {
                    ...item,
                    capabilities: {
                      can_open: false,
                      can_repair_source: false,
                      can_repair_search: false,
                      can_remove: true,
                    },
                  },
                ],
              },
            },
      capabilities: [{ kind: "RemoveMedia", availability: { kind: "Available" } }],
      onDelete: () => {
        removed = true;
        return jsonResponse({
          data: {
            kind: "Removed",
            removedFromLibraryIds: [],
            remainingReferenceCount: 0,
            libraryEntriesCollectionRevision: 7,
          },
        });
      },
    });
    vi.stubGlobal("confirm", () => true);

    renderActivity();

    expect(await screen.findByText("1 open item")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Repair source" })).toBeNull();
    const trigger = await screen.findByRole("button", {
      name: "More actions for A 712-page systems book",
    });
    await waitFor(() => expect(trigger).toBeEnabled());
    await userEvent.click(trigger);
    const remove = within(screen.getByRole("menu")).getByRole("menuitem", {
      name: "Remove from Nexus",
    });

    await userEvent.click(remove);

    await vi.waitFor(() =>
      expect(
        requests.filter(
          (request) =>
            request.path === `/api/media/${MEDIA_ID}` &&
            request.method === "DELETE",
        ),
      ).toHaveLength(1),
    );
    // The committed removal re-reads Activity, so the row and the open-items
    // badge drop without waiting for the next poll.
    expect(await screen.findByText("No recent media work")).toBeVisible();
    expect(screen.getByText("0 open items")).toBeVisible();
  });

  it("offers no resource dropdown for an item that cannot be removed", async () => {
    const base = activityResponse();
    const item = base.data.items[0]!;
    installBff({
      activity: () => ({
        data: {
          ...base.data,
          items: [
            {
              ...item,
              capabilities: { ...item.capabilities, can_remove: false },
            },
          ],
        },
      }),
      capabilities: [
        { kind: "RemoveMedia", availability: { kind: "Available" } },
      ],
    });

    renderActivity();

    // The row still renders its offered repair...
    expect(
      await screen.findByRole("button", { name: "Repair source" }),
    ).toBeVisible();
    // ...but a non-removable item exposes no resource menu at all, so no
    // removal can be reached from this surface.
    expect(
      screen.queryByRole("button", {
        name: "More actions for A 712-page systems book",
      }),
      "a non-removable Activity item wrongly rendered the resource dropdown",
    ).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
