"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
} from "react";
import ReaderAssistantPane, {
  type ReaderAssistantScopeOption,
} from "@/components/chat/ReaderAssistantPane";
import type { ReaderSourceTarget } from "@/components/chat/MessageRow";
import { type ContextItem } from "@/lib/api/sse/requests";
import type { ConversationScope } from "@/lib/conversations/types";
import { useFocusTrap } from "@/lib/ui/useFocusTrap";
import styles from "./QuoteChatSheet.module.css";

export default function QuoteChatSheet({
  contexts,
  conversationId,
  conversationScope,
  scopeOptions,
  targetLabel,
  onScopeChange,
  onClose,
  onConversationCreated,
  onOpenFullChat,
  onReaderSourceActivate,
  onAskAboutSource,
  onSaveSourceQuote,
}: {
  contexts: ContextItem[];
  conversationId: string | null;
  conversationScope?: ConversationScope;
  scopeOptions?: ReaderAssistantScopeOption[];
  targetLabel?: string;
  onScopeChange?: (scope: ConversationScope) => void;
  onClose: () => void;
  onConversationCreated: (conversationId: string, runId?: string) => void;
  onOpenFullChat: (conversationId: string) => void;
  onReaderSourceActivate?: (target: ReaderSourceTarget) => void;
  onAskAboutSource?: (target: ReaderSourceTarget) => void;
  onSaveSourceQuote?: (target: ReaderSourceTarget) => void;
}) {
  const sheetRef = useRef<HTMLElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [composerFocused, setComposerFocused] = useState(false);

  useFocusTrap(sheetRef, true);

  useEffect(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleEscape);
      previousFocusRef.current?.focus({ preventScroll: true });
    };
  }, [onClose]);

  const handleFocusCapture = useCallback((event: FocusEvent<HTMLElement>) => {
    if (event.target instanceof HTMLTextAreaElement) {
      setComposerFocused(true);
    }
  }, []);

  const handleBlurCapture = useCallback(() => {
    window.setTimeout(() => {
      if (!sheetRef.current?.contains(document.activeElement)) {
        setComposerFocused(false);
        return;
      }
      if (!(document.activeElement instanceof HTMLTextAreaElement)) {
        setComposerFocused(false);
      }
    }, 0);
  }, []);

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <aside
        ref={sheetRef}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label="Ask in chat"
        data-composer-focused={composerFocused ? "true" : "false"}
        onClick={(event) => event.stopPropagation()}
        onFocusCapture={handleFocusCapture}
        onBlurCapture={handleBlurCapture}
      >
        <ReaderAssistantPane
          contexts={contexts}
          conversationId={conversationId}
          conversationScope={conversationScope}
          scopeOptions={scopeOptions}
          targetLabel={targetLabel}
          onScopeChange={onScopeChange}
          onClose={onClose}
          onConversationAvailable={onConversationCreated}
          onOpenFullChat={onOpenFullChat}
          onReaderSourceActivate={onReaderSourceActivate}
          onAskAboutSource={onAskAboutSource}
          onSaveSourceQuote={onSaveSourceQuote}
          autoFocusComposer
        />
      </aside>
    </div>
  );
}
