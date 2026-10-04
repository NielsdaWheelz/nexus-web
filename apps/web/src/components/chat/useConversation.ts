"use client";

/**
 * useConversation — one accepted view of a conversation.
 *
 * Owns the mounted pane's transcript, active leaf, inactive paths, fork data,
 * title and history state. A transition publishes to the read-through ref before
 * React renders, so run frames and branch commands see the same accepted view.
 * History is one tree read plus visible active runs.
 *
 * Scroll lives entirely in the view (ChatSurface/useChatScroll); the engine
 * only holds the `scrollRef` it hands to the view and calls `captureAnchor`
 * before changing the accepted path so the scroll owner can restore the eye-line.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MutableRefObject, RefObject, SetStateAction } from "react";
import {
  apiFetch,
  decodeApiPayload,
  isApiError,
  isSameSystemApiDefect,
  isChatReloadRequired,
  type ApiError,
  type ApiPath,
} from "@/lib/api/client";
import { requestWithRetry } from "@/lib/api/retryPolicy";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { createRandomId } from "@/lib/createRandomId";
import { isAbortError } from "@/lib/errors";
import { useChatRunTail } from "@/components/chat/useChatRunTail";
import type { ChatRunExecution } from "@/lib/api/executionAdvisory";
import type { ApiJson } from "@/lib/api/wire";
import { loadGenerationCatalog } from "@/components/chat/useGenerationCatalog";
import { useStringIdSet, type StringIdSet } from "@/lib/useStringIdSet";
import {
  activeBranchGraphForPath,
  activeForkOptionsForPath,
  selectedPathMessageIds,
} from "@/lib/conversations/branching";
import {
  findGenerationCandidate,
  sameGenerationSelection,
  type GenerationSelectionSpec,
  type RunSelectionOut,
} from "@/lib/conversations/generationCatalog";
import type { ChatRunCandidateRequest } from "@/lib/api/sse/requests";
import type { ChatConnectionRecoveries } from "@/lib/conversations/chatConnectionRecovery";
import type { SSEContextRefAddedEvent } from "@/lib/api/sse/events";
import { messageUpdateReducer } from "@/lib/conversations/messageUpdateReducer";
import {
  chatRunListFromWire,
  chatRunFromWire,
  conversationTreeFromWire,
} from "@/lib/conversations/messageWire";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import type {
  BranchDraft,
  BranchGraph,
  ChatSendCapability,
  ChatRunListResponse,
  ChatRunResponse,
  ConversationMessage,
  ConversationTreeResponse,
  ForkOption,
} from "@/lib/conversations/types";
// The scroll owner (useChatScroll) owns ChatScrollHandle; we import the type
// only — the engine never implements scroll, it just passes the ref through.
import type { ChatScrollHandle } from "./useChatScroll";
import type {
  DeleteMessageMutation,
  MessageActionMutationOutcome,
} from "@/lib/chat/messageActionIntent";
import { deleteConversationMessage } from "@/lib/chat/messageDeletion";
import { canonicalResourceRef } from "@/lib/sharing/targets";

type ChatRunData = ChatRunResponse["data"];
import { readAdmittedChatRun } from "@/lib/conversations/chatAdmissionRead";
type CandidateCommand = Readonly<{
  idempotencyKey: string;
  request: ChatRunCandidateRequest;
}>;

type AcceptedView = {
  conversationId: string | null;
  title: string | null;
  messages: ConversationMessage[];
  historyState: "Loading" | "Unavailable" | "Ready";
  forkOptionsByParentId: Record<string, ForkOption[]>;
  inactivePathsByLeafId: Record<string, ConversationMessage[]>;
  branchGraph: BranchGraph;
  activeLeafMessageId: string | null;
  branchDraft: BranchDraft | null;
};

function selectedIds(
  view: Pick<AcceptedView, "messages" | "activeLeafMessageId">,
): Set<string> {
  const ids = selectedPathMessageIds(view.messages);
  if (view.activeLeafMessageId) ids.add(view.activeLeafMessageId);
  return ids;
}

function viewFromTree(
  previous: AcceptedView,
  tree: ConversationTreeResponse,
): AcceptedView {
  const inactivePathsByLeafId = { ...tree.path_cache_by_leaf_id };
  if (tree.active_leaf_message_id) {
    delete inactivePathsByLeafId[tree.active_leaf_message_id];
  }
  return {
    ...previous,
    conversationId: tree.conversation.id,
    title: tree.conversation.title,
    messages: messageUpdateReducer(previous.messages, {
      type: "set_all",
      messages: tree.selected_path,
    }),
    historyState: "Ready",
    forkOptionsByParentId: tree.fork_options_by_parent_id,
    inactivePathsByLeafId,
    branchGraph: tree.branch_graph,
    activeLeafMessageId: tree.active_leaf_message_id,
  };
}

function conversationOperationErrorMessage(
  error: ApiError,
  operation:
    | "RefreshForks"
    | "Load"
    | "Rerun"
    | "Regenerate"
    | "Delete"
    | "SwitchFork",
): FeedbackContent {
  switch (error.code) {
    case "E_NOT_FOUND":
    case "E_MESSAGE_NOT_FOUND":
      return {
        tone: "Danger",
        requestId: error.requestId,
        title:
          operation === "Load"
            ? "This chat is no longer available."
            : "The requested conversation state is no longer available.",
      };
    case "E_FORBIDDEN":
      return {
        tone: "Danger",
        title: "You don’t have access to this chat.",
        requestId: error.requestId,
      };
    case "E_BRANCH_PATH_INVALID":
    case "E_UPSTREAM":
    case "E_UPSTREAM_TIMEOUT":
    case "E_NETWORK":
    case "E_GENERATION_RUNTIME_UNAVAILABLE":
    case "E_TREE_REFRESH_FAILED":
    case "E_REGENERATION_NOT_ALLOWED":
      return {
        tone: "Danger",
        requestId: error.requestId,
        title:
          operation === "Rerun"
            ? "This response couldn’t be run again."
            : operation === "Regenerate"
              ? "This response couldn’t be regenerated."
              : operation === "Delete"
                ? "This message couldn’t be deleted."
                : operation === "SwitchFork"
                  ? "This fork couldn’t be opened."
                  : operation === "RefreshForks"
                    ? "Forks couldn’t be refreshed."
                    : "This chat couldn’t be loaded.",
      };
    case "E_CATALOG_DEFINITION_STALE":
      return {
        tone: "Warning",
        requestId: error.requestId,
        title: "Model availability changed. Review the exact selection again.",
      };
    case "E_GENERATION_SELECTION_UNAVAILABLE":
      return {
        tone: "Warning",
        requestId: error.requestId,
        title: "That model or thinking setting is unavailable.",
        message: "Choose a current selection and try again.",
      };
    case "E_INVALID_GENERATION_SELECTION":
      return {
        tone: "Danger",
        requestId: error.requestId,
        title: "That model selection is invalid.",
      };
    case "E_GENERATION_CONTEXT_TOO_LARGE":
      return {
        tone: "Warning",
        requestId: error.requestId,
        title: "This conversation no longer fits the model’s context window.",
        message: "Start a new chat or choose a larger model.",
      };
    default:
      throw error;
  }
}

const EMPTY_BRANCH_GRAPH: BranchGraph = {
  nodes: [],
  edges: [],
  root_message_id: null,
};

interface UseConversationOptions {
  /** Existing conversation id, or null to create on first send. */
  conversationId: string | null;
  /** Fired when a `context_ref_added` SSE event lands for this conversation. */
  onContextRefAdded?: (data: SSEContextRefAddedEvent["data"]) => void;
}

