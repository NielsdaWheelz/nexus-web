"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
} from "react";
import ChatDetailSlideIn from "@/components/chat/ChatDetailSlideIn";
import type { ReaderSourceTarget } from "@/components/chat/MessageRow";
import type {
  ContextItem,
  ReaderContextHintInput,
  SingletonTargetInput,
} from "@/lib/api/sse/requests";
import { useBodyOverflowLock } from "@/lib/ui/useBodyOverflowLock";
import { useFocusTrap } from "@/lib/ui/useFocusTrap";
import styles from "./QuoteChatSheet.module.css";

export default function QuoteChatSheet({
  title,
  contexts,
  conversationId,
  singletonTarget = null,
  readerContext = null,
  onClose,
  onOpenFullChat,
  onReaderSourceActivate,
  onAskAboutSource,
  onSaveSourceQuote,
}: {
  title: string;
  contexts: ContextItem[];
  conversationId: string | null;
  singletonTarget?: SingletonTargetInput | null;
  readerContext?: ReaderContextHintInput | null;
  onClose: () => void;
  onOpenFullChat?: () => void;
  onReaderSourceActivate?: (target: ReaderSourceTarget) => void;
  onAskAboutSource?: (target: ReaderSourceTarget) => void;
  onSaveSourceQuote?: (target: ReaderSourceTarget) => void;
}) {
  const sheetRef = useRef<HTMLElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [composerFocused, setComposerFocused] = useState(false);

  useFocusTrap(sheetRef, true);
  useBodyOverflowLock(true);

  useEffect(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => {
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
        <ChatDetailSlideIn
          title={title}
          conversationId={conversationId}
          singletonTarget={singletonTarget}
          attachedContexts={contexts}
          readerContext={readerContext}
          onBack={onClose}
          onOpenFullChat={onOpenFullChat}
          onReaderSourceActivate={onReaderSourceActivate}
          onAskAboutSource={onAskAboutSource}
          onSaveSourceQuote={onSaveSourceQuote}
        />
      </aside>
    </div>
  );
}
