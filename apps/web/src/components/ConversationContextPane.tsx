"use client";

import Pane from "@/components/Pane";
import StateMessage from "@/components/ui/StateMessage";
import ContextRow from "@/components/ui/ContextRow";
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
                  title={contextItem.preview || (contextItem.type === "highlight" ? "Highlight" : contextItem.type === "annotation" ? "Annotation" : "Media")}
                  titleClassName={styles.contextTitle}
                  description={(() => {
                    const parts: string[] = [];
                    if (contextItem.prefix) parts.push("..." + (contextItem.prefix.length > 40 ? contextItem.prefix.slice(0, 40) + "..." : contextItem.prefix));
                    if (contextItem.suffix) parts.push((contextItem.suffix.length > 40 ? contextItem.suffix.slice(0, 40) + "..." : contextItem.suffix) + "...");
                    return parts.length > 0 ? parts.join(" [selection] ") : undefined;
                  })()}
                  descriptionClassName={styles.contextDescription}
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
