/**
 * Conversation — the unified conversation pane body.
 *
 * Reads its own id from the pane route (`usePaneParam("id")`, null on the
 * `new` route), drives the shared `useConversation` engine (which owns all
 * lifecycle/messages/branch state), and renders the shared `ChatSurface` view
 * (which owns scroll). This adapter only holds pane chrome: typed section
 * publication, toolbar toggles and action menu, the
 * Resource Inspector surfaces (context refs + forks + Dossier), and the open-resource /
 * reader-source navigation wiring.
 */

"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import DocentOverlay from "@/components/chat/DocentOverlay";
import { useDocentWalk } from "@/lib/conversations/useDocentWalk";
import Button from "@/components/ui/Button";
import ChatComposer from "@/components/chat/ChatComposer";
import ChatSurface from "@/components/chat/ChatSurface";
import PaneSearchResults from "@/components/resource-inspector/PaneSearchResults";
import type { DossierCitationActivate } from "@/components/dossier/DossierSurface";
import ConversationForksPanel from "@/components/chat/ConversationForksPanel";
import ConversationContextRefsSurface from "@/components/chat/ConversationContextRefsSurface";
import { useConversation } from "@/components/chat/useConversation";
import { useConversationPaneFind } from "@/components/chat/useConversationPaneFind";
import { useConversationContextRefs } from "@/lib/conversations/useConversationContextRefs";
import {
  readerTargetFromReaderSelection,
  type ReaderSourceTarget,
} from "@/lib/conversations/readerTarget";
import { dispatchReaderSourceActivation } from "@/lib/conversations/readerSourceActivation";
import {
  chatDraftKeyFor,
  type ChatDraftKey,
} from "@/lib/conversations/chatDraftKey";
import {
  ApiError,
  apiFetch,
  isApiError,
  isSameSystemApiDefect,
  type ApiPath,
} from "@/lib/api/client";
import { absent, present, type Presence } from "@/lib/api/presence";
import { useResource } from "@/lib/api/useResource";
import type { PendingTurnContext } from "@/lib/conversations/pendingTurnContext";
import {
  chatDestinationFromConversationId,
  parseReaderSelectionHash,
  readerHighlightChatIntent,
  type ReaderHighlightChatIntent,
} from "@/lib/conversations/readerHighlightChatIntent";
import {
  decodeReaderSelectionPreview,
  type ReaderSelectionOut,
  type ReaderSelectionPreview,
} from "@/lib/conversations/readerSelection";
import {
  activateResource,
  type ResourceActivation,
} from "@/lib/resources/activation";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import type { SSEContextRefAddedEvent } from "@/lib/api/sse/events";
import type { ContextRefOut } from "@/lib/resourceGraph/contextRefs";
import type { BranchDraft, ForkOption } from "@/lib/conversations/types";
import {
  usePaneHash,
  usePaneParam,
  usePaneRouter,
  requirePaneRuntime,
  usePaneRuntime,
  usePaneSearchParams,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import { workspaceTargetClickIntent } from "@/lib/panes/targetLinkActivation";
import type { WorkspaceTargetDisposition } from "@/lib/workspace/targetActivation";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import {
  useResourceInspector,
  type ResourceInspectorComposition,
} from "@/lib/dossiers/useResourceInspector";
import type { PaneFindOccurrencesPublication } from "@/lib/panes/paneSearch";
import styles from "@/app/(authenticated)/conversations/page.module.css";
import { routeResourceActionSubject } from "@/lib/resources/resourceActionTarget";

// ---------------------------------------------------------------------------
// Pending reader-selection hydration (route-owned launch intent)
// ---------------------------------------------------------------------------

function conversationErrorMessage(
  error: ApiError,
  operation: "LoadQuote" | "Delete" | "Load",
): FeedbackContent {
  switch (error.code) {
    case "E_NOT_FOUND":
    case "E_CONVERSATION_NOT_FOUND":
      return {
        tone: "Danger",
        requestId: error.requestId,
        title:
          operation === "Delete"
            ? "This chat is no longer available."
            : operation === "LoadQuote"
              ? "This quote is no longer available."
              : "This chat is no longer available.",
      };
    case "E_FORBIDDEN":
      return {
        tone: "Danger",
        title: "You don’t have access to this chat.",
        requestId: error.requestId,
      };
    case "E_NETWORK":
      if (operation === "Delete") {
        return {
          tone: "Danger",
          requestId: error.requestId,
          title: "It’s unclear whether the chat was deleted.",
          message: "Check your chats before trying again.",
        };
      }
      return {
        tone: "Danger",
        requestId: error.requestId,
        title:
          operation === "LoadQuote"
            ? "This quote couldn’t be loaded."
            : "This chat couldn’t be loaded.",
      };
    case "E_BAD_REQUEST":
    case "E_INVALID_REQUEST":
      return {
        tone: "Danger",
        requestId: error.requestId,
        title:
          operation === "Delete"
            ? "This chat couldn’t be deleted."
            : operation === "LoadQuote"
              ? "This quote couldn’t be loaded."
              : "This chat couldn’t be loaded.",
      };
    default:
      throw error;
  }
}

/** Map a hydration error onto the one pending-context projection.
 *  Authoritative forbidden/geometry/over-limit are `NonSendable`; a not-found
 *  for an accepted launch is projection drift (reported, retryable — NOT
 *  NonSendable); anything else is a retryable transport `LoadFailed`. */
function mapHydrationError(
  err: unknown,
  intent: ReaderHighlightChatIntent,
): PendingTurnContext {
  if (isApiError(err)) {
    switch (err.code) {
      case "E_READER_SELECTION_FORBIDDEN":
        return { kind: "NonSendable", intent, reason: "Forbidden" };
      case "E_READER_SELECTION_GEOMETRY_ONLY":
        return { kind: "NonSendable", intent, reason: "GeometryOnly" };
      case "E_READER_SELECTION_TOO_LARGE":
        return { kind: "NonSendable", intent, reason: "TooLarge" };
      case "E_READER_SELECTION_NOT_FOUND": {
        // justify-ignore-error: a not-found for a client-accepted launch is a
        // reported invariant defect (projection drift), never a NonSendable.
        console.error(
          "Reader-selection projection drift: highlight not found for an accepted launch",
          intent.selection,
        );
        const defect: FeedbackContent = {
          tone: "Danger",
          title: "This quote is temporarily unavailable.",
          message:
            "Its highlight hasn't finished syncing yet. Retry the quote to try again.",
          requestId: err.requestId,
        };
        return { kind: "LoadFailed", intent, error: defect };
      }
      case "E_INVALID_RESPONSE":
        throw err;
    }
  }
  if (!isApiError(err) || isSameSystemApiDefect(err)) throw err;
  return {
    kind: "LoadFailed",
    intent,
    error: conversationErrorMessage(err, "LoadQuote"),
  };
}

interface PendingReaderSelection {
  pendingContext: Presence<PendingTurnContext>;
  retryHydration: () => void;
  replaceWithPreview: (preview: ReaderSelectionPreview) => void;
}

/** `Conversation` is the sole launch-intent owner: it hydrates one canonical
 *  preview from the reader-selection API and yields exactly one
 *  `Presence<PendingTurnContext>` for `ChatComposer`. Absent when there is no
 *  valid intent hash. */
function usePendingReaderSelection(
  intent: ReaderHighlightChatIntent | null,
): PendingReaderSelection {
  const selectionResource = useResource<ReaderSelectionPreview>({
    cacheKey: intent
      ? `chat-reader-selection:${intent.selection.mediaId}:${intent.selection.highlightId}`
      : null,
    load: async (signal) => {
      if (intent === null) {
        throw new Error("Cannot load a reader selection without an intent");
      }
      const response = await apiFetch<{ data: unknown }>(
        `/api/chat-reader-selections/highlights/${intent.selection.highlightId}?${new URLSearchParams(
          { media_id: intent.selection.mediaId },
        )}` as ApiPath,
        { signal },
      );
      const preview = decodeReaderSelectionPreview(response.data);
      if (preview === null) {
        throw new ApiError(
          200,
          "E_INVALID_RESPONSE",
          "Reader-selection preview response is invalid",
        );
      }
      return preview;
    },
  });
  const [replacement, setReplacement] = useState<{
    intent: ReaderHighlightChatIntent;
    preview: ReaderSelectionPreview;
  } | null>(null);

  let pendingContext: Presence<PendingTurnContext>;
  if (intent === null) {
    pendingContext = absent();
  } else if (replacement?.intent === intent) {
    pendingContext = present({
      kind: "ReaderHighlight",
      preview: replacement.preview,
    });
  } else {
    switch (selectionResource.status) {
      case "idle":
      case "loading":
        pendingContext = present({ kind: "Loading", intent });
        break;
      case "ready":
        pendingContext = present({
          kind: "ReaderHighlight",
          preview: selectionResource.data,
        });
        break;
      case "error": {
        pendingContext = present(mapHydrationError(selectionResource.error, intent));
        break;
      }
      default: {
        const exhaustive: never = selectionResource;
        throw new Error(`Unexpected reader selection resource: ${exhaustive}`);
      }
    }
  }

  const retryHydration = useCallback(() => {
    if (selectionResource.status === "error") {
      selectionResource.retry();
    }
  }, [selectionResource]);
  const replaceWithPreview = useCallback(
    (preview: ReaderSelectionPreview) => {
      if (intent !== null) {
        setReplacement({ intent, preview });
      }
    },
    [intent],
  );

  return { pendingContext, retryHydration, replaceWithPreview };
}

export default function Conversation() {
  const conversationId = usePaneParam("id");
  const router = usePaneRouter();
  const paneRuntime = requirePaneRuntime(usePaneRuntime(), "Conversation");
  const { walk, startWalk, next, prev, leave } = useDocentWalk({
    activateTarget: paneRuntime.activateTarget,
  });
  const resourceRef = paneRuntime.resourceRef;
  const searchParams = usePaneSearchParams();
  const draft = searchParams.get("draft") ?? "";
  const initialTargetMessageId = searchParams.get("message");

  // Sole launch-intent owner: strictly parse the pane-local hash into a reader
  // selection key, combine it with the pane path (New / Existing) into one typed
  // intent, and hydrate one canonical pending preview from it.
  const paneHash = usePaneHash();
  const hashResult = useMemo(
    () => parseReaderSelectionHash(paneHash),
    [paneHash],
  );
  // A non-empty hash that is not a canonical intent is a route error — it must
  // be reported, never silently degraded to generic chat.
  const readerIntentHashInvalid = hashResult.kind === "invalid";
  const readerSelectionKey = hashResult.kind === "key" ? hashResult.key : null;
  const readerIntent = useMemo<ReaderHighlightChatIntent | null>(
    () =>
      readerSelectionKey
        ? readerHighlightChatIntent(
            chatDestinationFromConversationId(conversationId),
            readerSelectionKey,
          )
        : null,
    [conversationId, readerSelectionKey],
  );
  useEffect(() => {
    if (readerIntentHashInvalid) {
      console.error(
        "Conversation: malformed reader-Highlight intent hash",
        JSON.stringify(paneHash),
      );
    }
  }, [readerIntentHashInvalid, paneHash]);
  const {
    pendingContext,
    retryHydration,
    replaceWithPreview,
  } = usePendingReaderSelection(readerIntent);
  const [readerAnnouncement, setReaderAnnouncement] = useState("");

  const [branchFocusKey, setBranchFocusKey] = useState("");

  // The context-ref secondary surface is keyed off the engine's resolved id, but the engine
  // needs onContextRefAdded before that id exists — break the ordering cycle with
  // a stable callback that reads the live upsert/id through refs.
  const upsertContextRefRef = useRef<
    ((contextRef: ContextRefOut) => void) | null
  >(null);
  const activeConversationIdRef = useRef<string | null>(conversationId);

  const onContextRefAdded = useCallback(
    (data: SSEContextRefAddedEvent["data"]) => {
      const activeId = activeConversationIdRef.current;
      if (activeId !== null && data.conversation_id !== activeId) return;
      // The SSE payload is already a ContextRefOut (the materialized context edge).
      upsertContextRefRef.current?.(data);
    },
    [],
  );

  // Finalize the provisional /conversations/new location in this same pane once
  // its first send resolves an id. This is current-visit/history replacement,
  // not a user target activation: the engine retains its optimistic turn and
  // resumes active runs on the next load, so no `?run=` replay param is needed.
  const startedOnNewRouteRef = useRef(conversationId === null);
  const navigatedRef = useRef(false);
  const onConversationCreated = useCallback(
    (createdId: string) => {
      if (!startedOnNewRouteRef.current || navigatedRef.current) return;
      navigatedRef.current = true;
      router.replace(`/conversations/${createdId}`);
    },
    [router],
  );

  const convo = useConversation({
    conversationId,
    branching: true,
    onContextRefAdded,
    onConversationCreated,
  });
  activeConversationIdRef.current = convo.conversationId;
  const routeTargetKey = initialTargetMessageId
    ? `${conversationId ?? "new"}:${initialTargetMessageId}`
    : null;
  const currentRouteTargetKeyRef = useRef<string | null>(routeTargetKey);
  currentRouteTargetKeyRef.current = routeTargetKey;
  const revealedRouteTargetRef = useRef<string | null>(null);
  const failedRouteTargetRef = useRef<string | null>(null);
  const revealingRouteTargetsRef = useRef<Set<string>>(new Set());
  const retryingRouteTargetRef = useRef<string | null>(null);
  const [failedRouteTarget, setFailedRouteTarget] = useState<string | null>(
    null,
  );
  const [retryingRouteTarget, setRetryingRouteTarget] = useState<string | null>(
    null,
  );

  const revealRouteTarget = useCallback(
    (targetKey: string, messageId: string) => {
      if (
        !convo.branch ||
        revealedRouteTargetRef.current === targetKey ||
        failedRouteTargetRef.current === targetKey ||
        revealingRouteTargetsRef.current.has(targetKey) ||
        retryingRouteTargetRef.current === targetKey
      ) {
        return;
      }

      revealingRouteTargetsRef.current.add(targetKey);
      void convo.branch
        .revealMessage(messageId)
        .then((revealed) => {
          if (currentRouteTargetKeyRef.current !== targetKey) return;
          if (revealed) {
            // Do not mark a route target complete while its optimistic active-
            // path mutation is still pending. A false result has already
            // restored the prior path and must remain retryable.
            revealedRouteTargetRef.current = targetKey;
            if (failedRouteTargetRef.current === targetKey) {
              failedRouteTargetRef.current = null;
              setFailedRouteTarget(null);
            }
            return;
          }
          failedRouteTargetRef.current = targetKey;
          setFailedRouteTarget(targetKey);
        })
        .catch(() => {
          if (currentRouteTargetKeyRef.current !== targetKey) return;
          // revealMessage owns API feedback. This guard still makes an
          // unexpected rejection visible and retryable at the route boundary.
          failedRouteTargetRef.current = targetKey;
          setFailedRouteTarget(targetKey);
        })
        .finally(() => {
          revealingRouteTargetsRef.current.delete(targetKey);
        });
    },
    [convo.branch],
  );

  useEffect(() => {
    if (!initialTargetMessageId || !routeTargetKey) {
      revealedRouteTargetRef.current = null;
      failedRouteTargetRef.current = null;
      setFailedRouteTarget(null);
      return;
    }
    if (convo.loading) return;
    revealRouteTarget(routeTargetKey, initialTargetMessageId);
  }, [
    convo.loading,
    initialTargetMessageId,
    revealRouteTarget,
    routeTargetKey,
  ]);

  const retryRouteTarget = useCallback(async () => {
    const targetKey = routeTargetKey;
    const branch = convo.branch;
    if (!targetKey || !branch || retryingRouteTargetRef.current === targetKey) {
      return;
    }

    retryingRouteTargetRef.current = targetKey;
    setRetryingRouteTarget(targetKey);
    try {
      // Refresh the complete branch cache before retrying. This makes Retry
      // meaningful both for a transient active-path POST failure and for a
      // message that was absent from the previously loaded tree.
      const reloaded = await branch.reload();
      if (reloaded && currentRouteTargetKeyRef.current === targetKey) {
        failedRouteTargetRef.current = null;
        setFailedRouteTarget(null);
      }
    } finally {
      retryingRouteTargetRef.current = null;
      setRetryingRouteTarget(null);
    }
  }, [convo.branch, routeTargetKey]);

  const { contextRefs, removeContextRef, upsertContextRef } =
    useConversationContextRefs(convo.conversationId);
  upsertContextRefRef.current = upsertContextRef;

  const branch = convo.branch;
  const paneFind = useConversationPaneFind({
    conversationId: convo.conversationId,
    activeLeafMessageId: branch?.activeLeafMessageId ?? null,
    messages: convo.messages,
    scrollRef: convo.scrollRef,
  });

  // Exact identity while it is known; the route label once the load is terminal
  // without one, so a failed conversation never sits pending forever.
  useSetPaneLabel(convo.loading ? null : (convo.title ?? "Chat"));

  // --------------------------------------------------------------------------
  // Composer wiring
  // --------------------------------------------------------------------------

  const activeReplyParentMessageId = convo.replyParentMessageId;

  const branchDraft = branch?.branchDraft ?? null;
  // The structured draft key: a new-chat destination is keyed by the current
  // pane visit (never route text), an existing conversation by its active
  // leaf/reply parent, a branch reply by its anchor.
  const composerDraftKey: ChatDraftKey = branchDraft
    ? chatDraftKeyFor({ kind: "Branch", branchDraft })
    : convo.conversationId === null
      ? chatDraftKeyFor({
          kind: "NewConversation",
          visitId: paneRuntime.visitId,
        })
      : chatDraftKeyFor({
          kind: "Path",
          targetId:
            branch?.activeLeafMessageId ??
            activeReplyParentMessageId ??
            convo.conversationId,
        });

  const handleReplyToAssistant = useCallback(
    (nextDraft: BranchDraft) => {
      branch?.setBranchDraft(nextDraft);
      setBranchFocusKey(
        `${nextDraft.parentMessageId}:${nextDraft.anchor.kind}:${Date.now()}`,
      );
    },
    [branch],
  );

  // Stable across streaming renders (deps: branch) so `React.memo(MessageRow)`
  // keeps unchanged rows mounted while a sibling streams; also the forks panel's
  // switch handler.
  const handleSelectFork = useCallback(
    (fork: ForkOption) => {
      void branch?.switchToFork(fork);
    },
    [branch],
  );

  const jumpToMessage = useCallback(
    (messageId: string) => {
      convo.scrollRef.current?.scrollToMessage(messageId);
    },
    [convo.scrollRef],
  );

  // Deleting the conversation is a canonical resource action now: the pane
  // publishes its resourceTarget and the runtime dispatches DeleteConversation
  // (confirm + delete client + snapshot reconcile). No local delete flow.

  // --------------------------------------------------------------------------
  // Reader-source activation + open cited resource
  // --------------------------------------------------------------------------

  const activateReaderSource = useCallback(
    (
      activation: ResourceActivation,
      target: ReaderSourceTarget | null,
      disposition: WorkspaceTargetDisposition,
    ) => {
      if (target) dispatchReaderSourceActivation(target);
      if (resourceRef === activation.resourceRef) {
        return true;
      }
      return activateResource(activation, {
        labelHint: target?.label,
        activateTarget: paneRuntime.activateTarget,
        disposition,
      });
    },
    [paneRuntime, resourceRef],
  );

  const handleReaderSourceActivate = useCallback(
    (
      activation: ResourceActivation,
      target: ReaderSourceTarget | null,
      event?: React.MouseEvent,
    ) => {
      if (event?.defaultPrevented) return;
      const activated = activateReaderSource(
        activation,
        target,
        event
          ? workspaceTargetClickIntent(event).disposition
          : { kind: "Follow" },
      );
      if (activated) event?.preventDefault();
    },
    [activateReaderSource],
  );

  const handleDossierCitationActivate = useCallback<DossierCitationActivate>(
    (activation, target, disposition) => {
      activateReaderSource(activation, target, disposition);
    },
    [activateReaderSource],
  );

  const handleOpenResource = useCallback(
    (contextRef: ContextRefOut) => {
      activateResource(contextRef.activation, {
        labelHint: contextRef.label,
        activateTarget: paneRuntime.activateTarget,
        disposition: { kind: "Follow" },
      });
    },
    [paneRuntime],
  );

  // Pending + sent quote cards delegate snapshot activation here: the reader
  // positions from the IMMUTABLE snapshot locator, never the live Highlight.
  const handleActivateReaderSelection = useCallback(
    (selection: ReaderSelectionOut) => {
      handleReaderSourceActivate(
        selection.activation,
        readerTargetFromReaderSelection(selection),
      );
    },
    [handleReaderSourceActivate],
  );

  // --------------------------------------------------------------------------
  // Launch-intent lifecycle: strip / remove / consume / stale-replace
  // --------------------------------------------------------------------------

  // Strip the intent hash by replacing the pane route with the current path and
  // NO hash. The pane hash is excluded from pane identity, so this never remounts.
  const stripReaderIntentHash = useCallback(() => {
    router.replace(
      conversationId === null
        ? "/conversations/new"
        : `/conversations/${conversationId}`,
    );
  }, [conversationId, router]);

  const handleRemovePendingContext = useCallback(() => {
    stripReaderIntentHash();
    setReaderAnnouncement("Quote removed");
  }, [stripReaderIntentHash]);

  const handleIntentConsumed = useCallback(() => {
    // A successful New send navigates to /conversations/{id}, dropping the hash
    // on its own; only the existing-conversation case needs an explicit strip so
    // Back cannot rehydrate a consumed intent.
    if (conversationId !== null) stripReaderIntentHash();
  }, [conversationId, stripReaderIntentHash]);

  const handleReaderSelectionStale = useCallback(
    (preview: ReaderSelectionPreview) => {
      replaceWithPreview(preview);
    },
    [replaceWithPreview],
  );

  const handleRefreshConversation = useCallback(() => {
    void convo.branch?.reload();
  }, [convo.branch]);

  // New-chat launch focuses the composer once its quote finishes hydrating.
  const [quoteFocusSignal, setQuoteFocusSignal] = useState("");
  const lastFocusedQuoteRef = useRef<string | null>(null);
  useEffect(() => {
    if (conversationId !== null) return;
    const ctx = pendingContext.kind === "Present" ? pendingContext.value : null;
    if (ctx?.kind !== "ReaderHighlight") return;
    const highlightId = ctx.preview.key.highlightId;
    if (lastFocusedQuoteRef.current === highlightId) return;
    lastFocusedQuoteRef.current = highlightId;
    setQuoteFocusSignal(`quote:${highlightId}`);
  }, [conversationId, pendingContext]);

  // --------------------------------------------------------------------------
  // Pane chrome: action menu + Resource Inspector surfaces
  // --------------------------------------------------------------------------

  const contextBody = useMemo(
    () => (
      <div className={styles.chatSecondaryBody}>
        <ConversationContextRefsSurface
          contextRefs={contextRefs}
          removeContextRef={removeContextRef}
          onOpenResource={handleOpenResource}
        />
      </div>
    ),
    [contextRefs, handleOpenResource, removeContextRef],
  );
  const forksBody = useMemo(
    () => (
      <div className={styles.chatSecondaryBody}>
        {branch && convo.conversationId ? (
          <ConversationForksPanel
            conversationId={convo.conversationId}
            forkOptionsByParentId={branch.forkOptionsByParentId}
            branchGraph={branch.branchGraph}
            switchableLeafIds={branch.switchableLeafIds}
            activeLeafMessageId={branch.activeLeafMessageId}
            selectedPathMessageIds={branch.selectedPathMessageIds}
            onSelectFork={handleSelectFork}
            onSelectGraphLeaf={(leafId) => {
              void branch.switchToLeaf(leafId, null);
            }}
            onForksChanged={() => {
              void branch.reload();
            }}
          />
        ) : (
          <FeedbackNotice
            content={{ tone: "Neutral", title: "No forks in this conversation yet." }}
            announcement="None"
          />
        )}
      </div>
    ),
    [branch, convo.conversationId, handleSelectFork],
  );
  const searchCommandsRef = useRef<
    Pick<
      ResourceInspectorComposition,
      | "openSearchResults"
      | "closeSearchResults"
      | "previewSearchResult"
    >
  >(null);
  const dismissPaneFind = paneFind.onDismiss;
  const activatePaneFind = paneFind.onActivate;
  const dismissFind = useCallback(() => {
    dismissPaneFind();
    searchCommandsRef.current?.closeSearchResults();
  }, [dismissPaneFind]);
  const showFindResults = useCallback((trigger: HTMLButtonElement | null) => {
    searchCommandsRef.current?.openSearchResults(trigger);
  }, []);
  const activateFindResult = useCallback(
    (key: Parameters<PaneFindOccurrencesPublication["onActivate"]>[0]) => {
      void activatePaneFind(key).then((previewed) => {
        if (previewed) searchCommandsRef.current?.previewSearchResult();
      });
    },
    [activatePaneFind],
  );
  const findPublicationBase = useMemo(
    () => ({
      kind: "FindOccurrences" as const,
      query: paneFind.query,
      inputLabel: "Find in conversation",
      placeholder: "Find in conversation",
      onOpen: paneFind.onOpen,
      onQueryChange: paneFind.onQueryChange,
      onDismiss: dismissFind,
      result: paneFind.result,
      scope: paneFind.scope,
      matchCase: paneFind.matchCase,
      wholeWord: paneFind.wholeWord,
      onMatchCaseChange: paneFind.onMatchCaseChange,
      onWholeWordChange: paneFind.onWholeWordChange,
      onStep: paneFind.onStep,
      onActivate: activateFindResult,
      onShowResults: showFindResults,
      returnToReadingPosition: paneFind.returnToReadingPosition,
    }),
    [
      activateFindResult,
      dismissFind,
      paneFind.matchCase,
      paneFind.onMatchCaseChange,
      paneFind.onOpen,
      paneFind.onQueryChange,
      paneFind.onStep,
      paneFind.query,
      paneFind.result,
      paneFind.returnToReadingPosition,
      paneFind.scope,
      paneFind.wholeWord,
      paneFind.onWholeWordChange,
      showFindResults,
    ],
  );
  const searchResultsBody = useMemo(
    () => (
      <PaneSearchResults
        publication={{ ...findPublicationBase, resultsExpanded: true }}
      />
    ),
    [findPublicationBase],
  );
  const inspector = useResourceInspector({
    scheme: "conversation",
    handle: convo.conversationId,
    bodies: { linkedItems: contextBody, forks: forksBody },
    searchResults: searchResultsBody,
    onCitationActivate: handleDossierCitationActivate,
  });
  searchCommandsRef.current = inspector;
  const previousFindSourceRef = useRef(paneFind.sourceKey);
  useLayoutEffect(() => {
    if (previousFindSourceRef.current === paneFind.sourceKey) return;
    previousFindSourceRef.current = paneFind.sourceKey;
    inspector.closeSearchResults();
  }, [inspector, paneFind.sourceKey]);
  const findPublication = useMemo<PaneFindOccurrencesPublication>(
    () => ({
      ...findPublicationBase,
      resultsExpanded: inspector.searchResultsExpanded,
    }),
    [findPublicationBase, inspector.searchResultsExpanded],
  );
  usePanePrimaryChrome({
    search:
      convo.conversationId &&
      !convo.loading &&
      !(conversationId !== null && convo.messages.length === 0 && convo.error)
        ? findPublication
        : undefined,
    actions: inspector.companionAction ? [inspector.companionAction] : [],
    resourceTarget:
      convo.conversationId &&
      !convo.loading &&
      !(conversationId !== null && convo.messages.length === 0 && convo.error)
        ? routeResourceActionSubject({
            scheme: "conversation",
            id: convo.conversationId,
            href: `/conversations/${convo.conversationId}`,
          })
        : undefined,
  });

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  const routeTargetFailed =
    routeTargetKey !== null && failedRouteTarget === routeTargetKey;
  const routeTargetFailureNotice = routeTargetFailed ? (
    <FeedbackNotice
      content={
        convo.error ?? {
          tone: "Danger",
          title: "The requested message couldn’t be opened.",
        }
      }
      announcement="Assertive"
    >
      <Button
        variant="secondary"
        size="sm"
        loading={retryingRouteTarget === routeTargetKey}
        onClick={() => void retryRouteTarget()}
      >
        Retry
      </Button>
    </FeedbackNotice>
  ) : null;
  const error = routeTargetFailed ? null : (convo.error ?? null);

  // Existing-route error gating: a not-found/error state without history cannot
  // safely render a continuation composer. Loading stays on the normal chat
  // surface so the composer can show its disabled reason.
  if (conversationId !== null && convo.messages.length === 0 && convo.error) {
    return (
      routeTargetFailureNotice ?? (
        <FeedbackNotice content={convo.error} announcement="Assertive" />
      )
    );
  }

  return (
    <div className={styles.chatSplitLayout}>
      <div className={styles.chatPrimaryColumn}>
        <div className={styles.paneContentChat}>
          {/* Polite status for attach / replace / remove / unavailable that
              never moves focus. */}
          <p className="sr-only" role="status" aria-live="polite">
            {readerAnnouncement}
          </p>
          {routeTargetFailureNotice}
          {readerIntentHashInvalid ? (
            <FeedbackNotice
              content={{
                tone: "Danger",
                title: "This quote link is malformed",
                message:
                  "The passage couldn't be attached. Reopen it from the reader.",
              }}
              announcement="Assertive"
            />
          ) : null}
          {error ? <FeedbackNotice content={error} announcement="Assertive" /> : null}
          <ChatSurface
            ref={convo.scrollRef}
            messages={convo.messages}
            historyLoading={convo.loading}
            initialTargetMessageId={initialTargetMessageId}
            emptyState={
              convo.loading ? (
                <FeedbackNotice
                  content={{ tone: "Info", title: "Loading conversation..." }}
                  announcement="None"
                />
              ) : null
            }
            docentOverlay={
              <DocentOverlay
                walk={walk}
                onNext={next}
                onPrev={prev}
                onLeave={leave}
              />
            }
            onStartWalk={startWalk}
            onReaderSourceActivate={handleReaderSourceActivate}
            forkOptionsByParentId={branch?.forkOptionsByParentId}
            switchableLeafIds={branch?.switchableLeafIds}
            onSelectFork={branch ? handleSelectFork : undefined}
            onReplyToAssistant={branch ? handleReplyToAssistant : undefined}
            onRerunAssistantResponse={convo.rerunAssistantResponse}
            rerunningAssistantMessageIds={
              convo.rerunningAssistantMessageIds.ids
            }
            onRegenerateAssistantResponse={convo.regenerateAssistantResponse}
            regeneratingAssistantMessageIds={
              convo.regeneratingAssistantMessageIds.ids
            }
            connectionLostAssistantIds={convo.connectionLostAssistantIds}
            onReconnectAssistant={convo.reconnectAssistantResponse}
            composer={
              <ChatComposer
                conversationId={convo.conversationId}
                draftKey={composerDraftKey}
                branchDraft={branchDraft}
                parentMessageId={activeReplyParentMessageId}
                inheritedProfileSelection={convo.inheritedProfileSelection}
                sendCapability={convo.sendCapability}
                activeRunId={convo.activeRunId}
                onCancelRun={convo.cancelActiveRun}
                onChatRunCreated={convo.onChatRunCreated}
                onClearBranchDraft={
                  branch ? () => branch.setBranchDraft(null) : undefined
                }
                onJumpToBranchParent={jumpToMessage}
                pendingContext={pendingContext}
                onRemovePendingContext={handleRemovePendingContext}
                onRetryHydration={retryHydration}
                onReaderSelectionStale={handleReaderSelectionStale}
                onIntentConsumed={handleIntentConsumed}
                onConversationRefresh={handleRefreshConversation}
                onActivateSource={handleActivateReaderSelection}
                initialContent={draft}
                autoFocus={Boolean(branchDraft) || quoteFocusSignal !== ""}
                focusKey={branchFocusKey || quoteFocusSignal}
              />
            }
          />
        </div>
      </div>
    </div>
  );
}
