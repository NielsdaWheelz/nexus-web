"use client";

import { useEffect, useRef, useState } from "react";
import { PanelRight, X } from "lucide-react";
import ConversationContextPane from "@/components/ConversationContextPane";
import Button from "@/components/ui/Button";
import type { ContextItem } from "@/lib/api/sse";
import type {
  ConversationMemoryInspection,
  ConversationScope,
  BranchGraph,
  ForkOption,
  ConversationMessage,
  MessageContextSnapshot,
} from "@/lib/conversations/types";
import styles from "./ChatContextDrawer.module.css";

export default function ChatContextDrawer({
  conversationId,
  contexts,
  scope,
  memory,
  messages,
  persistedRows,
  forkOptionsByParentId,
  branchGraph,
  switchableLeafIds,
  activeLeafMessageId,
  selectedPathMessageIds,
  onSelectFork,
  onSelectGraphLeaf,
  onForksChanged,
  onRemoveContext,
}: {
  conversationId?: string;
  contexts: ContextItem[];
  scope?: ConversationScope;
  memory?: ConversationMemoryInspection | null;
  messages?: ConversationMessage[];
  persistedRows?: Array<{
    context: MessageContextSnapshot;
    messageId: string;
    messageSeq: number;
  }>;
  forkOptionsByParentId?: Record<string, ForkOption[]>;
  branchGraph?: BranchGraph;
  switchableLeafIds?: Set<string>;
  activeLeafMessageId?: string | null;
  selectedPathMessageIds?: Set<string>;
  onSelectFork?: (fork: ForkOption) => void;
  onSelectGraphLeaf?: (leafMessageId: string) => void;
  onForksChanged?: () => void;
  onRemoveContext?: (index: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        drawerRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <>
      <Button
        variant="secondary"
        size="md"
        iconOnly
        className={styles.fab}
        onClick={() => setOpen((value) => !value)}
        aria-label="Linked context"
        aria-expanded={open}
      >
        <PanelRight size={16} aria-hidden="true" />
      </Button>

      {open ? (
        <div className={styles.backdrop} onClick={() => setOpen(false)}>
          <aside
            ref={drawerRef}
            className={styles.drawer}
            role="dialog"
            aria-modal="true"
            aria-label="Linked context"
            onClick={(event) => event.stopPropagation()}
          >
            <header className={styles.header}>
              <h2>Linked context</h2>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                onClick={() => setOpen(false)}
                aria-label="Close"
              >
                <X size={16} aria-hidden="true" />
              </Button>
            </header>
            <div className={styles.body}>
              <ConversationContextPane
                conversationId={conversationId}
                scope={scope}
                memory={memory}
                messages={messages}
                contexts={contexts}
                persistedRows={persistedRows}
                forkOptionsByParentId={forkOptionsByParentId}
                branchGraph={branchGraph}
                switchableLeafIds={switchableLeafIds}
                activeLeafMessageId={activeLeafMessageId}
                selectedPathMessageIds={selectedPathMessageIds}
                onSelectFork={(fork) => {
                  setOpen(false);
                  onSelectFork?.(fork);
                }}
                onSelectGraphLeaf={(leafMessageId) => {
                  setOpen(false);
                  onSelectGraphLeaf?.(leafMessageId);
                }}
                onForksChanged={onForksChanged}
                onRemoveContext={onRemoveContext}
              />
            </div>
          </aside>
        </div>
      ) : null}
    </>
  );
}
