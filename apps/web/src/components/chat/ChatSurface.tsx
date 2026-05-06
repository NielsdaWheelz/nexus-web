"use client";

import type { RefObject, ReactNode, UIEventHandler } from "react";
import Button from "@/components/ui/Button";
import type {
  BranchDraft,
  ConversationMessage,
  ConversationScope,
  ForkOption,
} from "@/lib/conversations/types";
import ConversationScopeChip from "./ConversationScopeChip";
import { MessageRow, type ReaderSourceTarget } from "./MessageRow";
import styles from "./ChatSurface.module.css";

export default function ChatSurface({
  messages,
  scrollportRef,
  onScroll,
  olderCursor,
  onLoadOlder,
  emptyState,
  composer,
  scope,
  forkOptionsByParentId = {},
  switchableLeafIds,
  onSelectFork,
  onReplyToAssistant,
  onReaderSourceActivate,
}: {
  messages: ConversationMessage[];
  scrollportRef?: RefObject<HTMLDivElement | null>;
  onScroll?: UIEventHandler<HTMLDivElement>;
  olderCursor?: string | null;
  onLoadOlder?: () => void;
  emptyState?: ReactNode;
  composer: ReactNode;
  scope?: ConversationScope;
  forkOptionsByParentId?: Record<string, ForkOption[]>;
  switchableLeafIds?: Set<string>;
  onSelectFork?: (fork: ForkOption) => void;
  onReplyToAssistant?: (draft: BranchDraft) => void;
  onReaderSourceActivate?: (target: ReaderSourceTarget) => void;
}) {
  return (
    <div className={styles.surface}>
      <div
        ref={scrollportRef}
        className={styles.scrollport}
        role="region"
        tabIndex={0}
        aria-label="Chat conversation"
        onScroll={onScroll}
      >
        <div
          className={styles.transcript}
          role="log"
          aria-label="Chat messages"
        >
          {scope && scope.type !== "general" ? (
            <div className={styles.scopeBanner}>
              <ConversationScopeChip scope={scope} />
            </div>
          ) : null}

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
              forkOptions={forkOptionsByParentId[msg.id] ?? []}
              switchableLeafIds={switchableLeafIds}
              onSelectFork={onSelectFork}
              onReplyToAssistant={onReplyToAssistant}
              onReaderSourceActivate={onReaderSourceActivate}
            />
          ))}
        </div>

        <div className={styles.composerSlot}>{composer}</div>
      </div>
    </div>
  );
}
