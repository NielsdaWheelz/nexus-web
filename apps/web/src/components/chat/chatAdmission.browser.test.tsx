/// <reference types="vite/client" />

import { ArtworkProvider } from "@/lib/media/ArtworkProvider";
import { ARTWORK_CAPACITY } from "@/lib/media/artworkCapacity";
import { ResourceCacheProvider } from "@/lib/api/resourceCache";
import { READER_CAPACITY } from "@/lib/reader/readerCapacity";
import {
  Component,
  useState,
  type ReactNode,
  type ComponentProps,
} from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { page, userEvent } from "vitest/browser";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import "@/app/globals.css";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import ChatComposer from "./ChatComposer";
import {
  GENERATION_CATALOG_RESPONSE,
  RUN_SELECTION,
} from "@/__tests__/helpers/generationCatalog";
import { invalidateGenerationCatalogCache } from "./useGenerationCatalog";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import type { ChatRunResponse } from "@/lib/conversations/types";
import { readerHighlightChatIntent } from "@/lib/conversations/readerHighlightChatIntent";
import corpus from "../../../../../testdata/contracts/chat-admission-receipts.json";
import WorkspaceHost from "@/components/workspace/WorkspaceHost";
import { preloadPane } from "@/lib/panes/paneRenderRegistry";
import {
  WorkspaceStoreProvider,
  useWorkspaceStore,
} from "@/lib/workspace/store";
import {
  createPaneVisit,
  createEmptyPaneHistory,
  createWorkspaceStateFromPrimaryPanes,
} from "@/lib/workspace/schema";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { OfflineMediaProvider } from "@/lib/offlineMedia/OfflineMediaProvider";
import { OfflineReadingProvider } from "@/lib/offlineReading/OfflineReadingProvider";
import { ResourceOverlaysProvider } from "@/lib/resources/resourceOverlaysController";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import { ResourceActionRuntimeProvider } from "@/lib/actions/resourceActionRuntime";

const draftModules = import.meta.glob<
  typeof import("@/lib/conversations/chatDraftStore")
>("/src/lib/conversations/chatDraftStore.ts");
const readModules = import.meta.glob<
  typeof import("@/lib/conversations/chatAdmissionRead")
>("/src/lib/conversations/chatAdmissionRead.ts");
const receiptModules = import.meta.glob<
  typeof import("@/lib/conversations/chatAdmission")
>("/src/lib/conversations/chatAdmission.ts");
const selectionModules = import.meta.glob<
  typeof import("./usePendingReaderSelection")
>("./usePendingReaderSelection.ts");
const cutoverModules = import.meta.glob<
  typeof import("../../__tests__/helpers/chatAdmission")
>("../../__tests__/helpers/chatAdmission.ts");
let cutoverSupport:
  | typeof import("../../__tests__/helpers/chatAdmission")
  | null = null;

