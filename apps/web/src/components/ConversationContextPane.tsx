"use client";

import ContextRow from "@/components/ui/ContextRow";
import HighlightSnippet from "@/components/ui/HighlightSnippet";
import ActionMenu from "@/components/ui/ActionMenu";
import StateMessage from "@/components/ui/StateMessage";
import type { ActionMenuOption } from "@/components/ui/ActionMenu";
import type { ContextItem } from "@/lib/api/sse";
import type { ReactNode } from "react";
import styles from "./ConversationContextPane.module.css";

interface MessageContextSnapshot {
  type: "highlight" | "annotation" | "media";
  id: string;
  color?: "yellow" | "green" | "blue" | "pink" | "purple";
  exact?: string;
  preview?: string;
  prefix?: string;
  suffix?: string;
  annotation_body?: string;
  media_id?: string;
  media_title?: string;
  media_kind?: string;
}

interface PersistedContextRow {
  context: MessageContextSnapshot;
  messageId: string;
  messageSeq: number;
}

interface ConversationContextPaneProps {
  contexts: ContextItem[];
  persistedRows?: PersistedContextRow[];
  onRemoveContext?: (index: number) => void;
  testId?: string;
}

export default function ConversationContextPane({
  contexts,
  persistedRows = [],
  onRemoveContext,
  testId = "conversation-context-pane",
}: ConversationContextPaneProps) {
  return (
    <div className={styles.content} data-testid={testId}>
      {contexts.length === 0 && persistedRows.length === 0 ? (
        <StateMessage variant="empty">No linked context yet.</StateMessage>
      ) : null}

      {contexts.length > 0 ? (
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
                title={formatContextTitle(contextItem.type, contextItem.exact, contextItem.preview, contextItem.color)}
                titleClassName={styles.contextTitle}
                description={formatSelectionContext(contextItem.prefix, contextItem.suffix)}
                descriptionClassName={styles.contextDescription}
                meta={formatMeta(contextItem.mediaTitle, contextItem.mediaKind)}
                metaClassName={styles.contextMeta}
                actions={menuOptions.length > 0 ? <ActionMenu options={menuOptions} /> : undefined}
                expandedContent={
                  contextItem.annotationBody ? (
                    <div className={styles.annotationNote}>{contextItem.annotationBody}</div>
                  ) : undefined
                }
              />
            );
          })}
        </div>
      ) : null}

      {persistedRows.length > 0 ? (
        <div className={styles.contextList}>
          {persistedRows.map(({ context, messageId, messageSeq }, index) => {
            const menuOptions: ActionMenuOption[] = [];
            if (context.media_id) {
              menuOptions.push({
                id: "open-source",
                label: "Open source",
                href: `/media/${context.media_id}`,
              });
            }

            const meta = [formatMeta(context.media_title, context.media_kind), `Message #${messageSeq}`]
              .filter(Boolean)
              .join(" - ");

            return (
              <ContextRow
                key={`${messageId}-${context.type}-${context.id}-${index}`}
                leading={
                  context.color ? (
                    <span
                      className={`${styles.colorSwatch} ${styles[`swatch-${context.color}`]}`}
                      aria-hidden="true"
                    />
                  ) : undefined
                }
                title={formatContextTitle(context.type, context.exact, context.preview, context.color)}
                titleClassName={styles.contextTitle}
                description={formatSelectionContext(context.prefix, context.suffix)}
                descriptionClassName={styles.contextDescription}
                meta={meta}
                metaClassName={styles.contextMeta}
                actions={menuOptions.length > 0 ? <ActionMenu options={menuOptions} /> : undefined}
                expandedContent={
                  context.annotation_body ? (
                    <div className={styles.annotationNote}>{context.annotation_body}</div>
                  ) : undefined
                }
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function formatContextTitle(
  type: "highlight" | "annotation" | "media",
  exact?: string,
  preview?: string,
  color?: "yellow" | "green" | "blue" | "pink" | "purple",
): ReactNode {
  const text = exact || preview;
  if (text) {
    return <HighlightSnippet exact={text} color={color ?? "neutral"} compact />;
  }
  if (type === "highlight") {
    return "Highlight";
  }
  if (type === "annotation") {
    return "Annotation";
  }
  return "Media";
}

function formatSelectionContext(prefix?: string, suffix?: string): string | undefined {
  const parts: string[] = [];
  if (prefix) {
    parts.push(`...${truncate(prefix, 40)}`);
  }
  if (suffix) {
    parts.push(`${truncate(suffix, 40)}...`);
  }
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join(" [selection] ");
}

function formatMeta(mediaTitle?: string, mediaKind?: string): string | undefined {
  const parts = [mediaTitle, mediaKind].filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join(" - ");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}...`;
}
