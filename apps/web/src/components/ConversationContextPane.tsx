"use client";

import Pane from "@/components/Pane";
import StateMessage from "@/components/ui/StateMessage";
import ContextRow from "@/components/ui/ContextRow";
import HighlightSnippet from "@/components/ui/HighlightSnippet";
import ActionMenu from "@/components/ui/ActionMenu";
import type { ActionMenuOption } from "@/components/ui/ActionMenu";
import type { ContextItem } from "@/lib/api/sse";
import styles from "./ConversationContextPane.module.css";

interface ConversationContextPaneProps {
  contexts: ContextItem[];
  onRemoveContext?: (index: number) => void;
  title?: string;
}

export default function ConversationContextPane({
  contexts,
  onRemoveContext,
  title = "Context",
}: ConversationContextPaneProps) {
  return (
    <Pane title={title} defaultWidth={340} minWidth={280} maxWidth={900}>
      <div className={styles.content}>
        {contexts.length === 0 ? (
          <StateMessage variant="empty">No linked context yet.</StateMessage>
        ) : (
          <div className={styles.contextList}>
            {contexts.map((contextItem, index) => {
              const menuOptions: ActionMenuOption[] = [];
              if (onRemoveContext) {
                menuOptions.push({
                  id: "remove",
                  label: "Remove",
                  tone: "danger",
                  onSelect: () => onRemoveContext(index),
                });
              }
              if (contextItem.mediaId) {
                menuOptions.push({
                  id: "open-source",
                  label: "Open source",
                  href: `/media/${contextItem.mediaId}`,
                });
              }

              return (
                <ContextRow
                  key={`${contextItem.type}-${contextItem.id}-${index}`}
                  leading={
                    contextItem.color ? (
                      <span
                        className={`${styles.colorSwatch} ${styles[`swatch-${contextItem.color}`]}`}
                        aria-hidden="true"
                      />
                    ) : undefined
                  }
                  title={
                    contextItem.exact || contextItem.preview
                      ? <HighlightSnippet exact={contextItem.exact || contextItem.preview!} color={contextItem.color ?? "neutral"} compact />
                      : contextItem.type === "highlight" ? "Highlight" : contextItem.type === "annotation" ? "Annotation" : "Media"
                  }
                  titleClassName={styles.contextTitle}
                  meta={[contextItem.mediaTitle, contextItem.mediaKind].filter(Boolean).join(" \u2014 ") || undefined}
                  metaClassName={styles.contextMeta}
                  actions={
                    menuOptions.length > 0 ? (
                      <ActionMenu options={menuOptions} />
                    ) : undefined
                  }
                  expandedContent={
                    contextItem.annotationBody ? (
                      <div className={styles.annotationNote}>
                        {contextItem.annotationBody}
                      </div>
                    ) : undefined
                  }
                />
              );
            })}
          </div>
        )}
      </div>
    </Pane>
  );
}
