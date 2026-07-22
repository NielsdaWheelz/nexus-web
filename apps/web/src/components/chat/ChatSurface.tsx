"use client";

import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import type { CitationOut } from "@/lib/conversations/citationOut";
import { ArrowDown } from "lucide-react";
import Button from "@/components/ui/Button";
import type {
  BranchDraft,
  ConversationMessage,
  ForkOption,
} from "@/lib/conversations/types";
import type { ReaderSourceTarget } from "@/lib/conversations/readerTarget";
import type { ResourceActivation } from "@/lib/resources/activation";
import { MessageRow } from "./MessageRow";
import { useChatScroll, type ChatScrollHandle } from "./useChatScroll";
import styles from "./ChatSurface.module.css";

// Stable empty-forks reference: rows without forks must receive the same array
// identity every render so `React.memo(MessageRow)` can skip them while a
// sibling row streams.
const NO_FORKS: ForkOption[] = [];

interface ChatSurfaceProps {
  messages: ConversationMessage[];
  composer: ReactNode;
  /** Docent HUD: rendered before {composer} inside the composerSlot. */
  docentOverlay?: ReactNode;
  /** Forwarded to each MessageRow for the Walk-the-sources entry verb. */
  onStartWalk?: (citations: CitationOut[], text: string) => void;
  historyLoading?: boolean;
  initialTargetMessageId?: string | null;
  olderCursor?: string | null;
  onLoadOlder?: () => void;
  emptyState?: ReactNode;
  forkOptionsByParentId?: Record<string, ForkOption[]>;
  switchableLeafIds?: Set<string>;
  onSelectFork?: (fork: ForkOption) => void;
  onReplyToAssistant?: (draft: BranchDraft) => void;
  onRerunAssistantResponse?: (assistantMessageId: string) => void;
  rerunningAssistantMessageIds?: Set<string>;
  connectionLostAssistantIds?: Set<string>;
  onReconnectAssistant?: (assistantMessageId: string) => void;
  onReaderSourceActivate?: (
    activation: ResourceActivation,
    target: ReaderSourceTarget | null,
    event?: React.MouseEvent,
  ) => void;
}

const ChatSurface = forwardRef<ChatScrollHandle, ChatSurfaceProps>(
  function ChatSurface(
    {
      messages,
      composer,
      docentOverlay,
      onStartWalk,
      historyLoading = false,
      initialTargetMessageId = null,
      olderCursor,
      onLoadOlder,
      emptyState,
      forkOptionsByParentId = {},
      switchableLeafIds,
      onSelectFork,
      onReplyToAssistant,
      onRerunAssistantResponse,
      rerunningAssistantMessageIds,
      connectionLostAssistantIds,
      onReconnectAssistant,
      onReaderSourceActivate,
    },
    ref,
  ) {
    const scrollportRef = useRef<HTMLDivElement | null>(null);
    const transcriptRef = useRef<HTMLDivElement | null>(null);
    const {
      spacerHeight,
      isLatestBelowFold,
      scrollToLatest,
      onComposerWheel,
      onScroll,
      beginUserScroll,
      captureAnchor,
      scrollToMessage,
    } = useChatScroll(scrollportRef, transcriptRef, messages, historyLoading);
    const requestedTargetMessageIdRef = useRef<string | null>(null);
    const activatedTargetMessageIdRef = useRef<string | null>(null);

    useLayoutEffect(() => {
      if (requestedTargetMessageIdRef.current !== initialTargetMessageId) {
        requestedTargetMessageIdRef.current = initialTargetMessageId;
        activatedTargetMessageIdRef.current = null;
      }
      if (initialTargetMessageId === null) {
        return;
      }
      const targetExists = messages.some(
        (message) => message.id === initialTargetMessageId,
      );
      if (!targetExists) {
        // An active-path mutation is optimistic. If it rolls back, forget the
        // prior activation so a later successful retry can scroll again.
        activatedTargetMessageIdRef.current = null;
        return;
      }
      if (
        historyLoading ||
        activatedTargetMessageIdRef.current === initialTargetMessageId
      ) {
        return;
      }
      scrollToMessage(initialTargetMessageId);
      activatedTargetMessageIdRef.current = initialTargetMessageId;
    }, [historyLoading, initialTargetMessageId, messages, scrollToMessage]);

    useImperativeHandle(ref, () => ({ captureAnchor, scrollToMessage }), [
      captureAnchor,
      scrollToMessage,
    ]);

    return (
      <div className={styles.surface}>
        <div
          ref={scrollportRef}
          className={styles.scrollport}
          role="region"
          tabIndex={0}
          aria-label="Chat conversation"
          onScroll={onScroll}
          onWheel={beginUserScroll}
          onTouchMove={beginUserScroll}
          onKeyDown={beginUserScroll}
        >
          <div
            ref={transcriptRef}
            className={styles.transcript}
            role="log"
            aria-label="Chat messages"
          >
            {olderCursor && onLoadOlder ? (
              <Button
                variant="ghost"
                size="sm"
                aria-label="Load older messages"
                onClick={onLoadOlder}
              >
                Load older messages
              </Button>
            ) : null}

            {messages.length === 0 && emptyState ? (
              <div className={styles.emptyState}>{emptyState}</div>
            ) : null}

            {messages.map((msg) => (
              <MessageRow
                key={msg.id}
                message={msg}
                forkOptions={forkOptionsByParentId[msg.id] ?? NO_FORKS}
                switchableLeafIds={switchableLeafIds}
                onSelectFork={onSelectFork}
                onReplyToAssistant={onReplyToAssistant}
                onRerunAssistantResponse={onRerunAssistantResponse}
                rerunningAssistantMessageIds={rerunningAssistantMessageIds}
                connectionLostAssistantIds={connectionLostAssistantIds}
                onReconnectAssistant={onReconnectAssistant}
                onReaderSourceActivate={onReaderSourceActivate}
                onStartWalk={onStartWalk}
              />
            ))}

            <div
              className={styles.spacer}
              aria-hidden="true"
              style={{ height: spacerHeight }}
            />
          </div>

          {isLatestBelowFold ? (
            <div className={styles.latestDock}>
              <Button
                variant="pill"
                size="sm"
                data-testid="chat-scroll-latest"
                leadingIcon={<ArrowDown size={14} aria-hidden="true" />}
                onClick={scrollToLatest}
              >
                Latest
              </Button>
            </div>
          ) : null}
        </div>

        <div
          className={styles.composerSlot}
          data-testid="chat-composer-dock"
          onWheel={onComposerWheel}
        >
          {docentOverlay}
          {composer}
        </div>
      </div>
    );
  },
);

export default ChatSurface;