interface UseConversationBranch {
  forkOptionsByParentId: Record<string, ForkOption[]>;
  branchGraph: BranchGraph;
  switchableLeafIds: Set<string>;
  activeLeafMessageId: string | null;
  selectedPathMessageIds: Set<string>;
  branchDraft: BranchDraft | null;
  setBranchDraft: (draft: BranchDraft | null) => void;
  switchToLeaf: (
    leafMessageId: string,
    anchorMessageId: string | null,
  ) => Promise<boolean>;
  switchToFork: (fork: ForkOption) => Promise<void>;
  revealMessage: (messageId: string) => Promise<boolean>;
  reload: () => Promise<boolean>;
}

interface UseConversation {
  // transcript
  messages: ConversationMessage[];
  loading: boolean;
  error: FeedbackContent | null;
  /** Fail-closed browser/server tool-contract mismatch; cleared only by reload. */
  projectionReloadRequestId: string | null;
  /** Complete assistant leaf — the default reply/continuation parent. */
  replyParentMessageId: string | null;
  /** Immutable run selection inherited from the causal assistant parent. */
  inheritedRunSelection: RunSelectionOut | null;
  /** The one caller-owned send capability; ChatComposer owns its presentation. */
  sendCapability: ChatSendCapability;

  // identity
  conversationId: string | null;
  /** `null` until the server names an existing conversation. */
  title: string | null;

  // send pipeline (passed straight into <ChatComposer/>). The atomic send
  // (destination:New) creates the conversation; there is no eager pre-create.
  adoptAdmittedRun: (
    receipt: Parameters<typeof readAdmittedChatRun>[0],
    isCurrent: () => boolean,
  ) => Promise<boolean>;
  activeRunId: string | null;
  activeRunExecution: ChatRunExecution | null;
  cancelActiveRun: () => Promise<void>;

  // rerun (a new sibling candidate from an eligible failed/cancelled turn)
  rerunAssistantResponse: (
    assistantMessageId: string,
  ) => Promise<MessageActionMutationOutcome>;
  rerunAssistantResponseWithSelection: (
    assistantMessageId: string,
    selection: GenerationSelectionSpec,
    catalogDefinitionRevision: string,
  ) => Promise<MessageActionMutationOutcome>;
  rerunningAssistantMessageIds: ReadonlySet<string>;

  // regenerate (a new sibling candidate from an eligible completed answer)
  regenerateAssistantResponse: (
    assistantMessageId: string,
  ) => Promise<MessageActionMutationOutcome>;
  regenerateAssistantResponseWithSelection: (
    assistantMessageId: string,
    selection: GenerationSelectionSpec,
    catalogDefinitionRevision: string,
  ) => Promise<MessageActionMutationOutcome>;
  deleteMessage: DeleteMessageMutation;

  // client-only connection recovery; server failure/status remains canonical.
  connectionRecoveries: ChatConnectionRecoveries;
  reconnectAssistantResponse: (assistantMessageId: string) => void;

  branch: UseConversationBranch;

  // scroll handle wiring (engine → view)
  scrollRef: RefObject<ChatScrollHandle | null>;
}

