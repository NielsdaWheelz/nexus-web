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

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "..." : text;
}

function formatContextTitle(item: ContextItem): string {
  if (item.preview) return item.preview;
  if (item.type === "highlight") return "Highlight";
  if (item.type === "annotation") return "Annotation";
  return "Media";
}

function formatSurroundingContext(item: ContextItem): string | undefined {
  const parts: string[] = [];
  if (item.prefix) parts.push("..." + truncate(item.prefix, 40));
  if (item.suffix) parts.push(truncate(item.suffix, 40) + "...");
  return parts.length > 0 ? parts.join(" [selection] ") : undefined;
}

function formatMeta(item: ContextItem): string | undefined {
  const parts: string[] = [];
  if (item.mediaTitle) parts.push(item.mediaTitle);
  if (item.mediaKind) parts.push(item.mediaKind);
  return parts.length > 0 ? parts.join(" \u2014 ") : undefined;
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
                  title={formatContextTitle(contextItem)}
                  titleClassName={styles.contextTitle}
                  description={formatSurroundingContext(contextItem)}
                  descriptionClassName={styles.contextDescription}
                  meta={formatMeta(contextItem)}
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
