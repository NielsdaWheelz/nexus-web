"use client";

import Pane from "@/components/Pane";
import StateMessage from "@/components/ui/StateMessage";
import { AppList, AppListItem } from "@/components/ui/AppList";
import type { ActionMenuOption } from "@/components/ui/ActionMenu";
import type { ContextItem } from "@/lib/api/sse";
import styles from "./ConversationContextPane.module.css";

interface ConversationContextPaneProps {
  contexts: ContextItem[];
  onRemoveContext?: (index: number) => void;
  title?: string;
}

function formatContextTitle(item: ContextItem): string {
  if (item.preview) {
    return item.preview;
  }
  if (item.type === "highlight") return "Highlight";
  if (item.type === "annotation") return "Annotation";
  return "Media";
}

function formatContextDescription(item: ContextItem): string {
  if (item.mediaTitle) return item.mediaTitle;
  return `id ${item.id.slice(0, 8)}`;
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
          <AppList>
            {contexts.map((contextItem, index) => {
              const options: ActionMenuOption[] = [];
              if (onRemoveContext) {
                options.push({
                  id: "remove",
                  label: "Remove",
                  tone: "danger",
                  onSelect: () => onRemoveContext(index),
                });
              }
              if (contextItem.mediaId) {
                options.push({
                  id: "open-source",
                  label: "Open source",
                  href: `/media/${contextItem.mediaId}`,
                });
              }

              return (
                <AppListItem
                  key={`${contextItem.type}-${contextItem.id}-${index}`}
                  icon={
                    contextItem.color ? (
                      <span
                        className={`${styles.colorSwatch} ${styles[`swatch-${contextItem.color}`]}`}
                        aria-hidden="true"
                      />
                    ) : undefined
                  }
                  title={formatContextTitle(contextItem)}
                  description={formatContextDescription(contextItem)}
                  meta={contextItem.mediaTitle ? `id ${contextItem.id.slice(0, 8)}` : undefined}
                  options={options.length > 0 ? options : undefined}
                />
              );
            })}
          </AppList>
        )}
      </div>
    </Pane>
  );
}
