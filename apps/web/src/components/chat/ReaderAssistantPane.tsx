"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowLeft, ExternalLink, X } from "lucide-react";
import ChatComposer from "@/components/ChatComposer";
import ChatSurface from "@/components/chat/ChatSurface";
import type { ReaderSourceTarget } from "@/components/chat/MessageRow";
import { useChatRunTail } from "@/components/chat/useChatRunTail";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Select from "@/components/ui/Select";
import { apiFetch, isApiError } from "@/lib/api/client";
import { type ContextItem } from "@/lib/api/sse";
import {
  formatContextMeta,
  formatConversationScopeLabel,
  getContextChipLabel,
  getContextExact,
  getContextMediaKind,
  getContextMediaTitle,
  truncateText,
} from "@/lib/conversations/display";
import type {
  ChatRunResponse,
  ConversationMessage,
  ConversationMessagesResponse,
  ConversationScope,
  ConversationSummary,
} from "@/lib/conversations/types";
import styles from "./ReaderAssistantPane.module.css";

const MESSAGE_PAGE_SIZE = 30;
const SCROLL_BOTTOM_THRESHOLD_PX = 48;
const READER_ASSISTANT_TELEMETRY_EVENT = "nexus:reader-assistant-telemetry";

const DEFAULT_CONVERSATION_SCOPE: ConversationScope = { type: "general" };

export interface ReaderAssistantScopeOption {
  id: string;
  label: string;
  scope: ConversationScope;
  disabled?: boolean;
}

