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
import {
  UploadNeedsAttentionError,
  uploadIngestFile,
} from "@/lib/media/ingestionClient";
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
import AddPanel from "./AddPanel";
import MediaActivityPage from "./MediaActivityPage";
import { useAddContentSession } from "./useAddContentSession";

const ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const MEDIA_REF = `media:${MEDIA_ID}`;
const ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const RESOLVE_PATH = "/api/resource-items/action-snapshots/resolve";
const FACTS_REVISION = "3".repeat(64);
const UPLOAD_SESSION_HANDLE = "nup1.upload-session.signature";
const REJECTED_UPLOAD_SESSION_HANDLE = "nup1.rejected-session.signature";

const workspacePrimaryMetrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

function activityResponse() {
  return {
    data: {
      needs_attention_count: 1,
      active_count: 0,
      has_more: false,
      items: [
        {
          kind: "Media",
          media_id: MEDIA_ID,
          title: "A 712-page systems book",
          media_kind: "pdf",
          source_attempt_id: ATTEMPT_ID,
          state: {
            kind: "NeedsAttention",
            scope: "Source",
            stage: "Extract",
            failure_code: { kind: "Present", value: "E_SOURCE_TOO_LARGE" },
          },
          request_id: { kind: "Present", value: "req_activity_123" },
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

function activeActivityItem() {
  return {
    kind: "Media",
    media_id: "44444444-4444-4444-8444-444444444444",
    title: "A new web article",
    media_kind: "web_article",
    source_attempt_id: "55555555-5555-4555-8555-555555555555",
    state: {
      kind: "Active",
      status: "Processing",
      stage: "Extract",
      waiting_reason: { kind: "Absent" },
      progress: {
        kind: "Present",
        value: {
          kind: "Stage",
          stage: "Extract",
          run_count: 1,
          updated_at: "2026-08-07T12:01:00Z",
        },
      },
      status_code: { kind: "Absent" },
    },
    request_id: { kind: "Absent" },
    run_count: 1,
    queue_attempts: 1,
    queue_max_attempts: 4,
    created_at: "2026-08-07T12:00:00Z",
    updated_at: "2026-08-07T12:01:00Z",
    capabilities: {
      can_open: false,
      can_repair_source: false,
      can_repair_search: false,
      can_remove: false,
    },
  };
}

function uploadSessionItem(
  attention:
    | {
        kind: "TransportFailed";
        failure_kind: "Network";
        http_status: { kind: "Absent" };
      }
    | { kind: "VerificationFailed"; failure_code: "E_SOURCE_INTEGRITY" },
  options: {
    sessionHandle?: string;
    filename?: string;
  } = {},
) {
  return {
    kind: "UploadSession",
    session_handle: options.sessionHandle ?? UPLOAD_SESSION_HANDLE,
    filename: options.filename ?? "The Last Bakker.epub",
    document_kind: "Epub",
    expected_size_bytes: 4,
    attention,
    created_at: "2026-08-14T18:40:02Z",
    updated_at: "2026-08-14T18:40:34Z",
    capabilities: {
      can_retry_upload: attention.kind === "TransportFailed",
      can_remove: true,
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function futureUploadExpiry(): string {
  return new Date(Date.now() + 300_000).toISOString();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function ForegroundUploadAddPanel(): React.ReactElement {
  const session = useAddContentSession();
  return (
    <AddPanel
      session={session}
      dismissalConfirmation={null}
      onBack={() => {}}
      onClose={() => {}}
      onKeepWorking={() => {}}
      onConfirmDismissal={() => {}}
      onOpen={() => {}}
      onDefect={(error) => {
        throw error;
      }}
    />
  );
}

function renderForegroundUploadAddPanel() {
  return render(
    withRenderEnvironment(<ForegroundUploadAddPanel />, {
      initialViewport: "desktop",
    }),
  );
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
  readonly activity: () => unknown | Response;
  readonly capabilities?: readonly unknown[];
  readonly onDelete?: () => Response;
  readonly onUploadRequest?: (request: RecordedRequest) => Response | null;
}): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal(
    "fetch",
    async (target: RequestInfo | URL, init?: RequestInit) => {
      const request = target instanceof Request ? target : null;
      const url = new URL(request?.url ?? String(target), window.location.origin);
      const method = init?.method ?? request?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      const recorded = { path: url.pathname, method, body };
      requests.push(recorded);

      const uploadResponse = input.onUploadRequest?.(recorded);
      if (uploadResponse !== undefined && uploadResponse !== null) {
        return uploadResponse;
      }

      if (url.pathname === "/api/media/activity") {
        const activity = input.activity();
        return activity instanceof Response ? activity : jsonResponse(activity);
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

  it("renders server-ordered attention before active work and replays only the offered source repair", async () => {
    const base = activityResponse();
    const requests = installBff({
      activity: () => ({
        data: {
          ...base.data,
          active_count: 1,
          items: [...base.data.items, activeActivityItem()],
        },
      }),
    });

    renderActivity();

    expect(await screen.findByRole("heading", { name: "Activity" })).toBeVisible();
    expect(await screen.findByText("Needs repair")).toBeVisible();
    expect(screen.getByText("Extracting source")).toBeVisible();
    expect(screen.getByText("PDF")).toBeVisible();
    expect(screen.getByText(
      "1 import needs attention · 1 in progress",
    )).toBeVisible();
    expect(
      screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent),
    ).toEqual(["A 712-page systems book", "A new web article"]);
    const attentionCard = screen.getAllByRole("article")[0];
    if (attentionCard === undefined) throw new Error("Activity card is missing");
    await userEvent.click(within(attentionCard).getByText("Details"));
    expect(within(attentionCard).getByText(/Aug 7, 2026/)).toBeVisible();
    expect(within(attentionCard).getByText("E_SOURCE_TOO_LARGE")).toBeVisible();
    expect(within(attentionCard).getByText("req_activity_123")).toBeVisible();
    const pipeline = within(attentionCard).getByRole("list", {
      name: "Upload, validate, extract, index",
    });
    for (const step of ["Upload", "Validate", "Extract", "Index"]) {
      expect(within(pipeline).getByText(step)).toBeVisible();
    }
    expect(screen.queryByRole("button", { name: "Repair search" })).toBeNull();
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

  it("announces only a later attention-count change", async () => {
    let needsAttentionCount = 1;
    const base = activityResponse();
    const requests = installBff({
      activity: () => ({
        data: {
          ...base.data,
          needs_attention_count: needsAttentionCount,
          has_more: needsAttentionCount > base.data.items.length,
        },
      }),
    });

    renderActivity();

    await screen.findByText("Needs repair");
    const activityRequests = () =>
      requests.filter((request) => request.path === "/api/media/activity");
    await waitFor(() => expect(activityRequests()).toHaveLength(1));
    expect(
      screen.getAllByRole("status").map((status) => status.textContent),
    ).not.toContain("1 import needs attention.");

    await userEvent.click(screen.getByRole("button", { name: "Refresh activity" }));
    await waitFor(() => expect(activityRequests()).toHaveLength(2));
    expect(
      screen.getAllByRole("status").map((status) => status.textContent),
    ).toEqual(expect.not.arrayContaining(["1 import needs attention."]));

    needsAttentionCount = 2;
    await userEvent.click(screen.getByRole("button", { name: "Refresh activity" }));
    await waitFor(() => expect(activityRequests()).toHaveLength(3));
    await waitFor(() =>
      expect(
        screen.getAllByRole("status").map((status) => status.textContent),
      ).toContain("2 imports need attention."),
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
              state: {
                kind: "NeedsAttention",
                scope: "Search",
                stage: "Index",
                failure_code: { kind: "Absent" as const },
              },
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

  it("states when the server-trimmed attention and active snapshot is truncated", async () => {
    const base = activityResponse();
    installBff({
      activity: () => ({
        data: {
          ...base.data,
          needs_attention_count: 1,
          active_count: 22,
          has_more: true,
          items: [...base.data.items, activeActivityItem()],
        },
      }),
    });

    renderActivity();

    expect(await screen.findByText("Showing 2 of 23 imports.")).toBeVisible();
  });

  it("retries only the exact original upload and removes terminal verification failure", async () => {
    let retryPresent = true;
    let rejectedPresent = true;
    const requests = installBff({
      activity: () => {
        const items = [
          ...(retryPresent
            ? [
                uploadSessionItem({
                  kind: "TransportFailed",
                  failure_kind: "Network",
                  http_status: { kind: "Absent" },
                }),
              ]
            : []),
          ...(rejectedPresent
            ? [
                uploadSessionItem(
                  {
                    kind: "VerificationFailed",
                    failure_code: "E_SOURCE_INTEGRITY",
                  },
                  {
                    sessionHandle: REJECTED_UPLOAD_SESSION_HANDLE,
                    filename: "Rejected Bakker.epub",
                  },
                ),
              ]
            : []),
        ];
        return {
          data: {
            needs_attention_count: items.length,
            active_count: 0,
            has_more: false,
            items,
          },
        };
      },
      onUploadRequest: ({ path, method, body }) => {
        if (
          path === `/api/media/uploads/${UPLOAD_SESSION_HANDLE}/retry` &&
          method === "POST"
        ) {
          expect(body).toEqual({
            filename: "The Last Bakker.epub",
            content_type: "application/epub+zip",
            size_bytes: 4,
          });
          return jsonResponse({
            data: {
              kind: "UploadRequired",
              session_handle: UPLOAD_SESSION_HANDLE,
              generation: 2,
              method: "PUT",
              upload_url: "/signed-bakker-upload",
              required_headers: { "Content-Type": "application/epub+zip" },
              expires_at: futureUploadExpiry(),
              idempotency_outcome: "Reused",
            },
          });
        }
        if (path === "/signed-bakker-upload" && method === "PUT") {
          return new Response(null, { status: 200 });
        }
        if (
          path === `/api/media/uploads/${UPLOAD_SESSION_HANDLE}/confirm` &&
          method === "POST"
        ) {
          retryPresent = false;
          return jsonResponse({
            data: {
              kind: "Published",
              session_handle: UPLOAD_SESSION_HANDLE,
              media_id: MEDIA_ID,
              source_attempt_id: ATTEMPT_ID,
              idempotency_outcome: "Created",
            },
          });
        }
        if (
          path === `/api/media/uploads/${REJECTED_UPLOAD_SESSION_HANDLE}` &&
          method === "DELETE"
        ) {
          rejectedPresent = false;
          return new Response(null, { status: 204 });
        }
        return null;
      },
    });
    vi.stubGlobal("confirm", () => true);

    renderActivity();
    expect(
      await screen.findByRole("heading", { name: "The Last Bakker.epub" }),
    ).toBeVisible();
    expect(
      screen.getByRole("listitem", { current: "step", name: "Upload step" }),
    ).toBeVisible();
    expect(
      screen.getByRole("listitem", { current: "step", name: "Validate step" }),
    ).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Retry upload" }));
    const fileInput = screen.getByLabelText("Choose The Last Bakker.epub to retry upload");
    await userEvent.upload(
      fileInput,
      new File([new Uint8Array(4)], "different.epub", {
        type: "application/epub+zip",
      }),
    );
    expect(
      await screen.findByText(/Choose The Last Bakker\.epub \(4 bytes\)/),
    ).toBeVisible();
    expect(
      requests.filter((request) => request.path.endsWith("/retry")),
    ).toHaveLength(0);

    await userEvent.upload(
      fileInput,
      new File([new Uint8Array(4)], "The Last Bakker.epub", {
        type: "application/epub+zip",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Retry upload" })).toBeNull(),
    );
    expect(screen.getByText(/could not verify the uploaded bytes/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry upload" })).toBeNull();

    const rejectedCard = screen.getByRole("article", {
      name: "Rejected Bakker.epub upload",
    });
    await userEvent.click(within(rejectedCard).getByRole("button", { name: "Remove" }));
    expect(
      await screen.findByText("New import failures will appear here."),
    ).toBeVisible();
    expect(
      requests.filter(
        (request) =>
          request.path === `/api/media/uploads/${REJECTED_UPLOAD_SESSION_HANDLE}` &&
          request.method === "DELETE",
      ),
    ).toHaveLength(1);
  });

  it("keeps foreground file upload phases aligned with the HTTP boundary", async () => {
    const createSession = deferred<Response>();
    const directUpload = deferred<Response>();
    const reconciliationSession = deferred<Response>();
    const reconciliationUpload = deferred<Response>();
    const reconciliationConfirm = deferred<Response>();
    const requests: string[] = [];
    let createCount = 0;
    let uploadCount = 0;
    let confirmCount = 0;
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/api/media/uploads" && init?.method === "POST") {
          requests.push("create");
          createCount += 1;
          return createCount === 1
            ? createSession.promise
            : reconciliationSession.promise;
        }
        if (url.pathname === "/signed-add-panel-upload" && init?.method === "PUT") {
          requests.push("upload");
          uploadCount += 1;
          return uploadCount === 1
            ? directUpload.promise
            : reconciliationUpload.promise;
        }
        if (
          url.pathname === `/api/media/uploads/${UPLOAD_SESSION_HANDLE}/confirm` &&
          init?.method === "POST"
        ) {
          requests.push("confirm");
          confirmCount += 1;
          return confirmCount === 1
            ? jsonResponse(
                {
                  error: {
                    code: "E_UPSTREAM",
                    message: "Confirmation status is temporarily unavailable",
                  },
                },
                503,
              )
            : reconciliationConfirm.promise;
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url.pathname}`);
      },
    );

    renderForegroundUploadAddPanel();
    await userEvent.upload(
      screen.getByLabelText("Choose PDF or EPUB files"),
      new File([new Uint8Array([1])], "foreground.pdf", {
        type: "application/pdf",
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Add 1 item" }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Preparing…"),
    );
    expect(requests).toEqual(["create"]);

    createSession.resolve(
      jsonResponse({
        data: {
          kind: "UploadRequired",
          session_handle: UPLOAD_SESSION_HANDLE,
          generation: 1,
          method: "PUT",
          upload_url: "/signed-add-panel-upload",
          required_headers: { "Content-Type": "application/pdf" },
          expires_at: futureUploadExpiry(),
          idempotency_outcome: "Created",
        },
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Uploading…"),
    );
    expect(requests).toEqual(["create", "upload"]);

    directUpload.resolve(new Response(null, { status: 200 }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Verifying…"),
    );
    expect(requests).toEqual(["create", "upload", "confirm"]);

    expect(
      await screen.findByRole("button", { name: "Check status" }),
    ).toBeVisible();
    expect(screen.getByText("Acceptance status unknown")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Check status" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Preparing…"),
    );
    expect(requests).toEqual(["create", "upload", "confirm", "create"]);

    reconciliationSession.resolve(
      jsonResponse({
        data: {
          kind: "UploadRequired",
          session_handle: UPLOAD_SESSION_HANDLE,
          generation: 2,
          method: "PUT",
          upload_url: "/signed-add-panel-upload",
          required_headers: { "Content-Type": "application/pdf" },
          expires_at: futureUploadExpiry(),
          idempotency_outcome: "Reused",
        },
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Uploading…"),
    );
    expect(requests).toEqual(["create", "upload", "confirm", "create", "upload"]);

    reconciliationUpload.resolve(new Response(null, { status: 200 }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Verifying…"),
    );
    expect(requests).toEqual([
      "create",
      "upload",
      "confirm",
      "create",
      "upload",
      "confirm",
    ]);

    reconciliationConfirm.resolve(
      jsonResponse({
        data: {
          kind: "Published",
          session_handle: UPLOAD_SESSION_HANDLE,
          media_id: MEDIA_ID,
          source_attempt_id: ATTEMPT_ID,
          idempotency_outcome: "Created",
        },
      }),
    );
    await waitFor(() => expect(screen.getByText("Saved")).toBeVisible());
    expect(requests).toEqual([
      "create",
      "upload",
      "confirm",
      "create",
      "upload",
      "confirm",
    ]);
  });

  it("bounds direct PUT and records Timeout instead of Aborted", async () => {
    const signedUploadStarted = deferred<void>();
    const transportFailures: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/api/media/uploads") {
          return jsonResponse({
            data: {
              kind: "UploadRequired",
              session_handle: UPLOAD_SESSION_HANDLE,
              generation: 1,
              method: "PUT",
              upload_url: "/signed-timeout-upload",
              required_headers: { "Content-Type": "application/pdf" },
              expires_at: new Date(Date.now() + 1_000).toISOString(),
              idempotency_outcome: "Created",
            },
          });
        }
        if (url.pathname === "/signed-timeout-upload" && init?.method === "PUT") {
          signedUploadStarted.resolve(undefined);
          return await new Promise<Response>((_resolve, reject) => {
            const uploadSignal = init.signal;
            if (uploadSignal === null || uploadSignal === undefined) {
              reject(new Error("Direct upload fetch has no abort signal"));
              return;
            }
            const rejectForAbort = () => reject(uploadSignal.reason);
            if (uploadSignal.aborted) {
              rejectForAbort();
            } else {
              uploadSignal.addEventListener("abort", rejectForAbort, { once: true });
            }
          });
        }
        if (
          url.pathname ===
            `/api/media/uploads/${UPLOAD_SESSION_HANDLE}/transport-failure` &&
          init?.method === "POST"
        ) {
          transportFailures.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url.pathname}`);
      },
    );

    const upload = uploadIngestFile({
      file: new File([new Uint8Array([1])], "timeout.pdf", {
        type: "application/pdf",
      }),
      libraryIds: [],
      idempotencyKey: "media-upload-timeout",
    });
    await signedUploadStarted.promise;

    await expect(upload).rejects.toBeInstanceOf(UploadNeedsAttentionError);
    expect(transportFailures).toHaveLength(1);
    expect(transportFailures[0]).toMatchObject({
      kind: "Timeout",
      generation: 1,
    });
  });

  it("announces refresh failures assertively", async () => {
    installBff({
      activity: () =>
        jsonResponse(
          {
            error: {
              code: "E_UPSTREAM",
              message: "The import service is unavailable",
            },
          },
          503,
        ),
    });

    renderActivity();

    await waitFor(() =>
      expect(
        screen
          .getAllByRole("alert")
          .some(
            (alert) =>
              within(alert).queryByText("Activity couldn’t be loaded") !== null,
          ),
      ).toBe(true),
    );
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
          ? {
              data: {
                needs_attention_count: 0,
                active_count: 0,
                has_more: false,
                items: [],
              },
            }
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

    expect(await screen.findByText("1 import needs attention")).toBeVisible();
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
    // The committed removal re-reads Activity, so the row and attention
    // indicator disappear without waiting for the next poll.
    expect(
      await screen.findByText("New import failures will appear here."),
    ).toBeVisible();
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
