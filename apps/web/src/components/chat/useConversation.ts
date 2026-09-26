"use client";

/**
 * useConversation — the single live-chat engine.
 *
 * Consolidates the message lifecycle for the conversation pane and the new-chat
 * route: history load, resolve/create-on-send, optimistic seeding, retry,
 * branch state, and context-ref fan-out. History is one load:
 * GET /conversations/{id}/tree — the entire selected path plus fork data, with
 * no pagination.
 *
 * Scroll lives entirely in the view (ChatSurface/useChatScroll); the engine
 * only holds the `scrollRef` it hands to the view and calls `captureAnchor`
 * before path-changing setMessages so the scroll owner can restore the eye-line.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type { MutableRefObject, RefObject } from "react";
import {
  apiFetch,
  decodeApiPayload,
  isApiError,
  isSameSystemApiDefect,
  isToolProjectionReloadRequired,
  type ApiError,
  type ApiPath,
} from "@/lib/api/client";
import { useResource } from "@/lib/api/useResource";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { createRandomId } from "@/lib/createRandomId";
import { isAbortError } from "@/lib/errors";
import { useChatRunTail } from "@/components/chat/useChatRunTail";
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
  decodeChatRunListResponse,
  decodeChatRunResponse,
  decodeConversationTree,
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
type ConversationHistorySnapshot = {
  adoptionVersion: number;
  conversationId: string;
  tree: ConversationTreeResponse;
  activeRuns: ChatRunData[];
};

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

  const [conversationId, setConversationId] = useState<string | null>(
    initialConversationId,
  );
  // An existing conversation has no known title until the server sends one; the
  // canonical pane title must stay unresolved rather than claim "New chat".
  const [title, setTitle] = useState<string | null>(
    initialConversationId ? null : "New chat",
  );
  // The reducer is the single owner of every transcript transition; the engine
  // holds the state and dispatches actions (it is the only `setMessages`-class
  // consumer — there is no raw setter).
  const [messages, dispatchMessages] = useReducer(
    messageUpdateReducer,
    [] as ConversationMessage[],
  );
  const [historyState, setHistoryState] = useState<"Loading" | "Unavailable" | "Ready">(
    initialConversationId ? "Loading" : "Ready",
  );
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
    if (!isToolProjectionReloadRequired(operationError)) return false;
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
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;
  // A history request begun before receipt adoption cannot replace its newer tree.
  const adoptionVersionRef = useRef(0);
  const historyRequestRef = useRef<{
    signal: AbortSignal;
    controller: AbortController;
  } | null>(null);

  // Branch state.
  const [forkOptionsByParentId, setForkOptionsByParentId] = useState<
    Record<string, ForkOption[]>
  >({});
  const [pathCacheByLeafId, setPathCacheByLeafId] = useState<
    Record<string, ConversationMessage[]>
  >({});
  const [branchGraph, setBranchGraph] =
    useState<BranchGraph>(EMPTY_BRANCH_GRAPH);
  const [activeLeafMessageId, setActiveLeafMessageId] = useState<string | null>(
    null,
  );
  const [branchDraft, setBranchDraft] = useState<BranchDraft | null>(null);

  const rerunningAssistantMessageIds = useStringIdSet();
  const regeneratingAssistantMessageIds = useStringIdSet();
  // One retained idempotency key per source assistant message, so an explicit
  // retry after an ambiguous network loss replays the SAME command instead of
  // minting a second candidate (spec §5.4). Cleared on success, a definite
  // rejection, or a conversation change.
  const rerunKeysRef = useRef<Map<string, CandidateCommand>>(new Map());
  const regenerateKeysRef = useRef<Map<string, CandidateCommand>>(new Map());

  const selectedPathIdsRef = useRef<Set<string>>(new Set());
  const activePathSwitchSeqRef = useRef(0);
  const revealMessageRequestsRef = useRef<Map<string, Promise<boolean>>>(
    new Map(),
  );
  // Single-flight guard for the active-runs fetch so the initial load and the two
  // branch-switch calls share one in-flight GET instead of issuing duplicates.
  const activeRunsRequestRef = useRef<Promise<ChatRunListResponse> | null>(
    null,
  );
  const treeRequestRef = useRef<{
    conversationId: string;
    promise: Promise<{ data: ConversationTreeResponse }>;
  } | null>(null);
  const routeConversationIdRef = useRef(initialConversationId);

  const messageIdsForPath = useCallback(
    (path: ConversationMessage[], leafMessageId: string | null = null) => {
      const ids = selectedPathMessageIds(path);
      if (leafMessageId) ids.add(leafMessageId);
      return ids;
    },
    [],
  );

  const shouldApplyRunToSelectedPath = useCallback(
    ({
      userMessageId,
      assistantMessageId,
    }: {
      userMessageId: string;
      assistantMessageId: string;
    }) =>
      selectedPathIdsRef.current.has(userMessageId) ||
      selectedPathIdsRef.current.has(assistantMessageId),
    [],
  );

  const shouldStartRunForCurrentConversation = useCallback(
    ({ conversationId: runConversationId }: { conversationId: string }) => {
      const currentConversationId = conversationIdRef.current;
      return (
        currentConversationId === null ||
        currentConversationId === runConversationId
      );
    },
    [],
  );

  const {
    activeRunId,
    tailChatRun,
    abortAll,
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
  const tailChatRunRef = useRef(tailChatRun);

  useEffect(() => {
    tailChatRunRef.current = tailChatRun;
  }, [tailChatRun]);

  const cancelActiveRun = useCallback(async () => {
    await cancelRun(activeRunId);
  }, [activeRunId, cancelRun]);

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
      let activeRuns: ChatRunListResponse;
      if (signal) {
        const raw = await apiFetch<unknown>(path, { signal });
        activeRuns = decodeApiPayload(
          raw,
          decodeChatRunListResponse,
          "Active chat runs",
        );
      } else {
        activeRuns = await (activeRunsRequestRef.current ??
          (activeRunsRequestRef.current = apiFetch<unknown>(path)
            .then((response) =>
              decodeApiPayload(
                response,
                decodeChatRunListResponse,
                "Active chat runs",
              ),
            )
            .finally(() => {
              activeRunsRequestRef.current = null;
            })));
      }
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
      const id = conversationId;
      if (!id || visibleMessageIds.size === 0) return;
      try {
        const activeRuns = await loadVisibleActiveRuns(id, visibleMessageIds);
        if (conversationIdRef.current !== id) return;
        for (const runData of activeRuns) {
          void tailChatRunRef.current(runData);
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
    [
      conversationId,
      loadVisibleActiveRuns,
      reportAsyncDefect,
      reportProjectionReload,
    ],
  );

  const applyConversationTree = useCallback(
    (tree: ConversationTreeResponse) => {
      setHistoryState("Ready");
      setTitle(tree.conversation.title);
      dispatchMessages({ type: "set_all", messages: tree.selected_path });
      selectedPathIdsRef.current = messageIdsForPath(
        tree.selected_path,
        tree.active_leaf_message_id,
      );
      setForkOptionsByParentId(tree.fork_options_by_parent_id);
      setPathCacheByLeafId(tree.path_cache_by_leaf_id);
      setBranchGraph(tree.branch_graph);
      setActiveLeafMessageId(tree.active_leaf_message_id);
    },
    [messageIdsForPath],
  );

  const loadConversationTree = useCallback(
    (id: string, signal?: AbortSignal) => {
      if (signal) {
        return apiFetch<{ data: ConversationTreeResponse }>(
          `/api/conversations/${id}/tree`,
          { signal },
        );
      }
      if (treeRequestRef.current?.conversationId === id) {
        return treeRequestRef.current.promise;
      }
      const request = apiFetch<{ data: ConversationTreeResponse }>(
        `/api/conversations/${id}/tree`,
      );
      const promise = request.finally(() => {
        if (treeRequestRef.current?.promise === promise) {
          treeRequestRef.current = null;
        }
      });
      treeRequestRef.current = { conversationId: id, promise };
      return promise;
    },
    [],
  );

  const refreshTreeForConversation = useCallback(
    async (id: string, reportError: boolean): Promise<boolean> => {
      try {
        const response = await loadConversationTree(id);
        if (conversationIdRef.current !== id) return false;
        applyConversationTree(decodeConversationTree(response.data));
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
      loadConversationTree,
      reportAsyncDefect,
      reportOperationError,
      reportProjectionReload,
    ],
  );

  const loadConversationHistory = useCallback(
    async (
      id: string,
      signal: AbortSignal,
    ): Promise<ConversationHistorySnapshot> => {
      const adoptionVersion = adoptionVersionRef.current;
      const response = await loadConversationTree(id, signal);
      const visibleMessageIds = messageIdsForPath(
        response.data.selected_path,
        response.data.active_leaf_message_id,
      );
      let activeRuns: ChatRunData[] = [];
      try {
        activeRuns = await loadVisibleActiveRuns(id, visibleMessageIds, signal);
      } catch (err) {
        if (isAbortError(err) || signal.aborted) throw err;
        if (isToolProjectionReloadRequired(err)) throw err;
        if (handleUnauthenticatedApiError(err)) throw err;
        if (!isApiError(err) || isSameSystemApiDefect(err)) throw err;
        console.error("Failed to load active chat runs:", err);
      }
      return {
        adoptionVersion,
        conversationId: id,
        tree: decodeConversationTree(response.data),
        activeRuns,
      };
    },
    [loadConversationTree, loadVisibleActiveRuns, messageIdsForPath],
  );

  const historyResource = useResource<ConversationHistorySnapshot>({
    cacheKey:
      conversationId !== null ? `conversation-tree:${conversationId}` : null,
    load: async (signal) => {
      if (!conversationId) {
        throw new Error("Cannot load conversation history without an id");
      }
      if (historyRequestRef.current?.signal !== signal)
        historyRequestRef.current = {
          signal,
          controller: new AbortController(),
        };
      // Bind every retry of this resource request to the same cancellation owner.
      const historySignal = AbortSignal.any([
        signal,
        historyRequestRef.current.controller.signal,
      ]);
      try {
        historySignal.throwIfAborted();
        const history = await loadConversationHistory(
          conversationId,
          historySignal,
        );
        historySignal.throwIfAborted();
        return history;
      } catch (error) {
        // A transport may settle after abort. Preserve cancellation so the
        // resource owner cannot publish its late modeled error or pane defect.
        historySignal.throwIfAborted();
        throw error;
      }
    },
  });

  // --------------------------------------------------------------------------
  // History load
  // --------------------------------------------------------------------------

  useLayoutEffect(() => {
    if (routeConversationIdRef.current === initialConversationId) return;
    routeConversationIdRef.current = initialConversationId;
    conversationIdRef.current = initialConversationId;
    activePathSwitchSeqRef.current += 1;
    revealMessageRequestsRef.current.clear();
    activeRunsRequestRef.current = null;
    treeRequestRef.current = null;

    abortAll();
    setConversationId(initialConversationId);
    setTitle("New chat");
    dispatchMessages({ type: "set_all", messages: [] });
    setHistoryState(initialConversationId ? "Loading" : "Ready");
    setError(null);
    setForkOptionsByParentId({});
    setPathCacheByLeafId({});
    setBranchGraph(EMPTY_BRANCH_GRAPH);
    setActiveLeafMessageId(null);
    setBranchDraft(null);
    selectedPathIdsRef.current = new Set();
    rerunningAssistantMessageIds.clear();
    regeneratingAssistantMessageIds.clear();
    rerunKeysRef.current.clear();
    regenerateKeysRef.current.clear();
  }, [
    abortAll,
    conversationId,
    initialConversationId,
    regeneratingAssistantMessageIds,
    rerunningAssistantMessageIds,
  ]);

  // Drop any in-flight active-runs promise scoped to a previous conversation.
  useEffect(() => {
    activeRunsRequestRef.current = null;
    treeRequestRef.current = null;
  }, [conversationId]);

  useEffect(() => {
    const id = conversationId;
    if (!id) {
      setHistoryState("Ready");
      return;
    }
    if (historyResource.status === "loading") {
      setHistoryState("Loading");
      setError(null);
      return;
    }
    if (historyResource.status === "error") {
      reportOperationError(historyResource.error, "Load");
      setHistoryState("Unavailable");
      return;
    }
    if (
      historyResource.status !== "ready" ||
      historyResource.data.conversationId !== id ||
      historyResource.data.adoptionVersion !== adoptionVersionRef.current ||
      conversationIdRef.current !== id
    ) {
      return;
    }

    applyConversationTree(historyResource.data.tree);
    for (const runData of historyResource.data.activeRuns) {
      void tailChatRunRef.current(runData);
    }
    setError(null);
  }, [
    applyConversationTree,
    conversationId,
    historyResource,
    reportOperationError,
  ]);

  useEffect(() => abortAll, [abortAll]);

  // Keep the path-id ref in sync with the rendered transcript so streaming
  // runs are filtered to the visible path.
  selectedPathIdsRef.current = useMemo(
    () => messageIdsForPath(messages, activeLeafMessageId),
    [activeLeafMessageId, messageIdsForPath, messages],
  );

  // Cache the active path so a fork switch can restore it without a refetch.
  useEffect(() => {
    if (!activeLeafMessageId || messages.length === 0) return;
    setPathCacheByLeafId((prev) => {
      if (prev[activeLeafMessageId] === messages) return prev;
      return { ...prev, [activeLeafMessageId]: messages };
    });
  }, [activeLeafMessageId, messages]);

  // --------------------------------------------------------------------------
  // Run created (optimistic seed + tail)
  // --------------------------------------------------------------------------

  const onChatRunCreated = useCallback(
    (runData: ChatRunData) => {
      const currentConversationId = conversationIdRef.current;
      if (
        currentConversationId !== null &&
        currentConversationId !== runData.conversation.id
      ) {
        return;
      }
      conversationIdRef.current = runData.conversation.id;
      setConversationId(runData.conversation.id);
      setTitle(runData.conversation.title);
      setActiveLeafMessageId(runData.assistant_message.id);
      selectedPathIdsRef.current = new Set([
        ...selectedPathIdsRef.current,
        runData.user_message.id,
        runData.assistant_message.id,
      ]);
      // Seed the optimistic pair for a brand-new turn (no branch parent). For a
      // branch reply, useChatRunTail merges it into the existing path.
      if (!runData.user_message.parent_message_id) {
        dispatchMessages({
          type: "seed_optimistic",
          user: runData.user_message,
          assistant: runData.assistant_message,
        });
      }
      // Concurrent branch runs are intentional; a new run never aborts them.
      void tailChatRun(runData);
    },
    [tailChatRun],
  );
  const adoptAdmittedRun = useCallback(
    async (
      receipt: Parameters<typeof readAdmittedChatRun>[0],
      isCurrent: () => boolean,
    ): Promise<boolean> => {
      const data = await readAdmittedChatRun(receipt);
      if (!isCurrent()) return false;
      const id = receipt.outcome.conversation_id;
      const response = await apiFetch<{ data: ConversationTreeResponse }>(
        `/api/conversations/${id}/tree`,
      );
      if (!isCurrent()) return false;
      let tree = decodeConversationTree(response.data);
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
        const selected = await apiFetch<{ data: ConversationTreeResponse }>(
          `/api/conversations/${id}/active-path`,
          {
            method: "POST",
            body: JSON.stringify({ active_leaf_message_id: target[0] }),
          },
        );
        if (!isCurrent()) return false;
        tree = decodeConversationTree(selected.data);
        if (
          tree.conversation.id !== id ||
          !containsAdmittedPair(tree.selected_path)
        )
          throw new Error("Acknowledged chat target identity mismatch");
      }
      const visibleIds = messageIdsForPath(
        tree.selected_path,
        tree.active_leaf_message_id,
      );
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
      adoptionVersionRef.current += 1;
      historyRequestRef.current?.controller.abort();
      conversationIdRef.current = id;
      setConversationId(id);
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
      messageIdsForPath,
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
            const source = messages.find(
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
              !sourceSelection.rerun_eligibility ||
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
        const rawResponse = await apiFetch<unknown>(endpoint, {
          method: "POST",
          headers: { "Idempotency-Key": command.idempotencyKey },
          body: JSON.stringify(command.request),
        });
        const response = decodeApiPayload(
          rawResponse,
          decodeChatRunResponse,
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
    [messages, onChatRunCreated, reportAsyncDefect, reportOperationError],
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
        const currentConversationId = conversationIdRef.current;
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
              const remainingMessages = messageUpdateReducer(messages, {
                type: "remove_subtree",
                rootMessageId: messageId,
              });
              dispatchMessages({
                type: "remove_subtree",
                rootMessageId: messageId,
              });
              rerunningAssistantMessageIds.remove(messageId);
              regeneratingAssistantMessageIds.remove(messageId);
              rerunKeysRef.current.delete(messageId);
              regenerateKeysRef.current.delete(messageId);

              if (remainingMessages.length === 0) {
                setForkOptionsByParentId({});
                setPathCacheByLeafId({});
                setBranchGraph(EMPTY_BRANCH_GRAPH);
                setActiveLeafMessageId(null);
                selectedPathIdsRef.current = new Set();
              } else {
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
      messages,
      refreshTreeForConversation,
      regeneratingAssistantMessageIds,
      reportAsyncDefect,
      reportOperationError,
      rerunningAssistantMessageIds,
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
    const id = conversationId;
    if (!id) return false;
    return refreshTreeForConversation(id, true);
  }, [conversationId, refreshTreeForConversation]);

  const switchToLeaf = useCallback(
    async (nextLeafId: string, anchorMessageId: string | null) => {
      const id = conversationId;
      if (!id) return false;
      const nextPath = pathCacheByLeafId[nextLeafId];
      if (!nextPath) {
        setError({
          tone: "Danger",
          title: "This fork is not available yet.",
        });
        return false;
      }

      const switchSeq = activePathSwitchSeqRef.current + 1;
      activePathSwitchSeqRef.current = switchSeq;

      const previous = {
        messages,
        activeLeafMessageId,
        forkOptionsByParentId,
        branchGraph,
        branchDraft,
      };

      // Snapshot the eye-line before swapping messages; the scroll owner
      // restores it on the next messages-driven layout.
      scrollRef.current?.captureAnchor(anchorMessageId);

      dispatchMessages({ type: "set_all", messages: nextPath });
      selectedPathIdsRef.current = messageIdsForPath(nextPath, nextLeafId);
      setActiveLeafMessageId(nextLeafId);
      if (
        branchDraft &&
        !nextPath.some((message) => message.id === branchDraft.parentMessageId)
      ) {
        setBranchDraft(null);
      }
      setForkOptionsByParentId((prev) =>
        activeForkOptionsForPath(prev, nextPath),
      );
      setBranchGraph((prev) => activeBranchGraphForPath(prev, nextPath));
      setError(null);
      void tailVisibleActiveRuns(selectedPathIdsRef.current);

      try {
        const response = await apiFetch<{ data: ConversationTreeResponse }>(
          `/api/conversations/${id}/active-path`,
          {
            method: "POST",
            body: JSON.stringify({ active_leaf_message_id: nextLeafId }),
          },
        );
        if (activePathSwitchSeqRef.current !== switchSeq) return false;
        scrollRef.current?.captureAnchor(anchorMessageId);
        applyConversationTree(decodeConversationTree(response.data));
        void tailVisibleActiveRuns(
          messageIdsForPath(
            response.data.selected_path,
            response.data.active_leaf_message_id,
          ),
        );
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
        dispatchMessages({ type: "set_all", messages: previous.messages });
        selectedPathIdsRef.current = messageIdsForPath(
          previous.messages,
          previous.activeLeafMessageId,
        );
        setActiveLeafMessageId(previous.activeLeafMessageId);
        setBranchDraft(previous.branchDraft);
        setForkOptionsByParentId(previous.forkOptionsByParentId);
        setBranchGraph(previous.branchGraph);
        return false;
      }
    },
    [
      activeLeafMessageId,
      applyConversationTree,
      branchDraft,
      branchGraph,
      conversationId,
      forkOptionsByParentId,
      messageIdsForPath,
      messages,
      pathCacheByLeafId,
      reportAsyncDefect,
      reportOperationError,
      tailVisibleActiveRuns,
    ],
  );

  const switchToFork = useCallback(
    async (fork: ForkOption) => {
      await switchToLeaf(fork.leaf_message_id, fork.parent_message_id);
    },
    [switchToLeaf],
  );

  const revealMessage = useCallback(
    (messageId: string): Promise<boolean> => {
      const requestKey = `${conversationId ?? "new"}:${messageId}`;
      const existingRequest = revealMessageRequestsRef.current.get(requestKey);
      if (existingRequest) return existingRequest;

      const request = (async () => {
        if (messages.some((message) => message.id === messageId)) return true;

        const candidate = Object.entries(pathCacheByLeafId)
          .filter(([, path]) =>
            path.some((message) => message.id === messageId),
          )
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
      })();

      revealMessageRequestsRef.current.set(requestKey, request);
      void request.then(
        () => {
          if (revealMessageRequestsRef.current.get(requestKey) === request) {
            revealMessageRequestsRef.current.delete(requestKey);
          }
        },
        () => {
          if (revealMessageRequestsRef.current.get(requestKey) === request) {
            revealMessageRequestsRef.current.delete(requestKey);
          }
        },
      );
      return request;
    },
    [conversationId, messages, pathCacheByLeafId, switchToLeaf],
  );

  const switchableLeafIds = useMemo(
    () => new Set(Object.keys(pathCacheByLeafId)),
    [pathCacheByLeafId],
  );

  const branch = useMemo<UseConversationBranch>(
    () => ({
      forkOptionsByParentId,
      branchGraph,
      switchableLeafIds,
      activeLeafMessageId,
      selectedPathMessageIds: selectedPathIdsRef.current,
      branchDraft,
      setBranchDraft,
      switchToLeaf,
      switchToFork,
      revealMessage,
      reload: reloadTree,
    }),
    [
      activeLeafMessageId,
      branchDraft,
      branchGraph,
      forkOptionsByParentId,
      reloadTree,
      revealMessage,
      switchToFork,
      switchToLeaf,
      switchableLeafIds,
    ],
  );

  // The default continuation reply parent: only the complete assistant leaf of
  // the rendered transcript. Older complete assistants are not safe continuation
  // parents while a newer turn is pending, failed, or user-only.
  const replyParentMessageId = useMemo(() => {
    const leaf = messages[messages.length - 1];
    if (leaf?.role === "assistant" && leaf.status === "complete")
      return leaf.id;
    return null;
  }, [messages]);

  const inheritedRunSelection = useMemo(() => {
    const assistant = branchDraft
      ? messages.find((message) => message.id === branchDraft.parentMessageId)
      : messages[messages.length - 1];
    if (!assistant || assistant.role !== "assistant") {
      if (branchDraft) {
        // justify-defect: BranchDraft is created only from a rendered assistant
        // and is cleared when that assistant leaves the active path.
        throw new Error("Branch draft parent must be an assistant message");
      }
      return null;
    }

    const run = assistant.trust_trail?.run;
    if (!run) return null;
    return run.run_selection;
  }, [branchDraft, messages]);

  const sendCapability = useMemo<ChatSendCapability>(() => {
    if (!conversationId) return { kind: "Available" };
    if (loading) return { kind: "HistoryLoading" };
    if (historyState === "Unavailable") return { kind: "HistoryUnavailable" };
    if (messages.length === 0) return { kind: "Available" };
    if (
      messages.some(
        (message) =>
          message.role === "assistant" && message.status === "pending",
      )
    ) {
      return { kind: "AssistantRunning" };
    }
    if (branchDraft) {
      return messages.some(
        (message) =>
          message.id === branchDraft.parentMessageId &&
          message.role === "assistant" &&
          message.status === "complete",
      )
        ? { kind: "Available" }
        : { kind: "ReplyTargetUnavailable" };
    }
    if (!replyParentMessageId) {
      return { kind: "ReplyTargetUnavailable" };
    }
    return { kind: "Available" };
  }, [branchDraft, conversationId, historyState, loading, messages, replyParentMessageId]);

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
