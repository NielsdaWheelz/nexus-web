"use client";

import { useEffect, useState } from "react";
import { PanelRight, X } from "lucide-react";
import ConversationContextPane from "@/components/ConversationContextPane";
import type { ContextItem } from "@/lib/api/sse";
import type { MessageContextSnapshot } from "@/lib/conversations/types";
import styles from "./ChatContextDrawer.module.css";

export default function ChatContextDrawer({
  contexts,
  persistedRows,
  onRemoveContext,
}: {
  contexts: ContextItem[];
  persistedRows?: Array<{
    context: MessageContextSnapshot;
    messageId: string;
    messageSeq: number;
  }>;
  onRemoveContext?: (index: number) => void;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        className={styles.fab}
        onClick={() => setOpen((value) => !value)}
        aria-label="Linked context"
        aria-expanded={open}
      >
        <PanelRight size={16} aria-hidden="true" />
      </button>

      {open ? (
        <div className={styles.backdrop} onClick={() => setOpen(false)}>
          <aside
            className={styles.drawer}
            role="dialog"
            aria-modal="true"
            aria-label="Linked context"
            onClick={(event) => event.stopPropagation()}
          >
            <header className={styles.header}>
              <h2>Linked context</h2>
              <button
                type="button"
                className={styles.closeButton}
                onClick={() => setOpen(false)}
                aria-label="Close"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </header>
            <div className={styles.body}>
              <ConversationContextPane
                contexts={contexts}
                persistedRows={persistedRows}
                onRemoveContext={onRemoveContext}
              />
            </div>
          </aside>
        </div>
      ) : null}
    </>
  );
}