export function useConversation(
  options: UseConversationOptions,
): UseConversation {
  const { conversationId: initialConversationId, onContextRefAdded } = options;

  const scrollRef = useRef<ChatScrollHandle | null>(null);
  const [view, setView] = useState<AcceptedView>(() => ({
    conversationId: initialConversationId,
    title: initialConversationId ? null : "New chat",
    messages: [],
    historyState: initialConversationId ? "Loading" : "Ready",
    forkOptionsByParentId: {},
    inactivePathsByLeafId: {},
    branchGraph: EMPTY_BRANCH_GRAPH,
    activeLeafMessageId: null,
    branchDraft: null,
  }));
  // Callbacks and stream frames read the same accepted value scheduled for render.
  const viewRef = useRef(view);
  const updateView = useCallback(
    (transition: (current: AcceptedView) => AcceptedView) => {
      const candidate = transition(viewRef.current);
      const draft = candidate.branchDraft;
      const next = draft &&
          !candidate.messages.some(
            (message) => message.id === draft.parentMessageId,
          )
        ? { ...candidate, branchDraft: null }
        : candidate;
      viewRef.current = next;
      setView(next);
    },
    [],
  );
  const dispatchMessages = useCallback(
    (action: Parameters<typeof messageUpdateReducer>[1]) => {
      updateView((current) => ({
        ...current,
        messages: messageUpdateReducer(current.messages, action),
      }));
    },
    [updateView],
  );
  const setForkOptionsByParentId = useCallback(
    (next: SetStateAction<Record<string, ForkOption[]>>) => {
      updateView((current) => ({
        ...current,
        forkOptionsByParentId: typeof next === "function"
          ? next(current.forkOptionsByParentId)
          : next,
      }));
    },
    [updateView],
  );
  const setBranchDraft = useCallback(
    (branchDraft: BranchDraft | null) => {
      updateView((current) => ({ ...current, branchDraft }));
    },
    [updateView],
  );
  const {
    conversationId,
    title,
    messages,
    historyState,
    forkOptionsByParentId,
    inactivePathsByLeafId,
    branchGraph,
    activeLeafMessageId,
    branchDraft,
  } = view;
  const loading = historyState === "Loading";
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [projectionReloadRequestId, setProjectionReloadRequestId] = useState<
    string | null
  >(null);
  const [asyncDefect, setAsyncDefect] = useState<{ error: unknown } | null>(
    null,
  );
  const reportAsyncDefect = useCallback((error: unknown) => {
    setAsyncDefect({ error });
  }, []);
  const reportProjectionReload = useCallback((operationError: unknown) => {
    if (!isChatReloadRequired(operationError)) return false;
    setProjectionReloadRequestId(operationError.requestId ?? "");
    return true;
  }, []);
  const reportOperationError = useCallback(
    (
      operationError: ApiError,
      operation:
        | "RefreshForks"
        | "Load"
        | "Rerun"
        | "Regenerate"
        | "Delete"
        | "SwitchFork",
    ) => {
      if (reportProjectionReload(operationError)) return;
      try {
        setError(conversationOperationErrorMessage(operationError, operation));
      } catch (defect) {
        reportAsyncDefect(defect);
      }
    },
    [reportAsyncDefect, reportProjectionReload],
  );
  const initialReadAbortRef = useRef<AbortController | null>(null);

  const rerunningAssistantMessageIds = useStringIdSet();
  const regeneratingAssistantMessageIds = useStringIdSet();
  // One retained idempotency key per source assistant message, so an explicit
  // retry after an ambiguous network loss replays the SAME command instead of
  // minting a second candidate (spec §5.4). Cleared on success, a definite
  // rejection, or a conversation change.
  const rerunKeysRef = useRef<Map<string, CandidateCommand>>(new Map());
  const regenerateKeysRef = useRef<Map<string, CandidateCommand>>(new Map());

  const activePathSwitchSeqRef = useRef(0);
  const shouldApplyRunToSelectedPath = useCallback(
    ({
      userMessageId,
      assistantMessageId,
    }: {
      userMessageId: string;
      assistantMessageId: string;
    }) => {
      const ids = selectedIds(viewRef.current);
      return ids.has(userMessageId) || ids.has(assistantMessageId);
    },
    [],
  );

  const shouldStartRunForCurrentConversation = useCallback(
    ({ conversationId: runConversationId }: { conversationId: string }) => {
      const currentConversationId = viewRef.current.conversationId;
      return (
        currentConversationId === null ||
        currentConversationId === runConversationId
      );
    },
    [],
  );

  const {
    tailChatRun,
    cancelRun,
    connectionRecoveries,
    reconnectRun,
  } = useChatRunTail({
    dispatch: dispatchMessages,
    setForkOptionsByParentId,
    onContextRefAdded,
    onProjectionReloadRequired: reportProjectionReload,
    onDefect: reportAsyncDefect,
    shouldStartRun: shouldStartRunForCurrentConversation,
    shouldApplyRun: shouldApplyRunToSelectedPath,
  });

  // --------------------------------------------------------------------------
  // Branching: active-runs resumption + tree application
  // --------------------------------------------------------------------------

  const loadVisibleActiveRuns = useCallback(
    async (
      id: string,
      visibleMessageIds: Set<string>,
      signal?: AbortSignal,
    ): Promise<ChatRunData[]> => {
      if (visibleMessageIds.size === 0) return [];
      const path = `/api/chat-runs?${new URLSearchParams({
        conversation_id: id,
        status: "active",
      })}` as ApiPath;
      const raw = await apiFetch<ApiJson<"/chat-runs", "get">>(
        path,
        signal ? { signal } : {},
      );
      const activeRuns: ChatRunListResponse = decodeApiPayload(
        raw,
        chatRunListFromWire,
        "Active chat runs",
      );
      return activeRuns.data
        .filter(
          (runData) =>
            runData.conversation.id === id &&
            (visibleMessageIds.has(runData.user_message.id) ||
              visibleMessageIds.has(runData.assistant_message.id)),
        );
    },
    [],
  );

  const tailVisibleActiveRuns = useCallback(
    async (visibleMessageIds: Set<string>) => {
      const id = viewRef.current.conversationId;
      if (!id || visibleMessageIds.size === 0) return;
      try {
        const activeRuns = await loadVisibleActiveRuns(id, visibleMessageIds);
        if (viewRef.current.conversationId !== id) return;
        for (const runData of activeRuns) {
          void tailChatRun(runData);
        }
      } catch (err) {
        if (reportProjectionReload(err)) return;
        if (handleUnauthenticatedApiError(err)) return;
        if (!isApiError(err) || isSameSystemApiDefect(err)) {
          reportAsyncDefect(err);
          return;
        }
        console.error("Failed to load active chat runs:", err);
      }
    },
    [loadVisibleActiveRuns, reportAsyncDefect, reportProjectionReload, tailChatRun],
  );

  const applyConversationTree = useCallback(
    (tree: ConversationTreeResponse) => {
      updateView((current) => viewFromTree(current, tree));
    },
    [updateView],
  );

  const refreshTreeForConversation = useCallback(
    async (id: string, reportError: boolean): Promise<boolean> => {
      try {
        const response = await apiFetch<
          ApiJson<"/conversations/{conversation_id}/tree", "get">
        >(`/api/conversations/${id}/tree`);
        if (viewRef.current.conversationId !== id) return false;
        applyConversationTree(conversationTreeFromWire(response.data));
        setError(null);
        return true;
      } catch (err) {
        if (reportProjectionReload(err)) return false;
        if (handleUnauthenticatedApiError(err)) return false;
        if (!isApiError(err) || isSameSystemApiDefect(err)) {
          reportAsyncDefect(err);
          return false;
        }
        if (reportError) {
          reportOperationError(err, "RefreshForks");
        } else {
          console.error("Failed to refresh conversation tree:", err);
        }
        return false;
      }
    },
    [
      applyConversationTree,
      reportAsyncDefect,
      reportOperationError,
      reportProjectionReload,
    ],
  );

  // A changed route remounts this owner. An admitted new chat changes its local
  // id without starting another initial load; its acknowledged tree is authoritative.
  useEffect(() => {
    if (!initialConversationId) return;
    const id = initialConversationId;
    const controller = new AbortController();
    initialReadAbortRef.current = controller;
    void (async () => {
      try {
        const { tree, activeRuns } = await requestWithRetry(async (signal) => {
          signal.throwIfAborted();
          const response = await apiFetch<
            ApiJson<"/conversations/{conversation_id}/tree", "get">
          >(`/api/conversations/${id}/tree`, { signal });
          const tree = conversationTreeFromWire(response.data);
          const visibleIds = selectedIds({
            messages: tree.selected_path,
            activeLeafMessageId: tree.active_leaf_message_id,
          });
          let activeRuns: ChatRunData[] = [];
          try {
            activeRuns = await loadVisibleActiveRuns(id, visibleIds, signal);
          } catch (err) {
            if (isAbortError(err) || signal.aborted) throw err;
            if (isChatReloadRequired(err)) throw err;
            if (handleUnauthenticatedApiError(err)) throw err;
            if (!isApiError(err) || isSameSystemApiDefect(err)) throw err;
            console.error("Failed to load active chat runs:", err);
          }
          signal.throwIfAborted();
          return { tree, activeRuns };
        }, controller.signal);
        if (controller.signal.aborted || viewRef.current.conversationId !== id) {
          return;
        }
        applyConversationTree(tree);
        for (const runData of activeRuns) {
          void tailChatRun(runData);
        }
        setError(null);
      } catch (err) {
        if (controller.signal.aborted || isAbortError(err)) return;
        if (reportProjectionReload(err)) return;
        if (handleUnauthenticatedApiError(err)) return;
        if (!isApiError(err) || isSameSystemApiDefect(err)) {
          reportAsyncDefect(err);
          return;
        }
        reportOperationError(err, "Load");
        updateView((current) => ({ ...current, historyState: "Unavailable" }));
      }
    })();
    return () => {
      controller.abort();
      if (initialReadAbortRef.current === controller) {
        initialReadAbortRef.current = null;
      }
    };
  }, [
    applyConversationTree,
    initialConversationId,
    loadVisibleActiveRuns,
    reportAsyncDefect,
    reportOperationError,
    reportProjectionReload,
    tailChatRun,
    updateView,
  ]);

  // --------------------------------------------------------------------------
  // Run created (optimistic seed + tail)
  // --------------------------------------------------------------------------

  const onChatRunCreated = useCallback(
    (runData: ChatRunData) => {
      const currentConversationId = viewRef.current.conversationId;
      if (
        currentConversationId !== null &&
        currentConversationId !== runData.conversation.id
      ) {
        return;
      }
      updateView((current) => {
        const nextLeaf = runData.assistant_message.id;
        const inactivePathsByLeafId = { ...current.inactivePathsByLeafId };
        if (
          current.activeLeafMessageId &&
          current.activeLeafMessageId !== nextLeaf
        ) {
          inactivePathsByLeafId[current.activeLeafMessageId] = current.messages;
        }
        delete inactivePathsByLeafId[nextLeaf];
        return {
          ...current,
          conversationId: runData.conversation.id,
          title: runData.conversation.title,
          activeLeafMessageId: nextLeaf,
          inactivePathsByLeafId,
          // A new conversation seeds its pair. A branch reply is merged by its tail.
          messages: runData.user_message.parent_message_id
            ? current.messages
            : messageUpdateReducer(current.messages, {
                type: "seed_optimistic",
                user: runData.user_message,
                assistant: runData.assistant_message,
              }),
        };
      });
      // Concurrent branch runs are intentional; a new run never aborts them.
      void tailChatRun(runData);
    },
    [tailChatRun, updateView],
  );
  const adoptAdmittedRun = useCallback(
    async (
      receipt: Parameters<typeof readAdmittedChatRun>[0],
      isCurrent: () => boolean,
    ): Promise<boolean> => {
      const data = await readAdmittedChatRun(receipt);
      if (!isCurrent()) return false;
      const id = receipt.outcome.conversation_id;
      const response = await apiFetch<ApiJson<"/conversations/{conversation_id}/tree", "get">>(
        `/api/conversations/${id}/tree`,
      );
      if (!isCurrent()) return false;
      let tree = conversationTreeFromWire(response.data);
      const containsAdmittedPair = (path: ConversationMessage[]) => {
        const userIndex = path.findIndex(
          (message) => message.id === data.user_message.id,
        );
        return (
          userIndex >= 0 &&
          path[userIndex].role === "user" &&
          path[userIndex + 1]?.id === receipt.outcome.assistant_message_id &&
          path[userIndex + 1]?.role === "assistant"
        );
      };
      if (tree.conversation.id !== id)
        throw new Error("Acknowledged chat tree identity mismatch");
      if (!containsAdmittedPair(tree.selected_path)) {
        const target = Object.entries(tree.path_cache_by_leaf_id)
          .filter(([, path]) => containsAdmittedPair(path))
          .sort(
            ([leftId, left], [rightId, right]) =>
              left.length - right.length || leftId.localeCompare(rightId),
          )[0];
        if (!target)
          throw new Error(
            "Acknowledged chat target missing from canonical tree",
          );
        const selected = await apiFetch<
          ApiJson<"/conversations/{conversation_id}/active-path", "post">
        >(
          `/api/conversations/${id}/active-path`,
          {
            method: "POST",
            body: JSON.stringify({ active_leaf_message_id: target[0] }),
          },
        );
        if (!isCurrent()) return false;
        tree = conversationTreeFromWire(selected.data);
        if (
          tree.conversation.id !== id ||
          !containsAdmittedPair(tree.selected_path)
        )
          throw new Error("Acknowledged chat target identity mismatch");
      }
      const visibleIds = selectedIds({
        messages: tree.selected_path,
        activeLeafMessageId: tree.active_leaf_message_id,
      });
      const activeRuns = await loadVisibleActiveRuns(
        id,
        visibleIds,
        new AbortController().signal,
      );
      if (!isCurrent()) return false;
      if (
        data.assistant_message.status === "pending" &&
        tree.selected_path.some(
          (message) =>
            message.id === data.assistant_message.id &&
            message.status === "pending",
        ) &&
        !activeRuns.some((run) => run.run.id === data.run.id)
      )
        activeRuns.push(data);
      initialReadAbortRef.current?.abort();
      initialReadAbortRef.current = null;
      applyConversationTree(tree);
      setError(null);
      // Terminal receipt runs are already projected by the current tree. Replaying
      // their candidate merge would truncate replies added after that old turn.
      for (const run of activeRuns) void tailChatRun(run);
      return true;
    },
    [
      applyConversationTree,
      loadVisibleActiveRuns,
      tailChatRun,
    ],
  );

  // --------------------------------------------------------------------------
  // Candidate actions (one new sibling candidate from a source assistant turn)
  // --------------------------------------------------------------------------

  // Rerun and Regenerate are the same client contract over different endpoints:
  // one durable sibling candidate from an owning source run. While a POST is
  // unresolved the source is busy-locked; a network loss retains its key so an
  // identical explicit retry replays the same command; a different selection
  // is a different answer identity (spec 5.2) and mints a fresh one; a definite
  // rejection consumes the key so the next invocation mints a fresh one.
  const runCandidateAction = useCallback(
    async (
      assistantMessageId: string,
      endpoint: ApiPath,
      busy: StringIdSet,
      keysRef: MutableRefObject<Map<string, CandidateCommand>>,
      operation: "Rerun" | "Regenerate",
      explicitSelection?: Readonly<{
        selection: GenerationSelectionSpec;
        catalogDefinitionRevision: string;
      }>,
    ): Promise<MessageActionMutationOutcome> => {
      if (busy.has(assistantMessageId)) return "Failed";
      busy.add(assistantMessageId);
      setError(null);
      try {
        let command = keysRef.current.get(assistantMessageId);
        if (
          command !== undefined &&
          explicitSelection !== undefined &&
          !sameGenerationSelection(
            command.request.selection,
            explicitSelection.selection,
          )
        ) {
          command = undefined;
        }
        if (command === undefined) {
          let selected = explicitSelection;
          if (selected === undefined) {
            const source = viewRef.current.messages.find(
              (message) => message.id === assistantMessageId,
            );
            const sourceSelection = source?.trust_trail?.run?.run_selection;
            if (source?.role !== "assistant" || sourceSelection === undefined) {
              throw new Error(
                "Candidate generation requires an immutable source run selection",
              );
            }
            const catalog = await loadGenerationCatalog({ refresh: true });
            const candidate = findGenerationCandidate(
              catalog,
              sourceSelection.selection,
            );
            if (
              candidate?.reasoning.chat_state.kind !== "Selectable"
            ) {
              setError({
                tone: "Warning",
                title: "The original model selection is unavailable.",
                message: "Choose a different model for this new run; nothing was substituted.",
              });
              return "Failed";
            }
            selected = {
              selection: sourceSelection.selection,
              catalogDefinitionRevision: catalog.definition_revision,
            };
          }
          command = {
            idempotencyKey: createRandomId(),
            request: {
              catalog_definition_revision:
                selected.catalogDefinitionRevision,
              selection: selected.selection,
            },
          };
          keysRef.current.set(assistantMessageId, command);
        }
        const rawResponse = await apiFetch<
          | ApiJson<"/messages/{assistant_message_id}/rerun", "post">
          | ApiJson<"/messages/{assistant_message_id}/regenerate", "post">
        >(endpoint, {
          method: "POST",
          headers: { "Idempotency-Key": command.idempotencyKey },
          body: JSON.stringify(command.request),
        });
        const response = decodeApiPayload(
          rawResponse,
          chatRunFromWire,
          `${operation} assistant response`,
        );
        keysRef.current.delete(assistantMessageId);
        onChatRunCreated(response.data);
        return "Committed";
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) return "Failed";
        if (!isApiError(err) || isSameSystemApiDefect(err)) {
          reportAsyncDefect(err);
          return "Failed";
        }
        // Operational uncertainty retains the exact command for an explicit retry.
        if (
          err.code !== "E_NETWORK" &&
          err.code !== "E_UPSTREAM" &&
          err.code !== "E_UPSTREAM_TIMEOUT" &&
          err.code !== "E_GENERATION_RUNTIME_UNAVAILABLE"
        ) {
          keysRef.current.delete(assistantMessageId);
        }
        reportOperationError(err, operation);
        return "Failed";
      } finally {
        busy.remove(assistantMessageId);
      }
    },
    [onChatRunCreated, reportAsyncDefect, reportOperationError],
  );

  const rerunAssistantResponse = useCallback(
    (assistantMessageId: string) =>
      runCandidateAction(
        assistantMessageId,
        `/api/messages/${assistantMessageId}/rerun` as ApiPath,
        rerunningAssistantMessageIds,
        rerunKeysRef,
        "Rerun",
      ),
    [rerunningAssistantMessageIds, runCandidateAction],
  );

  const rerunAssistantResponseWithSelection = useCallback(
    (
      assistantMessageId: string,
      selection: GenerationSelectionSpec,
      catalogDefinitionRevision: string,
    ) =>
      runCandidateAction(
        assistantMessageId,
        `/api/messages/${assistantMessageId}/rerun` as ApiPath,
        rerunningAssistantMessageIds,
        rerunKeysRef,
        "Rerun",
        { selection, catalogDefinitionRevision },
      ),
    [rerunningAssistantMessageIds, runCandidateAction],
  );

  const regenerateAssistantResponse = useCallback(
    (assistantMessageId: string) =>
      runCandidateAction(
        assistantMessageId,
        `/api/messages/${assistantMessageId}/regenerate` as ApiPath,
        regeneratingAssistantMessageIds,
        regenerateKeysRef,
        "Regenerate",
      ),
    [regeneratingAssistantMessageIds, runCandidateAction],
  );

  const regenerateAssistantResponseWithSelection = useCallback(
    (
      assistantMessageId: string,
      selection: GenerationSelectionSpec,
      catalogDefinitionRevision: string,
    ) =>
      runCandidateAction(
        assistantMessageId,
        `/api/messages/${assistantMessageId}/regenerate` as ApiPath,
        regeneratingAssistantMessageIds,
        regenerateKeysRef,
        "Regenerate",
        { selection, catalogDefinitionRevision },
      ),
    [regeneratingAssistantMessageIds, runCandidateAction],
  );

  const deleteMessage = useCallback(
    async (
      messageId: string,
      execute: Parameters<DeleteMessageMutation>[1],
      settleConversation: Parameters<DeleteMessageMutation>[2],
    ): Promise<void> => {
      try {
        const currentConversationId = viewRef.current.conversationId;
        if (currentConversationId === null) {
          throw new Error(
            "Mounted Message deletion has no Conversation identity",
          );
        }
        const outcome = await execute(
          () =>
            deleteConversationMessage({
              messageId,
              conversationId: currentConversationId,
            }),
          async (receipt) => {
            let localProjectionError: unknown;
            try {
              const remainingMessages = messageUpdateReducer(
                viewRef.current.messages,
                { type: "remove_subtree", rootMessageId: messageId },
              );
              updateView((current) => ({
                ...current,
                messages: remainingMessages,
                ...(remainingMessages.length === 0
                  ? {
                      forkOptionsByParentId: {},
                      inactivePathsByLeafId: {},
                      branchGraph: EMPTY_BRANCH_GRAPH,
                      activeLeafMessageId: null,
                    }
                  : {}),
              }));
              rerunningAssistantMessageIds.remove(messageId);
              regeneratingAssistantMessageIds.remove(messageId);
              rerunKeysRef.current.delete(messageId);
              regenerateKeysRef.current.delete(messageId);

              if (remainingMessages.length > 0) {
                await refreshTreeForConversation(currentConversationId, false);
              }
            } catch (error) {
              localProjectionError = error;
            }

            settleConversation({
              conversationRef: canonicalResourceRef({
                scheme: "conversation",
                id: currentConversationId,
              }),
              conversationDeleted: receipt.conversationDeleted,
            });
            if (localProjectionError !== undefined) {
              throw localProjectionError;
            }
          },
        );
        if (outcome.projectionError !== undefined) {
          const error = outcome.projectionError;
          if (handleUnauthenticatedApiError(error)) return;
          if (!isApiError(error) || isSameSystemApiDefect(error)) {
            reportAsyncDefect(error);
            return;
          }
          reportOperationError(error, "RefreshForks");
        }
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) return;
        if (!isApiError(err) || isSameSystemApiDefect(err)) {
          reportAsyncDefect(err);
          return;
        }
        reportOperationError(err, "Delete");
      }
    },
    [
      refreshTreeForConversation,
      regeneratingAssistantMessageIds,
      reportAsyncDefect,
      reportOperationError,
      rerunningAssistantMessageIds,
      updateView,
    ],
  );

  const reconnectAssistantResponse = useCallback(
    (assistantMessageId: string) => {
      void reconnectRun(assistantMessageId);
    },
    [reconnectRun],
  );

  // --------------------------------------------------------------------------
  // Branch operations
  // --------------------------------------------------------------------------

  const reloadTree = useCallback(async () => {
    const id = viewRef.current.conversationId;
    if (!id) return false;
    return refreshTreeForConversation(id, true);
  }, [refreshTreeForConversation]);

  const switchToLeaf = useCallback(
    async (nextLeafId: string, anchorMessageId: string | null) => {
      const previous = viewRef.current;
      const id = previous.conversationId;
      if (!id) return false;
      const nextPath = nextLeafId === previous.activeLeafMessageId
        ? previous.messages
        : previous.inactivePathsByLeafId[nextLeafId];
      if (!nextPath) {
        setError({
          tone: "Danger",
          title: "This fork is not available yet.",
        });
        return false;
      }

      const switchSeq = activePathSwitchSeqRef.current + 1;
      activePathSwitchSeqRef.current = switchSeq;

      // Snapshot the eye-line before swapping messages; the scroll owner
      // restores it on the next messages-driven layout. Keep the current path
      // only when departing it; stream frames do not copy the cache.
      scrollRef.current?.captureAnchor(anchorMessageId);
      updateView((current) => {
        const inactivePathsByLeafId = { ...current.inactivePathsByLeafId };
        if (
          current.activeLeafMessageId &&
          current.activeLeafMessageId !== nextLeafId
        ) {
          inactivePathsByLeafId[current.activeLeafMessageId] = current.messages;
        }
        delete inactivePathsByLeafId[nextLeafId];
        return {
          ...current,
          messages: messageUpdateReducer(current.messages, {
            type: "set_all",
            messages: nextPath,
          }),
          activeLeafMessageId: nextLeafId,
          inactivePathsByLeafId,
          forkOptionsByParentId: activeForkOptionsForPath(
            current.forkOptionsByParentId,
            nextPath,
          ),
          branchGraph: activeBranchGraphForPath(current.branchGraph, nextPath),
        };
      });
      setError(null);
      void tailVisibleActiveRuns(selectedIds(viewRef.current));

      try {
        const response = await apiFetch<
          ApiJson<"/conversations/{conversation_id}/active-path", "post">
        >(
          `/api/conversations/${id}/active-path`,
          {
            method: "POST",
            body: JSON.stringify({ active_leaf_message_id: nextLeafId }),
          },
        );
        if (activePathSwitchSeqRef.current !== switchSeq) return false;
        scrollRef.current?.captureAnchor(anchorMessageId);
        applyConversationTree(conversationTreeFromWire(response.data));
        void tailVisibleActiveRuns(selectedIds(viewRef.current));
        return true;
      } catch (err) {
        if (activePathSwitchSeqRef.current !== switchSeq) return false;
        if (handleUnauthenticatedApiError(err)) return false;
        if (!isApiError(err) || isSameSystemApiDefect(err)) {
          reportAsyncDefect(err);
          return false;
        }
        reportOperationError(err, "SwitchFork");
        scrollRef.current?.captureAnchor(anchorMessageId);
        updateView((current) => {
          const inactivePathsByLeafId = { ...current.inactivePathsByLeafId };
          if (
            current.activeLeafMessageId &&
            current.activeLeafMessageId !== previous.activeLeafMessageId
          ) {
            inactivePathsByLeafId[current.activeLeafMessageId] =
              current.messages;
          }
          if (previous.activeLeafMessageId) {
            delete inactivePathsByLeafId[previous.activeLeafMessageId];
          }
          return {
            ...current,
            messages: messageUpdateReducer(current.messages, {
              type: "set_all",
              messages: previous.messages,
            }),
            activeLeafMessageId: previous.activeLeafMessageId,
            inactivePathsByLeafId,
            branchDraft: previous.branchDraft,
            forkOptionsByParentId: previous.forkOptionsByParentId,
            branchGraph: previous.branchGraph,
          };
        });
        return false;
      }
    },
    [
      applyConversationTree,
      reportAsyncDefect,
      reportOperationError,
      tailVisibleActiveRuns,
      updateView,
    ],
  );

  const switchToFork = useCallback(
    async (fork: ForkOption) => {
      await switchToLeaf(fork.leaf_message_id, fork.parent_message_id);
    },
    [switchToLeaf],
  );

  const revealMessage = useCallback(
    async (messageId: string): Promise<boolean> => {
      const current = viewRef.current;
      if (current.messages.some((message) => message.id === messageId)) {
        return true;
      }

      const candidate = Object.entries(current.inactivePathsByLeafId)
        .filter(([, path]) => path.some((message) => message.id === messageId))
        .sort(
          ([leftLeafId, leftPath], [rightLeafId, rightPath]) =>
            leftPath.length - rightPath.length ||
            leftLeafId.localeCompare(rightLeafId),
        )[0];
      if (!candidate) {
        setError({
          tone: "Danger",
          title: "This message is not available in this conversation.",
        });
        return false;
      }
      return switchToLeaf(candidate[0], null);
    },
    [switchToLeaf],
  );

  // The pane keys its route-target effect on this public branch object.
  const branch = useMemo<UseConversationBranch>(() => ({
    forkOptionsByParentId,
    branchGraph,
    switchableLeafIds: new Set([
      ...Object.keys(inactivePathsByLeafId),
      ...(activeLeafMessageId ? [activeLeafMessageId] : []),
    ]),
    activeLeafMessageId,
    selectedPathMessageIds: selectedIds({ messages, activeLeafMessageId }),
    branchDraft,
    setBranchDraft,
    switchToLeaf,
    switchToFork,
    revealMessage,
    reload: reloadTree,
  }), [
    activeLeafMessageId,
    branchDraft,
    branchGraph,
    forkOptionsByParentId,
    inactivePathsByLeafId,
    messages,
    reloadTree,
    revealMessage,
    setBranchDraft,
    switchToFork,
    switchToLeaf,
  ]);

  // The default continuation reply parent: only the complete assistant leaf of
  // the rendered transcript. Older complete assistants are not safe continuation
  // parents while a newer turn is pending, failed, or user-only.
  const leaf = messages[messages.length - 1];
  const replyParentMessageId =
    leaf?.role === "assistant" && leaf.status === "complete" ? leaf.id : null;

  const selectionParent = branchDraft
    ? messages.find((message) => message.id === branchDraft.parentMessageId)
    : leaf;
  if (branchDraft && selectionParent?.role !== "assistant") {
    // justify-defect: accepted view clears drafts whose parent leaves the path.
    throw new Error("Branch draft parent must be an assistant message");
  }
  const inheritedRunSelection = selectionParent?.role === "assistant"
    ? selectionParent.trust_trail?.run?.run_selection ?? null
    : null;

  const selectedPendingRuns = messages.filter(
    (message) => message.role === "assistant" &&
      message.status === "pending",
  );
  if (selectedPendingRuns.length > 1) {
    throw new Error("Selected reply path has more than one pending run");
  }
  const activeRun = selectedPendingRuns[0]?.trust_trail?.run;
  const activeRunId = activeRun?.run_id ?? null;
  const activeRunExecution = activeRun?.execution.kind === "Present"
    ? activeRun.execution.value : null;
  const cancelActiveRun = useCallback(async () => {
    if (activeRunId !== null) await cancelRun(activeRunId);
  }, [activeRunId, cancelRun]);

  let sendCapability: ChatSendCapability;
  if (selectedPendingRuns.length > 0) {
    sendCapability = { kind: "AssistantRunning" };
  } else if (!conversationId) {
    sendCapability = { kind: "Available" };
  } else if (loading) {
    sendCapability = { kind: "HistoryLoading" };
  } else if (historyState === "Unavailable") {
    sendCapability = { kind: "HistoryUnavailable" };
  } else if (messages.length === 0) {
    sendCapability = { kind: "Available" };
  } else if (branchDraft) {
    sendCapability = messages.some(
      (message) =>
        message.id === branchDraft.parentMessageId &&
        message.role === "assistant" &&
        message.status === "complete",
    )
      ? { kind: "Available" }
      : { kind: "ReplyTargetUnavailable" };
  } else {
    sendCapability = replyParentMessageId
      ? { kind: "Available" }
      : { kind: "ReplyTargetUnavailable" };
  }

  if (asyncDefect !== null) throw asyncDefect.error;

  return {
    messages,
    loading,
    error,
    projectionReloadRequestId,
    replyParentMessageId,
    inheritedRunSelection,
    sendCapability,
    conversationId,
    title,
    adoptAdmittedRun,
    activeRunId,
    activeRunExecution,
    cancelActiveRun,
    rerunAssistantResponse,
    rerunAssistantResponseWithSelection,
    rerunningAssistantMessageIds: rerunningAssistantMessageIds.ids,
    regenerateAssistantResponse,
    regenerateAssistantResponseWithSelection,
    deleteMessage,
    connectionRecoveries,
    reconnectAssistantResponse,
    branch,
    scrollRef,
  };
}
