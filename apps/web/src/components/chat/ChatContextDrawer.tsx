"use client";

import { useEffect, useState } from "react";
import { PanelRight, X } from "lucide-react";
import ConversationContextPane from "@/components/ConversationContextPane";
import Button from "@/components/ui/Button";
import type { ContextItem } from "@/lib/api/sse";
import type {
  ConversationMemoryInspection,
  ConversationScope,
  BranchGraph,
  ForkOption,
  MessageContextSnapshot,
} from "@/lib/conversations/types";
import styles from "./ChatContextDrawer.module.css";

export default function ChatContextDrawer({
  conversationId,
  contexts,
  scope,
  memory,
  persistedRows,
  forkOptionsByParentId,
  branchGraph,
  switchableLeafIds,
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
  persistedRows?: Array<{
    context: MessageContextSnapshot;
    messageId: string;
    messageSeq: number;
  }>;
  forkOptionsByParentId?: Record<string, ForkOption[]>;
  branchGraph?: BranchGraph;
  switchableLeafIds?: Set<string>;
  selectedPathMessageIds?: Set<string>;
  onSelectFork?: (fork: ForkOption) => void;
  onSelectGraphLeaf?: (leafMessageId: string) => void;
  onForksChanged?: () => void;
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
                contexts={contexts}
                persistedRows={persistedRows}
                forkOptionsByParentId={forkOptionsByParentId}
                branchGraph={branchGraph}
                switchableLeafIds={switchableLeafIds}
                selectedPathMessageIds={selectedPathMessageIds}
                onSelectFork={(fork) => {
                  onSelectFork?.(fork);
                  setOpen(false);
                }}
                onSelectGraphLeaf={(leafMessageId) => {
                  onSelectGraphLeaf?.(leafMessageId);
                  setOpen(false);
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