function requireCutoverSupport(): NonNullable<typeof cutoverSupport> {
  if (cutoverSupport === null) {
    expect(
      cutoverSupport,
      "the final chat admission adoption owner is absent",
    ).not.toBeNull();
    throw new Error("unreachable after the BASE sensitivity assertion");
  }
  return cutoverSupport;
}

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const ASSISTANT = "33333333-3333-4333-8333-333333333333";
const USER = "44444444-4444-4444-8444-444444444444";
const TIME = "2026-09-09T12:00:00Z";
function admittedView(): ChatRunResponse {
  const message = {
    trust_trail: null,
    citations: [],
    reader_selection: { kind: "Absent" as const },
    status: "complete" as const,
    can_rerun: false,
    can_regenerate: false,
    created_at: TIME,
    updated_at: TIME,
  };
  return {
    data: {
      run: {
        id: B,
        status: "complete",
        conversation_id: A,
        user_message_id: USER,
        assistant_message_id: ASSISTANT,
        run_selection: RUN_SELECTION,
        support_id: { kind: "Absent" },
        publication_warning: { kind: "Absent" },
        failure: null,
        execution: { kind: "Absent" },
        cancel_requested_at: null,
        started_at: TIME,
        completed_at: TIME,
        error_code: null,
        created_at: TIME,
        updated_at: TIME,
      },
      conversation: {
        id: A,
        title: "Admitted conversation",
        sharing: "private",
        message_count: 2,
        created_at: TIME,
        updated_at: TIME,
      },
      user_message: {
        ...message,
        id: USER,
        seq: 1,
        role: "user",
        message_document: {
          type: "message_document",
          blocks: [
            { type: "text", format: "plain", text: "Keep this question" },
          ],
        },
      },
      assistant_message: {
        ...message,
        id: ASSISTANT,
        seq: 2,
        role: "assistant",
        message_document: {
          type: "message_document",
          blocks: [
            { type: "text", format: "markdown", text: "Canonical answer" },
          ],
        },
      },
      stream_state: {
        status: "complete",
        last_event_seq: 1,
        folded_event_seq: 1,
        assistant_current_text: "Canonical answer",
        tool_calls: [],
        activity: null,
        reconnectable: false,
        terminal: true,
      },
    },
  };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p role="alert">Pane defect</p>
    ) : (
      this.props.children
    );
  }
}
function composer(
  targetId = A,
  props: Partial<ComponentProps<typeof ChatComposer>> = {},
  accountId = A,
) {
  return withChatAccount(
    <Boundary>
      <p>Existing answer</p>
      <ChatComposer
        conversationId={targetId}
        viewIdentity={`test:${targetId}`}
        isPaneActive={true}
        onAdmitted={requireCutoverSupport().adoptComposerAdmission}
        draftKey={{ kind: "Path", targetId }}
        inheritedRunSelection={null}
        sendCapability={{ kind: "Available" }}
        {...props}
      />
    </Boundary>,
    accountId,
  );
}
function withChatAccount(children: ReactNode, accountId = A) {
  return withRenderEnvironment(
    <AuthenticatedAccountProvider
      account={{ accountId, calendarTimeZone: "UTC" }}
    >
      {children}
    </AuthenticatedAccountProvider>,
  );
}
function WorkspaceProbe() {
  const { state } = useWorkspaceStore();
  return (
    <>
      <p>Active pane: {state.activePrimaryPaneId}</p>
      <p>{state.primaryPanesById.source.currentVisit.href}</p>
    </>
  );
}
function renderWorkspace(
  initialState: ComponentProps<typeof WorkspaceStoreProvider>["initialState"],
) {
  return render(
    withRenderEnvironment(
      <AuthenticatedAccountProvider
        account={{ accountId: A, calendarTimeZone: "UTC" }}
      >
        <KeybindingsProvider>
          <FeedbackProvider>
            <PaneReturnMementoProvider>
              <WorkspaceStoreProvider
                initialState={initialState}
                workspacePrimaryMetrics={{
                  primaryMinWidthPx: 684,
                  primaryDefaultWidthPx: 684,
                }}
              >
                <MobileChromeProvider>
                  <ShareControllerProvider>
                    <LibraryPlacementControllerProvider>
                      <LecternProvider>
                        <OfflineReadingProvider accountId={A}>
                          <OfflineMediaProvider accountId={A}>
                            <ResourceOverlaysProvider>
                              <ResourceCacheProvider
                                value={{}}
                                publicationLimits={READER_CAPACITY.cache}
                              >
                                <ArtworkProvider limits={ARTWORK_CAPACITY}>
                                  <GlobalPlayerProvider accountId={A}>
                                    <ResourceActionRuntimeProvider>
                                      <WorkspaceProbe />
                                      <div style={{ height: 800, width: 1500 }}>
                                        <WorkspaceHost />
                                      </div>
                                    </ResourceActionRuntimeProvider>
                                  </GlobalPlayerProvider>
                                </ArtworkProvider>
                              </ResourceCacheProvider>
                            </ResourceOverlaysProvider>
                          </OfflineMediaProvider>
                        </OfflineReadingProvider>
                      </LecternProvider>
                    </LibraryPlacementControllerProvider>
                  </ShareControllerProvider>
                </MobileChromeProvider>
              </WorkspaceStoreProvider>
            </PaneReturnMementoProvider>
          </FeedbackProvider>
        </KeybindingsProvider>
      </AuthenticatedAccountProvider>,
    ),
  );
}
function bff(post: (init: RequestInit) => Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/llm-catalog")
        return json(GENERATION_CATALOG_RESPONSE);
      if (String(input) === "/api/chat-runs" && init?.method === "POST")
        return post(init);
      throw new Error("Unexpected test request");
    },
  );
}
async function send() {
  await screen.findByRole("button", { name: /Change model/u });
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Ask anything" }),
    "Keep this question",
  );
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
}
beforeAll(async () => {
  const loadAdmission =
    cutoverModules["../../__tests__/helpers/chatAdmission.ts"];
  if (loadAdmission === undefined) return;
  cutoverSupport = await loadAdmission();
});
beforeEach(() => {
  sessionStorage.clear();
  invalidateGenerationCatalogCache();
});
afterEach(() => {
  invalidateGenerationCatalogCache();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("chat admission ownership", () => {
  it("retains account and origin ownership when a fresh store reloads persisted command bytes", async () => {
    const loadDraft = draftModules["/src/lib/conversations/chatDraftStore.ts"];
    expect(loadDraft).toBeTypeOf("function");
    const { ChatDraftStore, chatDraftStorageKeyForView } = await loadDraft();
    expect(chatDraftStorageKeyForView).toBeTypeOf("function");
    const key = "nx_chat_draft.v3:new:reload-ownership";
    const editableKey = `nx_chat_draft.v3:path:${USER}`;
    const origin = { identity: "origin-visit", accountId: A };
    const foreign = { identity: "foreign-visit", accountId: B };
    const otherVisit = { identity: "other-visit", accountId: A };
    bff(async (init) =>
      json({
        data: {
          idempotency_key: new Headers(init.headers).get("Idempotency-Key"),
          outcome: {
            kind: "Accepted",
            conversation_id: A,
            run_id: B,
            assistant_message_id: ASSISTANT,
          },
        },
      }),
    );
    const source = new ChatDraftStore(key);
    source.setContent("Private question");
    const command = source.beginSubmit(
      {
        destination: { kind: "New" },
        content: "Private question",
        catalog_definition_revision: "a".repeat(64),
        selection: {
          route: "CodexPersonal",
          model: "gpt-5.6-terra",
          reasoning: "medium",
        },
        tool_authority: "ReadOnly",
        reader_selection: { kind: "Absent" },
      },
      origin,
    );
    if (!command) throw new Error("Initial command was not created");
    const pendingBytes = sessionStorage.getItem(key);
    const reloadedPending = new ChatDraftStore(key);
    expect(() => reloadedPending.retrySubmit(foreign)).toThrow(
      "another authenticated account",
    );
    expect(() => reloadedPending.retrySubmit(otherVisit)).toThrow(
      "another visit",
    );
    expect(chatDraftStorageKeyForView(key, otherVisit, null)).toBeNull();
    expect(sessionStorage.getItem(key)).toBe(pendingBytes);
    await source.submit(command);
    const acknowledgedBytes = sessionStorage.getItem(key);
    expect(chatDraftStorageKeyForView(editableKey, origin, A)).toBe(key);
    expect(chatDraftStorageKeyForView(editableKey, otherVisit, A)).toBe(key);
    expect(() =>
      chatDraftStorageKeyForView(editableKey, { ...origin, accountId: B }, A),
    ).toThrow("another authenticated account");
    const reloaded = new ChatDraftStore(key);
    expect(() => reloaded.claimAcknowledgment(command, foreign, true)).toThrow(
      "another authenticated account",
    );
    expect(() => reloaded.complete(command, foreign)).toThrow(
      "another authenticated account",
    );
    expect(sessionStorage.getItem(key)).toBe(acknowledgedBytes);
    expect(reloaded.claimAcknowledgment(command, otherVisit, false)).toBe(
      false,
    );
    expect(reloaded.claimAcknowledgment(command, otherVisit, true)).toBe(true);
    const nextReload = new ChatDraftStore(key);
    expect(nextReload.claimAcknowledgment(command, otherVisit, false)).toBe(
      false,
    );
    expect(nextReload.claimAcknowledgment(command, origin, false)).toBe(true);
    const secondKey = `nx_chat_draft.v3:path:${ASSISTANT}`;
    const second = new ChatDraftStore(secondKey);
    second.beginSubmit(
      {
        ...command.request,
        destination: {
          kind: "Existing",
          conversation_id: A,
          insertion: {
            kind: "Reply",
            parent_message_id: ASSISTANT,
            branch_anchor: { kind: "none" },
          },
        },
      },
      origin,
    );
    const secondBytes = sessionStorage.getItem(secondKey);
    expect(chatDraftStorageKeyForView(editableKey, origin, A)).toBeNull();
    // Another visit can open the accepted New command, but cannot claim the
    // separate unsettled Existing command for replay.
    expect(chatDraftStorageKeyForView(editableKey, otherVisit, A)).toBe(key);
    const editable = new ChatDraftStore(editableKey);
    editable.setContent("My next draft");
    editable.setSelection(RUN_SELECTION.selection);
    render(composer(A, {
      draftKey: { kind: "Path", targetId: USER },
      viewIdentity: origin.identity,
    }));
    expect(await screen.findByText("E_CHAT_RECOVERY_CONFLICT")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Ask anything" })).toHaveValue(
      "My next draft",
    );
    expect(screen.getByRole("textbox", { name: "Ask anything" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Retry send" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open response" })).toBeNull();
    expect(sessionStorage.getItem(key)).toBe(acknowledgedBytes);
    expect(sessionStorage.getItem(secondKey)).toBe(secondBytes);
    await act(async () => nextReload.complete(command, origin));
    expect(sessionStorage.getItem(key)).toBeNull();
  });
  it.each([
    {
      destination: "New",
      outcome: "Accepted",
      laterHistory: true,
      recoveryFromParent: false,
    },
    {
      destination: "Existing",
      outcome: "Accepted",
      laterHistory: false,
      recoveryFromParent: false,
    },
    {
      destination: "Existing",
      outcome: "Accepted",
      laterHistory: false,
      recoveryFromParent: true,
    },
    {
      destination: "New",
      outcome: "Rejected",
      laterHistory: false,
      recoveryFromParent: false,
    },
  ] as const)(
    "settles $destination $outcome admission (parent recovery: $recoveryFromParent) through WorkspaceHost without stealing the other pane's draft or focus",
    async ({ destination, outcome, laterHistory, recoveryFromParent }) => {
      await page.viewport(1600, 900);
      const sourceVisit = createPaneVisit(
        destination === "New"
          ? "/conversations/new"
          : `/conversations/${A}`,
      );
      const otherVisit = createPaneVisit("/conversations/new");
      const priorUserId = "55555555-5555-4555-8555-555555555555";
      const parentId = "66666666-6666-4666-8666-666666666666";
      const sourceDraftKey =
        destination === "New"
          ? `nx_chat_draft.v3:new:${sourceVisit.id}`
          : `nx_chat_draft.v3:path:${recoveryFromParent ? parentId : A}`;
      const finalView = admittedView();
      if (recoveryFromParent) {
        finalView.data.user_message.seq = 3;
        finalView.data.user_message.parent_message_id = parentId;
        finalView.data.assistant_message.seq = 4;
        finalView.data.assistant_message.parent_message_id = USER;
        finalView.data.conversation.message_count = 4;
      }
      const terminalAdmission = laterHistory || recoveryFromParent;
      const nextDraftKey = `nx_chat_draft.v3:path:${ASSISTANT}`;
      const nextDraft = {
        text: "My unsent follow-up",
        selection: RUN_SELECTION.selection,
        toolAuthority: "AdditiveWrites",
        operation: { kind: "Absent" },
      };
      if (recoveryFromParent)
        sessionStorage.setItem(nextDraftKey, JSON.stringify(nextDraft));
      const liveView = structuredClone(finalView);
      liveView.data.run.status = "running";
      liveView.data.run.completed_at = null;
      liveView.data.assistant_message.status = "pending";
      liveView.data.assistant_message.message_document = {
        type: "message_document",
        blocks: [],
      };
      liveView.data.stream_state.status = "running";
      liveView.data.stream_state.assistant_current_text = "";
      liveView.data.stream_state.terminal = false;
      liveView.data.stream_state.reconnectable = true;
      const receipt = {
        idempotency_key: "workspace-focus-command",
        outcome: {
          kind: "Accepted",
          conversation_id: A,
          run_id: B,
          assistant_message_id: ASSISTANT,
        },
      };
      sessionStorage.setItem(
        sourceDraftKey,
        JSON.stringify({
          text: "Keep this question",
          selection: null,
          toolAuthority: "ReadOnly",
          operation:
            outcome === "Rejected"
              ? { kind: "Absent" }
              : {
                  kind: "Acknowledged",
                  command: {
                    idempotencyKey: receipt.idempotency_key,
                    origin: {
                      identity: `${sourceVisit.id}:${sourceVisit.href}`,
                      accountId: A,
                    },
                    request: {
                      destination:
                        destination === "New"
                          ? { kind: "New" }
                          : {
                              kind: "Existing",
                              conversation_id: A,
                              insertion: recoveryFromParent
                                ? {
                                    kind: "Reply",
                                    parent_message_id: parentId,
                                    branch_anchor: { kind: "none" },
                                  }
                                : { kind: "Empty" },
                            },
                      content: "Keep this question",
                      catalog_definition_revision: "a".repeat(64),
                      selection: {
                        route: "CodexPersonal",
                        model: "gpt-5.6-terra",
                        reasoning: "medium",
                      },
                      tool_authority: "ReadOnly",
                      reader_selection: { kind: "Absent" },
                    },
                  },
                  receipt,
                },
        }),
      );
      const target = `/conversations/${A}?message=${ASSISTANT}`;
      const initialState = createWorkspaceStateFromPrimaryPanes({
        activePrimaryPaneId: "source",
        primaryPanes: [sourceVisit, otherVisit].map((visit, index) => ({
          id: index === 0 ? "source" : "other",
          currentVisit: visit,
          primaryWidthPx: 684,
          visibility: "visible",
          history: createEmptyPaneHistory(),
          attachedSecondaryPaneId: null,
        })),
      });
      let completeRead!: () => void;
      let completeAdmission = () => {};
      let requestedAdmission = false;
      let requestedRead = false;
      let readReleased = false;
      let initialHistoryRequested = false;
      let failInitialHistory = () => {};
      const initialHistory = new Promise<Response>((resolve) => {
        failInitialHistory = () => resolve(json(
          {
            error: {
              code: "E_INTERNAL",
              message: "Obsolete history request failed",
            },
          },
          500,
        ));
      });
      let finishStream = () => {};
      let streamRequests = 0;
      const response = new Promise<Response>((resolve) => {
        completeRead = () => {
          readReleased = true;
          resolve(json(terminalAdmission ? finalView : liveView));
        };
      });
      vi.stubGlobal(
        "fetch",
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(
            input instanceof Request ? input.url : String(input),
            window.location.origin,
          );
          if (url.pathname === "/api/llm-catalog")
            return json(GENERATION_CATALOG_RESPONSE);
          if (url.pathname === "/api/chat-runs" && init?.method === "POST") {
            requestedAdmission = true;
            return new Promise<Response>((resolve) => {
              completeAdmission = () =>
                resolve(
                  json({
                    data: {
                      idempotency_key: new Headers(init.headers).get(
                        "Idempotency-Key",
                      ),
                      outcome: {
                        kind: "Rejected",
                        reason: { code: "E_RATE_LIMITED" },
                      },
                    },
                  }),
                );
            });
          }
          if (
            url.pathname === "/api/me/workspace-session" &&
            init?.method === "PUT"
          )
            return json({ data: null });
          if (url.pathname === `/api/chat-runs/${B}`) {
            if (requestedRead) return json(finalView);
            requestedRead = true;
            return response;
          }
          if (url.pathname === "/api/stream-token")
            return json({
              data: {
                token: "fixture-token",
                stream_base_url: window.location.origin,
                expires_at: "2099-01-01T00:00:00Z",
              },
            });
          if (url.pathname === `/stream/chat-runs/${B}/events`) {
            streamRequests += 1;
            let ended = false;
            const encoder = new TextEncoder();
            const body = new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    `id: 2\nevent: assistant_text_delta\ndata: ${JSON.stringify({ assistant_message_id: ASSISTANT, text: "Streamed live answer", provider_event_seq_start: 2, provider_event_seq_end: 2 })}\n\n`,
                  ),
                );
                finishStream = () => {
                  if (ended) return;
                  ended = true;
                  controller.enqueue(
                    encoder.encode(
                      `id: 3\nevent: done\ndata: ${JSON.stringify({ status: "complete", error_code: { kind: "Absent" }, support_id: { kind: "Absent" }, publication_warning: { kind: "Absent" }, usage: null, final_chars: 20, last_provider_event_seq: 2, cancelled: false })}\n\n`,
                    ),
                  );
                  controller.close();
                };
              },
              cancel() {
                ended = true;
              },
            });
            return new Response(body, {
              headers: { "Content-Type": "text/event-stream" },
            });
          }
          if (
            url.pathname === "/api/chat-runs" &&
            (init?.method ?? "GET") === "GET"
          )
            return json({
              data: readReleased && !terminalAdmission ? [liveView.data] : [],
            });
          if (url.pathname === `/api/conversations/${A}/context-refs`)
            return json({ data: [] });
          if (url.pathname === `/api/conversations/${A}/tree`) {
            if (
              destination === "Existing" &&
              !initialHistoryRequested &&
              !recoveryFromParent
            ) {
              initialHistoryRequested = true;
              // Deliberately settle after abort: the read owner must fence the
              // late response even if the transport cannot cancel delivery.
              return initialHistory;
            }
            const view =
              destination === "New" || recoveryFromParent
                ? structuredClone(finalView.data)
                : structuredClone(liveView.data);
            const path = [view.user_message, view.assistant_message];
            if (recoveryFromParent) {
              path.unshift(
                {
                  ...view.user_message,
                  id: priorUserId,
                  seq: 1,
                  parent_message_id: null,
                  message_document: {
                    type: "message_document",
                    blocks: [
                      { type: "text", format: "plain", text: "Prior question" },
                    ],
                  },
                },
                {
                  ...view.assistant_message,
                  id: parentId,
                  seq: 2,
                  parent_message_id: priorUserId,
                  message_document: {
                    type: "message_document",
                    blocks: [
                      { type: "text", format: "markdown", text: "Prior answer" },
                    ],
                  },
                },
              );
            }
            if (laterHistory) {
              const laterUserId = "77777777-7777-4777-8777-777777777777";
              const laterAssistantId = "88888888-8888-4888-8888-888888888888";
              path.push(
                {
                  ...view.user_message,
                  id: laterUserId,
                  seq: 3,
                  parent_message_id: ASSISTANT,
                  message_document: {
                    type: "message_document",
                    blocks: [
                      { type: "text", format: "plain", text: "Later question" },
                    ],
                  },
                },
                {
                  ...view.assistant_message,
                  id: laterAssistantId,
                  seq: 4,
                  parent_message_id: laterUserId,
                  message_document: {
                    type: "message_document",
                    blocks: [
                      { type: "text", format: "markdown", text: "Later answer" },
                    ],
                  },
                },
              );
            }
            const leafId = path[path.length - 1].id;
            const rootId = path[0].id;
            return json({
              data: {
                conversation: {
                  ...view.conversation,
                  message_count: path.length,
                },
                selected_path: path,
                active_leaf_message_id: leafId,
                fork_options_by_parent_id: {},
                path_cache_by_leaf_id: { [leafId]: path },
                branch_graph: {
                  nodes: path.map((message, index) => ({
                    id: message.id,
                    message_id: message.id,
                    parent_message_id:
                      index === 0 ? null : path[index - 1].id,
                    leaf_message_id: leafId,
                    role: message.role,
                    depth: index,
                    row: index,
                    title: null,
                    preview:
                      index === 0 ? "Keep this question" : "Canonical answer",
                    branch_anchor_preview: null,
                    status: "complete",
                    message_count: path.length - index,
                    child_count: index === path.length - 1 ? 0 : 1,
                    active_path: true,
                    leaf: index === path.length - 1,
                    created_at: TIME,
                  })),
                  edges: path.slice(1).map((message, index) => ({
                    from: path[index].id,
                    to: message.id,
                  })),
                  root_message_id: rootId,
                },
                page: { before_cursor: null },
              },
            });
          }
          if (url.pathname === "/api/resource-items/locators/resolve") {
            const route = `/conversations/${A}`;
            return json({
              data: {
                resolutions: [
                  {
                    locator: { kind: "resource_ref", ref: `conversation:${A}` },
                    canonicalHref: route,
                    documentReader: false,
                    resourceItem: {
                      ref: `conversation:${A}`,
                      scheme: "conversation",
                      id: A,
                      label: "Admitted conversation",
                      summary: "",
                      route,
                      missing: false,
                      activation: {
                        resourceRef: `conversation:${A}`,
                        kind: "route",
                        href: route,
                        unresolvedReason: null,
                      },
                      capabilities: {
                        userRelation: {
                          userLinkSource: false,
                          userLinkTarget: "none",
                          noteReferenceTarget: false,
                        },
                        sharing: "None",
                        libraryPlacement: "None",
                        attachable: false,
                        chatSubject: "none",
                        readable: "none",
                        inspectable: "none",
                        citableResultType: null,
                        citationOutputSource: false,
                        appSearchScope: false,
                        conversationSearchScope: false,
                        promptRender: "none",
                        expansionPolicy: "none",
                        expandable: false,
                        adjacencySource: true,
                        adjacencyTarget: true,
                      },
                      versionByLane: {},
                    },
                  },
                ],
              },
            });
          }
          throw new Error(
            `Unexpected workspace request: ${init?.method ?? "GET"} ${url.pathname}`,
          );
        },
      );
      try {
        await preloadPane("conversationNew");
        renderWorkspace(initialState);
        if (outcome === "Rejected") {
          await userEvent.click(
            await within(
              screen.getByTestId("pane-error-boundary-source"),
            ).findByRole("button", { name: "Send message" }),
          );
          await waitFor(() => expect(requestedAdmission).toBe(true));
        } else {
          if (recoveryFromParent) {
            await expect
              .element(await screen.findByText("Canonical answer"))
              .toBeVisible();
            await expect
              .element(screen.getByText("Prior question"))
              .toBeVisible();
            await expect
              .element(screen.getByText("Prior answer"))
              .toBeVisible();
            expect(requestedRead).toBe(false);
            expect(
              JSON.parse(sessionStorage.getItem(sourceDraftKey)!).operation.kind,
            ).toBe("Acknowledged");
            await userEvent.click(
              screen.getByRole("button", { name: "Open response" }),
            );
          }
          await waitFor(() => expect(requestedRead).toBe(true));
          if (destination === "Existing" && !recoveryFromParent)
            expect(initialHistoryRequested).toBe(true);
        }
        await waitFor(() =>
          expect(
            screen.getAllByRole("textbox", { name: "Ask anything" }),
          ).toHaveLength(2),
        );
        const otherInput = screen
          .getAllByRole<HTMLTextAreaElement>("textbox", {
            name: "Ask anything",
          })
          .find((input) => !input.disabled);
        if (!otherInput) throw new Error("Other pane has no editable composer");
        const sourceInput = screen
          .getAllByRole<HTMLTextAreaElement>("textbox", {
            name: "Ask anything",
          })
          .find((input) => input.disabled);
        if (!sourceInput)
          throw new Error("Originating pane has no acknowledged composer");
        await userEvent.click(otherInput);
        await userEvent.fill(otherInput, "My next thought");
        expect(screen.getByText("Active pane: other")).toBeVisible();
        if (outcome === "Rejected") {
          await act(async () => completeAdmission());
          expect(
            await screen.findByText(
              "Too many messages. Wait a moment, then send again.",
            ),
          ).toBeVisible();
          await userEvent.keyboard(" next");
          expect(sourceInput).toHaveValue("Keep this question");
          expect(sourceInput).toBeEnabled();
          expect(screen.getByText("Active pane: other")).toBeVisible();
          expect(otherInput).toHaveFocus();
          expect(otherInput).toHaveValue("My next thought next");
          expect(JSON.parse(sessionStorage.getItem(sourceDraftKey)!).text).toBe(
            "Keep this question",
          );
          const sourceWriteGrant = within(
            screen.getByTestId("pane-error-boundary-source"),
          ).getByRole("checkbox", { name: "Allow this reply to add to Nexus" });
          await userEvent.click(sourceWriteGrant);
          expect(screen.getByText("Active pane: source")).toBeVisible();
          expect(sourceWriteGrant).toHaveFocus();
          return;
        }
        await act(async () => completeRead());
        expect(await screen.findByText(target)).toBeVisible();
        if (laterHistory) {
          await expect
            .element(await screen.findByText("Later answer"))
            .toBeVisible();
          await expect
            .element(screen.getByText("Later question"))
            .toBeVisible();
          expect(streamRequests).toBe(0);
        } else if (!recoveryFromParent) {
          await waitFor(() => expect(streamRequests).toBe(1));
          await waitFor(() =>
            expect(screen.getByText("Streamed live answer")).toBeVisible(),
          );
        }
        expect(screen.getByText("Keep this question")).toBeVisible();
        if (destination === "Existing") {
          expect(
            screen.getAllByRole("textbox", { name: "Ask anything" }),
          ).toContain(sourceInput);
        }
        await act(async () => finishStream());
        expect(await screen.findByText("Canonical answer")).toBeVisible();
        if (destination === "Existing" && !recoveryFromParent) {
          await act(async () => {
            failInitialHistory();
            await initialHistory;
          });
          expect(screen.getByText("Canonical answer")).toBeVisible();
        }
        expect(
          screen.queryByRole("button", { name: "Stop response" }),
        ).toBeNull();
        expect(screen.getByText("Active pane: other")).toBeVisible();
        expect(window.location.pathname).toBe("/conversations/new");
        expect(otherInput).toHaveFocus();
        expect(otherInput).toHaveValue("My next thought");
        expect(sessionStorage.getItem(sourceDraftKey)).toBeNull();
        expect(requestedAdmission).toBe(false);
        if (recoveryFromParent) {
          expect(screen.getByText("Prior question")).toBeVisible();
          expect(screen.getByText("Prior answer")).toBeVisible();
          expect(sourceInput).toHaveValue(nextDraft.text);
          expect(
            within(screen.getByTestId("pane-error-boundary-source")).getByRole(
              "checkbox",
              { name: "Allow this reply to add to Nexus" },
            ),
          ).toBeChecked();
          expect(JSON.parse(sessionStorage.getItem(nextDraftKey)!)).toEqual(
            nextDraft,
          );
          expect(streamRequests).toBe(0);
        }
      } finally {
        failInitialHistory();
        completeAdmission();
        completeRead();
        finishStream();
        // Finish the host's normal page-lifecycle persistence before another
        // scenario installs its HTTP boundary.
        await act(async () => {
          window.dispatchEvent(new Event("pagehide"));
        });
        await page.viewport(1024, 768);
      }
    },
  );
  it("consumes deferred quote focus when another workspace pane owns the keyboard", async () => {
    await page.viewport(1600, 900);
    const sourceVisit = createPaneVisit(
      `/conversations/new#mediaId=${A}&highlightId=${B}`,
    );
    const otherVisit = createPaneVisit("/conversations/new");
    const initialState = createWorkspaceStateFromPrimaryPanes({
      activePrimaryPaneId: "source",
      primaryPanes: [sourceVisit, otherVisit].map((visit, index) => ({
        id: index === 0 ? "source" : "other",
        currentVisit: visit,
        primaryWidthPx: 684,
        visibility: "visible",
        history: createEmptyPaneHistory(),
        attachedSecondaryPaneId: null,
      })),
    });
    let completePreview!: () => void;
    const preview = new Promise<Response>((resolve) => {
      completePreview = () =>
        resolve(
          json({
            data: {
              key: { media_id: A, highlight_id: B },
              source_label: "Source",
              exact: "Deferred quoted passage",
              prefix: "",
              suffix: "",
              revision: "a".repeat(64),
              locator: {
                type: "web_text_offsets",
                media_id: A,
                fragment_id: B,
                start_offset: 0,
                end_offset: 23,
              },
              activation: {
                resource_ref: `highlight:${B}`,
                kind: "route",
                href: `/media/${A}`,
                unresolved_reason: null,
              },
            },
          }),
        );
    });
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/api/llm-catalog")
          return json(GENERATION_CATALOG_RESPONSE);
        if (url.pathname.startsWith("/api/chat-reader-selections/highlights/"))
          return preview;
        if (
          url.pathname === "/api/me/workspace-session" &&
          init?.method === "PUT"
        )
          return json({ data: null });
        throw new Error(`Unexpected quote workspace request: ${url.pathname}`);
      },
    );
    const view = renderWorkspace(initialState);
    try {
      const source = within(screen.getByTestId("pane-error-boundary-source"));
      const other = within(screen.getByTestId("pane-error-boundary-other"));
      await source.findByText("Loading the quoted passage.");
      await source.findByRole("button", { name: /Change model/u });
      const sourceInput = source.getByRole("textbox", { name: "Ask anything" });
      const otherInput = other.getByRole("textbox", { name: "Ask anything" });
      await userEvent.fill(sourceInput, "Question about the quote");
      await userEvent.click(otherInput);
      await userEvent.fill(otherInput, "My next thought");
      expect(screen.getByText("Active pane: other")).toBeVisible();

      await act(async () => completePreview());
      expect(await source.findByText("Deferred quoted passage")).toBeVisible();
      await userEvent.keyboard(" next");
      expect(
        otherInput,
        "Deferred quote hydration stole sibling focus",
      ).toHaveFocus();
      expect(screen.getByText("Active pane: other")).toBeVisible();
      expect(otherInput).toHaveValue("My next thought next");
      expect(sourceInput).toHaveValue("Question about the quote");
      expect(
        JSON.parse(
          sessionStorage.getItem(`nx_chat_draft.v3:new:${otherVisit.id}`)!,
        ).text,
      ).toBe("My next thought next");

      const sourceWriteGrant = source.getByRole("checkbox", {
        name: "Allow this reply to add to Nexus",
      });
      await userEvent.click(sourceWriteGrant);
      expect(screen.getByText("Active pane: source")).toBeVisible();
      expect(
        sourceWriteGrant,
        "Reactivation delivered an obsolete quote focus request",
      ).toHaveFocus();
    } finally {
      completePreview();
      view.unmount();
      await page.viewport(1024, 768);
    }
  });
  // Risk: admission must preserve intent on rejection and route changes, and
  // cannot erase replay evidence before a strictly validated acknowledgment.
  it("preserves history, draft, and focus after an immutable rate rejection", async () => {
    bff(async (init) =>
      json({
        data: {
          idempotency_key: new Headers(init.headers).get("Idempotency-Key"),
          outcome: { kind: "Rejected", reason: { code: "E_RATE_LIMITED" } },
        },
      }),
    );
    render(composer());
    await send();
    expect(
      await screen.findByText(
        "Too many messages. Wait a moment, then send again.",
      ),
    ).toBeVisible();
    expect(screen.getByText("Existing answer")).toBeVisible();
    const input = screen.getByRole("textbox", { name: "Ask anything" });
    expect(input).toHaveValue("Keep this question");
    expect(input).toBeEnabled();
    await waitFor(() => expect(input).toHaveFocus());
  });
  it("retains the exact command for Retry send when generation or rate-limit dependencies are unavailable", async () => {
    const requests: { key: string | null; body: string }[] = [];
    bff(async (init) => {
      requests.push({
        key: new Headers(init.headers).get("Idempotency-Key"),
        body: String(init.body),
      });
      return json(
        {
          error: {
            code:
              requests.length === 1
                ? "E_GENERATION_RUNTIME_UNAVAILABLE"
                : "E_RATE_LIMITER_UNAVAILABLE",
            message: "Admission dependency unavailable",
          },
        },
        503,
      );
    });
    render(composer());
    await send();
    await userEvent.click(
      await screen.findByRole("button", { name: "Retry send" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retry send" })).toBeEnabled(),
    );
    const input = screen.getByRole("textbox", { name: "Ask anything" });
    expect(input).toHaveValue("Keep this question");
    expect(input).toBeDisabled();
    expect(screen.getByText("Existing answer")).toBeVisible();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    const stored = JSON.parse(
      sessionStorage.getItem(`nx_chat_draft.v3:path:${A}`)!,
    );
    expect(stored.operation.kind).toBe("ReconcileRequired");
    expect(stored.operation.command.idempotencyKey).toBe(requests[0].key);
    expect(stored.operation.command.request).toEqual(
      JSON.parse(requests[0].body),
    );
  });
  it("keeps the original draft when rejection arrives after navigation to another draft", async () => {
    let reject!: () => void;
    bff(
      (init) =>
        new Promise((resolve) => {
          reject = () =>
            resolve(
              json({
                data: {
                  idempotency_key: new Headers(init.headers).get(
                    "Idempotency-Key",
                  ),
                  outcome: {
                    kind: "Rejected",
                    reason: { code: "E_RATE_LIMITED" },
                  },
                },
              }),
            );
        }),
    );
    const view = render(composer());
    await send();
    view.rerender(composer(B));
    reject();
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Ask anything" }),
      ).toBeEnabled(),
    );
    await userEvent.fill(
      screen.getByRole("textbox", { name: "Ask anything" }),
      "Other question",
    );
    expect(
      screen.queryByText("Too many messages. Wait a moment, then send again."),
    ).toBeNull();
    expect(
      JSON.parse(sessionStorage.getItem(`nx_chat_draft.v3:path:${A}`)!).text,
    ).toBe("Keep this question");
    expect(
      JSON.parse(sessionStorage.getItem(`nx_chat_draft.v3:path:${B}`)!).text,
    ).toBe("Other question");
  });
  it.each(["malformed", "another command", "another conversation"])(
    "retains the exact persisted command when a success receipt is %s",
    async (failure) => {
      bff(async (init) =>
        json({
          data:
            failure === "malformed"
              ? {}
              : {
                  idempotency_key:
                    failure === "another command"
                      ? "foreign-command"
                      : new Headers(init.headers).get("Idempotency-Key"),
                  outcome: {
                    kind: "Accepted",
                    conversation_id: failure === "another conversation" ? B : A,
                    run_id: B,
                    assistant_message_id: ASSISTANT,
                  },
                },
        }),
      );
      render(composer());
      await send();
      await screen.findByText("Pane defect");
      const record = JSON.parse(
        sessionStorage.getItem(`nx_chat_draft.v3:path:${A}`)!,
      );
      expect(record.text).toBe("Keep this question");
      expect(record.operation.kind).toBe("ReconcileRequired");
      expect(record.operation.command.request.content).toBe(
        "Keep this question",
      );
      expect(record.operation.command.idempotencyKey).not.toBe("");
    },
  );
  it("keeps a newer visit in place until it explicitly opens the accepted response, including off-path reload", async () => {
    const loadRead = readModules["/src/lib/conversations/chatAdmissionRead.ts"];
    expect(loadRead).toBeTypeOf("function");
    const { readAdmittedChatRun } = await loadRead();
    let accept!: () => void;
    let reads = 0;
    let posts = 0;
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "/api/llm-catalog")
          return json(GENERATION_CATALOG_RESPONSE);
        if (String(input) === `/api/chat-runs/${B}`) {
          reads += 1;
          return json(admittedView());
        }
        if (String(input) === "/api/chat-runs") {
          posts += 1;
          return new Promise<Response>((resolve) => {
            accept = () =>
              resolve(
                json({
                  data: {
                    idempotency_key: new Headers(init?.headers).get(
                      "Idempotency-Key",
                    ),
                    outcome: {
                      kind: "Accepted",
                      conversation_id: A,
                      run_id: B,
                      assistant_message_id: ASSISTANT,
                    },
                  },
                }),
              );
          });
        }
        throw new Error("Unexpected admission request");
      },
    );
    function Visit({
      identity,
      targetId = A,
    }: {
      identity: string;
      targetId?: string;
    }) {
      const [adopted, setAdopted] = useState(false);
      return (
        <>
          <p>{adopted ? `Adopted into ${identity}` : `Viewing ${identity}`}</p>
          <ChatComposer
            conversationId={A}
            draftKey={{ kind: "Path", targetId }}
            inheritedRunSelection={null}
            sendCapability={{ kind: "Available" }}
            viewIdentity={identity}
            isPaneActive={true}
            onAdmitted={async (receipt, isCurrent) => {
              await readAdmittedChatRun(receipt);
              if (!isCurrent()) return false;
              setAdopted(true);
              return true;
            }}
          />
        </>
      );
    }
    const view = render(withChatAccount(<Visit identity="first:quote-a" />));
    await send();
    view.rerender(withChatAccount(<Visit identity="second:quote-b" />));
    accept();
    await screen.findByRole("button", { name: "Open response" });
    expect(screen.getByText("Viewing second:quote-b")).toBeVisible();
    expect(reads).toBe(0);
    expect(
      JSON.parse(sessionStorage.getItem(`nx_chat_draft.v3:path:${A}`)!).operation
        .kind,
    ).toBe("Acknowledged");
    view.unmount();
    render(withChatAccount(<Visit identity="second:quote-b" targetId={USER} />));
    await userEvent.click(
      await screen.findByRole("button", { name: "Open response" }),
    );
    expect(
      await screen.findByText("Adopted into second:quote-b"),
    ).toBeVisible();
    expect(sessionStorage.getItem(`nx_chat_draft.v3:path:${A}`)).toBeNull();
    expect(posts).toBe(1);
    expect(reads).toBe(1);
  });
  it("reloads an acknowledged command through GET, retains a deleted target until dismissal, and never resends", async () => {
    const loadRead = readModules["/src/lib/conversations/chatAdmissionRead.ts"];
    const loadReceipt =
      receiptModules["/src/lib/conversations/chatAdmission.ts"];
    expect(loadRead).toBeTypeOf("function");
    expect(loadReceipt).toBeTypeOf("function");
    const { readAdmittedChatRun } = await loadRead();
    const { decodeChatAdmissionReceipt } = await loadReceipt();
    const receipt = decodeChatAdmissionReceipt(corpus.valid[0].value);
    if (receipt.outcome.kind !== "Accepted")
      throw new Error("Expected accepted corpus receipt");
    const record = {
      text: "Received question",
      selection: null,
      toolAuthority: "ReadOnly",
      operation: {
        kind: "Acknowledged",
        command: {
          idempotencyKey: receipt.idempotency_key,
          origin: { identity: `test:${A}`, accountId: A },
          request: {
            destination: { kind: "New" },
            content: "Received question",
            catalog_definition_revision: "a".repeat(64),
            selection: {
              route: "CodexPersonal",
              model: "gpt-5.6-terra",
              reasoning: "medium",
            },
            tool_authority: "ReadOnly",
            reader_selection: { kind: "Absent" },
          },
        },
        receipt,
      },
    };
    const storageKey = `nx_chat_draft.v3:path:${A}`;
    sessionStorage.setItem(storageKey, JSON.stringify(record));
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(`${init?.method ?? "GET"} ${String(input)}`);
        if (String(input) === "/api/llm-catalog")
          return json(GENERATION_CATALOG_RESPONSE);
        if (
          String(input) ===
          `/api/chat-runs/${receipt.outcome.kind === "Accepted" ? receipt.outcome.run_id : ""}`
        )
          return json(
            { error: { code: "E_NOT_FOUND", message: "Deleted" } },
            404,
          );
        throw new Error("Unexpected request: accepted sends must not POST");
      },
    );
    const props = {
      onAdmitted: async (
        accepted: Parameters<typeof readAdmittedChatRun>[0],
      ) => {
        await readAdmittedChatRun(accepted);
        return true;
      },
    };
    const view = render(composer(A, props));
    await screen.findByRole("button", { name: "Dismiss sent message" });
    expect(
      screen.getByRole("textbox", { name: "Ask anything" }),
    ).toBeDisabled();
    expect(JSON.parse(sessionStorage.getItem(storageKey)!).operation.kind).toBe(
      "Acknowledged",
    );
    view.unmount();
    render(composer(A, props));
    await userEvent.click(
      await screen.findByRole("button", { name: "Dismiss sent message" }),
    );
    expect(screen.getByRole("textbox", { name: "Ask anything" })).toHaveValue(
      "",
    );
    expect(sessionStorage.getItem(storageKey)).toBeNull();
    expect(requests.filter((request) => !request.startsWith("GET "))).toEqual(
      [],
    );
  });

  it("refetches a ready quote through the existing preview API after stale admission", async () => {
    const loadSelection = selectionModules["./usePendingReaderSelection.ts"];
    expect(loadSelection).toBeTypeOf("function");
    const { usePendingReaderSelection } = await loadSelection();
    const intent = readerHighlightChatIntent(
      { kind: "Existing", conversationId: A },
      { mediaId: A, highlightId: B },
    );
    let revision = 0;
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "/api/llm-catalog")
          return json(GENERATION_CATALOG_RESPONSE);
        if (
          String(input).startsWith("/api/chat-reader-selections/highlights/")
        ) {
          revision += 1;
          return json({
            data: {
              key: { media_id: A, highlight_id: B },
              source_label: "Source",
              exact: revision === 1 ? "Old quote" : "Refreshed quote",
              prefix: "",
              suffix: "",
              revision: (revision === 1 ? "a" : "b").repeat(64),
              locator: {
                type: "web_text_offsets",
                media_id: A,
                fragment_id: B,
                start_offset: 0,
                end_offset: 12,
              },
              activation: {
                resource_ref: `highlight:${B}`,
                kind: "route",
                href: `/media/${A}`,
                unresolved_reason: null,
              },
            },
          });
        }
        if (String(input) === "/api/chat-runs")
          return json({
            data: {
              idempotency_key: new Headers(init?.headers).get(
                "Idempotency-Key",
              ),
              outcome: {
                kind: "Rejected",
                reason: { code: "E_READER_SELECTION_STALE" },
              },
            },
          });
        throw new Error("Unexpected quote request");
      },
    );
    function QuoteOwner() {
      const { pendingContext, retryHydration } =
        usePendingReaderSelection(intent);
      return (
        <ChatComposer
          conversationId={A}
          viewIdentity={`test:${A}`}
          isPaneActive={true}
          onAdmitted={requireCutoverSupport().adoptComposerAdmission}
          draftKey={{ kind: "Path", targetId: A }}
          inheritedRunSelection={null}
          sendCapability={{ kind: "Available" }}
          pendingContext={pendingContext}
          onRetryHydration={retryHydration}
        />
      );
    }
    render(withChatAccount(<QuoteOwner />));
    await screen.findByText("Old quote");
    await send();
    expect(await screen.findByText("Refreshed quote")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Ask anything" })).toHaveValue(
      "Keep this question",
    );
    expect(
      screen.getByText(
        "The quoted passage changed. Review the refreshed quote and send again.",
      ),
    ).toBeVisible();
  });
  it("adopts only the receipt's hydrated identities and clears recovery material after adoption", async () => {
    const loadRead = readModules["/src/lib/conversations/chatAdmissionRead.ts"];
    expect(loadRead).toBeTypeOf("function");
    const { readAdmittedChatRun } = await loadRead();
    let posts = 0;
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "/api/llm-catalog")
          return json(GENERATION_CATALOG_RESPONSE);
        if (String(input) === "/api/chat-runs") {
          posts += 1;
          return json({
            data: {
              idempotency_key: new Headers(init?.headers).get(
                "Idempotency-Key",
              ),
              outcome: {
                kind: "Accepted",
                conversation_id: A,
                run_id: B,
                assistant_message_id: ASSISTANT,
              },
            },
          });
        }
        if (String(input) === `/api/chat-runs/${B}`)
          return json(admittedView());
        throw new Error("Unexpected admission read");
      },
    );
    function AdoptionOwner() {
      const [adopted, setAdopted] = useState<string | null>(null);
      return (
        <>
          <p>
            {adopted === null ? "Awaiting admission" : `Adopted ${adopted}`}
          </p>
          <ChatComposer
            conversationId={A}
            viewIdentity={`test:${A}`}
            isPaneActive={true}
            draftKey={{ kind: "Path", targetId: A }}
            inheritedRunSelection={null}
            sendCapability={{ kind: "Available" }}
            onAdmitted={async (receipt, isCurrent) => {
              const data = await readAdmittedChatRun(receipt);
              if (!isCurrent()) return false;
              setAdopted(data.assistant_message.id);
              return true;
            }}
          />
        </>
      );
    }
    render(withChatAccount(<AdoptionOwner />));
    await send();
    expect(await screen.findByText(`Adopted ${ASSISTANT}`)).toBeVisible();
    expect(sessionStorage.getItem(`nx_chat_draft.v3:path:${A}`)).toBeNull();
    expect(posts).toBe(1);
  });

  it("retains acknowledgment when a run read belongs to different admitted identities", async () => {
    const loadRead = readModules["/src/lib/conversations/chatAdmissionRead.ts"];
    expect(loadRead).toBeTypeOf("function");
    const { readAdmittedChatRun } = await loadRead();
    const receipt = corpus.valid[0].value;
    sessionStorage.setItem(
      `nx_chat_draft.v3:path:${A}`,
      JSON.stringify({
        text: "Keep this question",
        selection: null,
        toolAuthority: "ReadOnly",
        operation: {
          kind: "Acknowledged",
          command: {
            idempotencyKey: receipt.idempotency_key,
            origin: { identity: `test:${A}`, accountId: A },
            request: {
              destination: { kind: "New" },
              content: "Keep this question",
              catalog_definition_revision: "a".repeat(64),
              selection: {
                route: "CodexPersonal",
                model: "gpt-5.6-terra",
                reasoning: "medium",
              },
              tool_authority: "ReadOnly",
              reader_selection: { kind: "Absent" },
            },
          },
          receipt,
        },
      }),
    );
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (String(input) === "/api/llm-catalog")
        return json(GENERATION_CATALOG_RESPONSE);
      if (String(input) === `/api/chat-runs/${B}`) {
        const response = admittedView();
        response.data.assistant_message.id = USER;
        return json(response);
      }
      throw new Error("Unexpected send while acknowledged");
    });
    render(
      composer(A, {
        onAdmitted: async (accepted) => {
          await readAdmittedChatRun(accepted);
          return true;
        },
      }),
    );
    await screen.findByText("Pane defect");
    expect(
      JSON.parse(sessionStorage.getItem(`nx_chat_draft.v3:path:${A}`)!).operation
        .kind,
    ).toBe("Acknowledged");
  });

  it("does not transfer a pending send to a changed authenticated account", async () => {
    let accept!: () => void;
    let reads = 0;
    bff(
      (init) =>
        new Promise((resolve) => {
          accept = () =>
            resolve(
              json({
                data: {
                  idempotency_key: new Headers(init.headers).get(
                    "Idempotency-Key",
                  ),
                  outcome: {
                    kind: "Accepted",
                    conversation_id: A,
                    run_id: B,
                    assistant_message_id: ASSISTANT,
                  },
                },
              }),
            );
        }),
    );
    const accountView = (accountId: string) => (
      <AuthenticatedAccountProvider
        account={{ accountId, calendarTimeZone: "UTC" }}
      >
        {composer(
          A,
          {
            onAdmitted: async () => {
              reads += 1;
              return true;
            },
          },
          accountId,
        )}
      </AuthenticatedAccountProvider>
    );
    const { rerender, unmount } = render(accountView(A));
    await send();
    rerender(accountView(B));
    await screen.findByText("Pane defect");
    accept();
    await waitFor(() =>
      expect(
        JSON.parse(sessionStorage.getItem(`nx_chat_draft.v3:path:${A}`)!).operation
          .kind,
      ).toBe("Acknowledged"),
    );
    expect(reads).toBe(0);
    unmount();
    render(accountView(B));
    expect(await screen.findByText("Pane defect")).toBeVisible();
    expect(reads).toBe(0);
  });
});
