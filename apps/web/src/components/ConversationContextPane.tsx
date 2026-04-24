"use client";

import ContextRow from "@/components/ui/ContextRow";
import HighlightSnippet from "@/components/ui/HighlightSnippet";
import ActionMenu from "@/components/ui/ActionMenu";
import StateMessage from "@/components/ui/StateMessage";
import type { ActionMenuOption } from "@/components/ui/ActionMenu";
import type { ContextItem } from "@/lib/api/sse";
import {
  formatContextMeta,
  formatSelectionContext,
} from "@/lib/conversations/display";
import type { MessageContextSnapshot } from "@/lib/conversations/types";
import type { ReactNode } from "react";
import styles from "./ConversationContextPane.module.css";

interface PersistedContextRow {
  context: MessageContextSnapshot;
  messageId: string;
  messageSeq: number;
}

interface ContextRowViewModel {
  key: string;
  type: ContextItem["type"];
  id: string;
  color?: ContextItem["color"];
  exact?: string;
  preview?: string;
  prefix?: string;
  suffix?: string;
  annotationBody?: string;
  mediaId?: string;
  mediaTitle?: string;
  mediaKind?: string;
  messageSeq?: number;
  onRemove?: () => void;
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
          {contexts.map((contextItem, index) =>
            renderContextRow({
              key: `${contextItem.type}-${contextItem.id}-${index}`,
              type: contextItem.type,
              id: contextItem.id,
              color: contextItem.color,
              exact: contextItem.exact,
              preview: contextItem.preview,
              prefix: contextItem.prefix,
              suffix: contextItem.suffix,
              annotationBody: contextItem.annotationBody,
              mediaId: contextItem.mediaId,
              mediaTitle: contextItem.mediaTitle,
              mediaKind: contextItem.mediaKind,
              onRemove: onRemoveContext ? () => onRemoveContext(index) : undefined,
            }),
          )}
        </div>
      ) : null}

      {persistedRows.length > 0 ? (
        <div className={styles.contextList}>
          {persistedRows.map(({ context, messageId, messageSeq }, index) =>
            renderContextRow({
              key: `${messageId}-${context.type}-${context.id}-${index}`,
              type: context.type,
              id: context.id,
              color: context.color,
              exact: context.exact,
              preview: context.preview,
              prefix: context.prefix,
              suffix: context.suffix,
              annotationBody: context.annotation_body,
              mediaId: context.media_id,
              mediaTitle: context.media_title,
              mediaKind: context.media_kind,
              messageSeq,
            }),
          )}
        </div>
      ) : null}
    </div>
  );
}

function renderContextRow(row: ContextRowViewModel) {
  const menuOptions: ActionMenuOption[] = [];
  if (row.onRemove) {
    menuOptions.push({
      id: "remove",
      label: "Remove",
      tone: "danger",
      onSelect: row.onRemove,
    });
  }
  if (row.mediaId) {
    menuOptions.push({
      id: "open-source",
      label: "Open source",
      href: `/media/${row.mediaId}`,
    });
  }

  const baseMeta = formatContextMeta(row.mediaTitle, row.mediaKind);
  const meta = [baseMeta, row.messageSeq ? `Message #${row.messageSeq}` : null]
    .filter(Boolean)
    .join(" - ");

  return (
    <ContextRow
      key={row.key}
      leading={
        row.color ? (
          <span
            className={`${styles.colorSwatch} ${styles[`swatch-${row.color}`]}`}
            aria-hidden="true"
          />
        ) : undefined
      }
      title={formatContextTitle(row.type, row.exact, row.preview, row.color)}
      titleClassName={styles.contextTitle}
      description={formatSelectionContext(row.prefix, row.suffix)}
      descriptionClassName={styles.contextDescription}
      meta={meta || undefined}
      metaClassName={styles.contextMeta}
      actions={menuOptions.length > 0 ? <ActionMenu options={menuOptions} /> : undefined}
      expandedContent={
        row.annotationBody ? (
          <div className={styles.annotationNote}>{row.annotationBody}</div>
        ) : undefined
      }
    />
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