export default function ReaderAssistantPane({
  contexts,
  conversationId,
  conversationScope = DEFAULT_CONVERSATION_SCOPE,
  targetLabel,
  scopeOptions = [],
  onScopeChange,
  onBack,
  onClose,
  onConversationAvailable,
  onOpenFullChat,
  onReaderSourceActivate,
  autoFocusComposer = true,
  resolveScopedConversation = true,
  surface = "embedded",
  className,
}: {
  contexts: ContextItem[];
  conversationId: string | null;
  conversationScope?: ConversationScope;
  targetLabel?: string;
  scopeOptions?: ReaderAssistantScopeOption[];
  onScopeChange?: (scope: ConversationScope) => void;
  onBack?: () => void;
  onClose?: () => void;
  onConversationAvailable?: (conversationId: string, runId?: string) => void;
  onOpenFullChat: (conversationId: string) => void;
  onReaderSourceActivate?: (target: ReaderSourceTarget) => void;
  autoFocusComposer?: boolean;
  resolveScopedConversation?: boolean;
  surface?: "desktop" | "mobile" | "embedded";
  className?: string;
}) {
  const scrollportRef = useRef<HTMLDivElement>(null);
  const shouldScrollRef = useRef(true);
  const pendingScrollRestoreRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const activeConversationIdRef = useRef(conversationId);
  const locallyCreatedConversationIdsRef = useRef<Set<string>>(new Set());
  const notifiedConversationKeysRef = useRef<Set<string>>(new Set());
  const resolveRequestRef = useRef(0);
  const sentInPaneRef = useRef(false);
  const openedAtMsRef = useRef(nowMs());
  const lastSendStartedAtMsRef = useRef<number | null>(null);
  const runSendStartedAtMsRef = useRef<Map<string, number>>(new Map());
  const firstSendTelemetrySentRef = useRef(false);

  const [activeConversationId, setActiveConversationId] = useState(conversationId);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingMessages, setLoadingMessages] = useState(Boolean(conversationId));
  const [loadError, setLoadError] = useState<FeedbackContent | null>(null);
  const [resolveError, setResolveError] = useState<FeedbackContent | null>(null);
  const [resolvingConversation, setResolvingConversation] = useState(false);
  const [pendingContexts, setPendingContexts] = useState<ContextItem[]>(() =>
    dedupeContexts(contexts),
  );
  const openTelemetryBaseRef = useRef<Record<string, unknown> | null>(null);
  const activeReplyParentMessageId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === "assistant" && message.status === "complete") {
        return message.id;
      }
    }
    return null;
  }, [messages]);
  if (openTelemetryBaseRef.current === null) {
    openTelemetryBaseRef.current = {
      surface,
      context_kinds: contextKinds(pendingContexts),
      media_kinds: mediaKinds(pendingContexts),
      scope_type: conversationScope.type,
    };
  }

  const incomingContextKey = useMemo(
    () => contexts.map(contextDedupeKey).join("\n"),
    [contexts],
  );
  const scopeType = conversationScope.type;
  const scopeMediaId = scopeType === "media" ? conversationScope.media_id : null;
  const scopeLibraryId = scopeType === "library" ? conversationScope.library_id : null;
  const conversationScopeKey = useMemo(
    () => scopeDedupeKey(conversationScope),
    [conversationScope],
  );
  const resolveScopeBody = useMemo(() => {
    if (scopeType === "media" && scopeMediaId) {
      return { type: "media" as const, media_id: scopeMediaId };
    }
    if (scopeType === "library" && scopeLibraryId) {
      return { type: "library" as const, library_id: scopeLibraryId };
    }
    return { type: "general" as const };
  }, [scopeLibraryId, scopeMediaId, scopeType]);
  const composerFocusKey = `${incomingContextKey}:${activeConversationId ?? "new"}`;
  const telemetryBase = useCallback(
    () => ({
      surface,
      context_kinds: contextKinds(pendingContexts),
      media_kinds: mediaKinds(pendingContexts),
      scope_type: conversationScope.type,
    }),
    [conversationScope.type, pendingContexts, surface],
  );
  const telemetryBaseRef = useRef(telemetryBase());

  useEffect(() => {
    telemetryBaseRef.current = telemetryBase();
  }, [telemetryBase]);

  useEffect(() => {
    const startedAtMs = openedAtMsRef.current;
    const frameId = window.requestAnimationFrame(() => {
      emitReaderAssistantTelemetry({
        type: "open_latency",
        latency_ms: Math.max(0, Math.round(nowMs() - startedAtMs)),
        ...openTelemetryBaseRef.current,
      });
    });
    return () => window.cancelAnimationFrame(frameId);
  }, []);

  const notifyConversationAvailable = useCallback(
    (nextConversationId: string, runId?: string) => {
      const key = `${nextConversationId}:${runId ?? ""}`;
      if (notifiedConversationKeysRef.current.has(key)) {
        return;
      }
      notifiedConversationKeysRef.current.add(key);
      onConversationAvailable?.(nextConversationId, runId);
    },
    [onConversationAvailable],
  );

  const { activeRunId, abortAll, tailChatRun } = useChatRunTail({
    setMessages,
    shouldScrollRef,
    onFirstDelta: (runId) => {
      const sentAtMs = runSendStartedAtMsRef.current.get(runId);
      if (sentAtMs === undefined) {
        return;
      }
      emitReaderAssistantTelemetry({
        type: "first_token_latency",
        latency_ms: Math.max(0, Math.round(nowMs() - sentAtMs)),
        ...telemetryBase(),
      });
    },
    onRunDone: (_runId, status, errorCode) => {
      if (status !== "error" && !errorCode) {
        return;
      }
      emitReaderAssistantTelemetry({
        type: "error",
        status,
        error_code: errorCode,
        ...telemetryBase(),
      });
    },
    onConversationAvailable: (nextConversationId, runId) => {
      locallyCreatedConversationIdsRef.current.add(nextConversationId);
      activeConversationIdRef.current = nextConversationId;
      setActiveConversationId(nextConversationId);
      notifyConversationAvailable(nextConversationId, runId);
    },
  });

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    setPendingContexts((prev) => mergeContexts(prev, contexts));
  }, [contexts, incomingContextKey]);

  useEffect(() => {
    const nextConversationId = conversationId ?? null;
    if (nextConversationId === activeConversationIdRef.current) {
      return;
    }
    abortAll();
    activeConversationIdRef.current = nextConversationId;
    setActiveConversationId(nextConversationId);
    setMessages([]);
    setOlderCursor(null);
    setLoadError(null);
    setLoadingMessages(Boolean(nextConversationId));
    sentInPaneRef.current = false;
  }, [abortAll, conversationId]);

  useEffect(() => {
    if (conversationId || sentInPaneRef.current) {
      return;
    }
    abortAll();
    activeConversationIdRef.current = null;
    setActiveConversationId(null);
    setMessages([]);
    setOlderCursor(null);
    setLoadError(null);
    setLoadingMessages(false);
    setResolveError(null);
  }, [abortAll, conversationId, conversationScopeKey]);

  useEffect(() => {
    if (
      !resolveScopedConversation ||
      conversationId ||
      sentInPaneRef.current ||
      resolveScopeBody.type === "general"
    ) {
      setResolvingConversation(false);
      return;
    }

    const requestId = ++resolveRequestRef.current;
    let cancelled = false;
    setResolvingConversation(true);
    setResolveError(null);

    apiFetch<{ data: ConversationSummary }>("/api/conversations/resolve", {
      method: "POST",
      body: JSON.stringify(resolveScopeBody),
    })
      .then((response) => {
        if (
          cancelled ||
          requestId !== resolveRequestRef.current ||
          sentInPaneRef.current
        ) {
          return;
        }
        activeConversationIdRef.current = response.data.id;
        setActiveConversationId(response.data.id);
        notifyConversationAvailable(response.data.id);
      })
      .catch((err) => {
        if (cancelled || requestId !== resolveRequestRef.current) {
          return;
        }
        emitReaderAssistantTelemetry({
          type: "error",
          status: "resolve_failed",
          error_code: isApiError(err) ? err.code : null,
          ...telemetryBaseRef.current,
        });
        setResolveError(
          toFeedback(err, { fallback: "Failed to load the scoped chat" }),
        );
      })
      .finally(() => {
        if (!cancelled && requestId === resolveRequestRef.current) {
          setResolvingConversation(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    conversationId,
    conversationScopeKey,
    notifyConversationAvailable,
    resolveScopeBody,
    resolveScopedConversation,
  ]);

  useEffect(() => {
    if (
      !activeConversationId ||
      locallyCreatedConversationIdsRef.current.has(activeConversationId)
    ) {
      setLoadingMessages(false);
      return;
    }

    let cancelled = false;
    setLoadingMessages(true);
    setLoadError(null);
    apiFetch<ConversationMessagesResponse>(
      `/api/conversations/${activeConversationId}/messages?limit=${MESSAGE_PAGE_SIZE}`,
    )
      .then((response) => {
        if (cancelled) return;
        setMessages(response.data);
        setOlderCursor(response.page.next_cursor);
      })
      .catch((err) => {
        if (cancelled) return;
        emitReaderAssistantTelemetry({
          type: "error",
          status: "history_failed",
          error_code: isApiError(err) ? err.code : null,
          ...telemetryBaseRef.current,
        });
        setLoadError(toFeedback(err, { fallback: "Failed to load chat history" }));
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingMessages(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeConversationId]);

  useLayoutEffect(() => {
    if (!scrollportRef.current) return;
    if (pendingScrollRestoreRef.current) {
      const restore = pendingScrollRestoreRef.current;
      pendingScrollRestoreRef.current = null;
      scrollportRef.current.scrollTop =
        scrollportRef.current.scrollHeight - restore.scrollHeight + restore.scrollTop;
      shouldScrollRef.current = false;
      return;
    }
    if (shouldScrollRef.current) {
      scrollportRef.current.scrollTop = scrollportRef.current.scrollHeight;
    }
  }, [messages]);

  const handleChatScroll = useCallback(() => {
    const scrollport = scrollportRef.current;
    if (!scrollport) return;
    shouldScrollRef.current =
      scrollport.scrollHeight - scrollport.scrollTop - scrollport.clientHeight <=
      SCROLL_BOTTOM_THRESHOLD_PX;
  }, []);

  const loadOlder = useCallback(async () => {
    if (!activeConversationId || !olderCursor) return;
    if (scrollportRef.current) {
      pendingScrollRestoreRef.current = {
        scrollHeight: scrollportRef.current.scrollHeight,
        scrollTop: scrollportRef.current.scrollTop,
      };
    }
    const params = new URLSearchParams({
      limit: String(MESSAGE_PAGE_SIZE),
      cursor: olderCursor,
    });
    try {
      const response = await apiFetch<ConversationMessagesResponse>(
        `/api/conversations/${activeConversationId}/messages?${params}`,
      );
      setMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m.id));
        const next = response.data.filter((m) => !existingIds.has(m.id));
        return [...next, ...prev];
      });
      setOlderCursor(response.page.next_cursor);
      shouldScrollRef.current = false;
    } catch (err) {
      pendingScrollRestoreRef.current = null;
      throw err;
    }
  }, [activeConversationId, olderCursor]);

  const handleMessageSent = useCallback(() => {
    setPendingContexts([]);
  }, []);

  const handleSendStarted = useCallback(() => {
    const sentAtMs = nowMs();
    lastSendStartedAtMsRef.current = sentAtMs;
    if (firstSendTelemetrySentRef.current) {
      return;
    }
    firstSendTelemetrySentRef.current = true;
    emitReaderAssistantTelemetry({
      type: "first_send_latency",
      latency_ms: Math.max(0, Math.round(sentAtMs - openedAtMsRef.current)),
      ...telemetryBase(),
    });
  }, [telemetryBase]);

  const handleChatRunCreated = useCallback(
    (runData: ChatRunResponse["data"]) => {
      runSendStartedAtMsRef.current.set(
        runData.run.id,
        lastSendStartedAtMsRef.current ?? nowMs(),
      );
      sentInPaneRef.current = true;
      shouldScrollRef.current = true;
      locallyCreatedConversationIdsRef.current.add(runData.conversation.id);
      activeConversationIdRef.current = runData.conversation.id;
      setActiveConversationId(runData.conversation.id);
      notifyConversationAvailable(runData.conversation.id, runData.run.id);
      abortAll();
      void tailChatRun(runData);
    },
    [abortAll, notifyConversationAvailable, tailChatRun],
  );

  const fullChatTarget =
    activeConversationId && activeRunId
      ? `${activeConversationId}?run=${encodeURIComponent(activeRunId)}`
      : activeConversationId;
  const activeScopeOptionId =
    scopeOptions.find((option) => scopeDedupeKey(option.scope) === conversationScopeKey)
      ?.id ?? "";

  return (
    <section
      className={`${styles.pane}${className ? ` ${className}` : ""}`}
      role="region"
      aria-label="Reader assistant"
    >
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <h2 className={styles.title}>Ask</h2>
          {scopeOptions.length > 1 && onScopeChange ? (
            <label className={styles.scopePicker}>
              <span className={styles.scopePickerLabel}>Scope</span>
              <Select
                size="sm"
                value={activeScopeOptionId}
                onChange={(event) => {
                  const option = scopeOptions.find(
                    (item) => item.id === event.target.value,
                  );
                  if (option) {
                    onScopeChange(option.scope);
                  }
                }}
              >
                {scopeOptions.map((option) => (
                  <option
                    key={option.id}
                    value={option.id}
                    disabled={option.disabled}
                  >
                    {option.label}
                  </option>
                ))}
              </Select>
            </label>
          ) : (
            <p className={styles.target}>
              {targetLabel ?? formatConversationScopeLabel(conversationScope)}
            </p>
          )}
        </div>
        <div className={styles.headerActions}>
          {onBack ? (
            <Button
              variant="secondary"
              size="sm"
              iconOnly
              onClick={onBack}
              aria-label="Back to highlights"
            >
              <ArrowLeft size={16} aria-hidden="true" />
            </Button>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={<ExternalLink size={14} aria-hidden="true" />}
            disabled={!fullChatTarget}
            onClick={() => {
              if (fullChatTarget) {
                emitReaderAssistantTelemetry({
                  type: "promotion",
                  ...telemetryBase(),
                });
                onOpenFullChat(fullChatTarget);
              }
            }}
          >
            Open full chat
          </Button>
          {onClose ? (
            <Button
              variant="secondary"
              size="sm"
              iconOnly
              onClick={onClose}
              aria-label="Close"
            >
              <X size={16} aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </header>

      {pendingContexts.length > 0 ? (
        <div className={styles.contextStack} aria-label="Attached context">
          {pendingContexts.map((context, index) => (
            <PendingContextCard
              key={`${contextDedupeKey(context)}-${index}`}
              context={context}
              onRemove={() =>
                setPendingContexts((prev) => prev.filter((_, i) => i !== index))
              }
            />
          ))}
        </div>
      ) : null}

      {resolveError ? (
        <div className={styles.status}>
          <FeedbackNotice feedback={resolveError} />
        </div>
      ) : null}

      <ChatSurface
        messages={messages}
        scope={conversationScope}
        scrollportRef={scrollportRef}
        onScroll={handleChatScroll}
        onReaderSourceActivate={onReaderSourceActivate}
        olderCursor={olderCursor}
        onLoadOlder={loadOlder}
        emptyState={
          <ReaderAssistantEmptyState
            loadingMessages={loadingMessages}
            loadError={loadError}
            resolvingConversation={resolvingConversation}
            hasPendingContexts={pendingContexts.length > 0}
          />
        }
        composer={
          <ChatComposer
            conversationId={activeConversationId}
            conversationScope={conversationScope}
            attachedContexts={pendingContexts}
            parentMessageId={activeReplyParentMessageId}
            onRemoveContext={(index) =>
              setPendingContexts((prev) => prev.filter((_, i) => i !== index))
            }
            onChatRunCreated={handleChatRunCreated}
            onMessageSent={handleMessageSent}
            onSendStarted={handleSendStarted}
            autoFocus={autoFocusComposer}
            focusKey={composerFocusKey}
          />
        }
      />
    </section>
  );
}

function PendingContextCard({
  context,
  onRemove,
}: {
  context: ContextItem;
  onRemove: () => void;
}) {
  const quoteText = getContextExact(context);
  const mediaTitle = getContextMediaTitle(context);
  const meta = formatContextMeta(mediaTitle, getContextMediaKind(context));

  return (
    <article className={styles.contextCard} data-color={context.color ?? undefined}>
      <div className={styles.contextTextBlock}>
        <p className={styles.quoteText}>
          {quoteText
            ? truncateText(quoteText, 220)
            : getContextChipLabel(context, 120)}
        </p>
        {meta ? <p className={styles.quoteMeta}>{meta}</p> : null}
      </div>
      <Button
        variant="secondary"
        size="sm"
        iconOnly
        onClick={onRemove}
        aria-label="Remove quote context"
      >
        <X size={14} aria-hidden="true" />
      </Button>
    </article>
  );
}

function ReaderAssistantEmptyState({
  loadingMessages,
  loadError,
  resolvingConversation,
  hasPendingContexts,
}: {
  loadingMessages: boolean;
  loadError: FeedbackContent | null;
  resolvingConversation: boolean;
  hasPendingContexts: boolean;
}) {
  if (loadError) {
    return <FeedbackNotice feedback={loadError} />;
  }
  if (loadingMessages) {
    return <FeedbackNotice severity="info" title="Loading chat history..." />;
  }
  if (resolvingConversation) {
    return <FeedbackNotice severity="info" title="Loading scoped chat..." />;
  }

  return (
    <>
      <p className={styles.emptyTitle}>
        {hasPendingContexts ? "Ask about this quote" : "Ask about this source"}
      </p>
      <p className={styles.emptyCopy}>
        {hasPendingContexts
          ? "The attached context will be sent with your message."
          : "Start a grounded conversation from the current reader scope."}
      </p>
    </>
  );
}

function dedupeContexts(contexts: ContextItem[]): ContextItem[] {
  return mergeContexts([], contexts);
}

function mergeContexts(prev: ContextItem[], incoming: ContextItem[]): ContextItem[] {
  const seen = new Set(prev.map(contextDedupeKey));
  const next = [...prev];
  for (const context of incoming) {
    const key = contextDedupeKey(context);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    next.push(context);
  }
  return next;
}

function contextDedupeKey(context: ContextItem): string {
  if (context.kind === "reader_selection") {
    return `reader_selection:${context.client_context_id}`;
  }
  const evidence = context.evidence_span_ids?.join(",") ?? "";
  return `object_ref:${context.type}:${context.id}:${evidence}`;
}

function scopeDedupeKey(scope: ConversationScope): string {
  if (scope.type === "general") {
    return "general";
  }
  if (scope.type === "media") {
    return `media:${scope.media_id}`;
  }
  if (scope.type === "library") {
    return `library:${scope.library_id}`;
  }
  const exhaustive: never = scope;
  return exhaustive;
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function contextKinds(contexts: ContextItem[]): string[] {
  const kinds: string[] = [];
  for (const context of contexts) {
    if (!kinds.includes(context.kind)) {
      kinds.push(context.kind);
    }
  }
  return kinds;
}

function mediaKinds(contexts: ContextItem[]): string[] {
  const kinds: string[] = [];
  for (const context of contexts) {
    const kind =
      context.kind === "reader_selection" ? context.media_kind : context.mediaKind;
    if (kind && !kinds.includes(kind)) {
      kinds.push(kind);
    }
  }
  return kinds;
}

function emitReaderAssistantTelemetry(detail: Record<string, unknown>): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent(READER_ASSISTANT_TELEMETRY_EVENT, { detail }),
  );
}
