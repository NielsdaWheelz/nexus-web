"use client";

import ContextRow from "@/components/ui/ContextRow";
import HighlightSnippet from "@/components/ui/HighlightSnippet";
import ActionMenu from "@/components/ui/ActionMenu";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import ConversationMemoryPanel from "@/components/chat/ConversationMemoryPanel";
import ConversationScopeChip from "@/components/chat/ConversationScopeChip";
import type { ActionMenuOption } from "@/components/ui/ActionMenu";
import type { ContextItem, ContextItemColor, ContextItemType } from "@/lib/api/sse";
import {
  formatContextMeta,
  formatSelectionContext,
} from "@/lib/conversations/display";
import type {
  ConversationMemoryInspection,
  ConversationScope,
  MessageContextSnapshot,
} from "@/lib/conversations/types";
import type { ReactNode } from "react";
import styles from "./ConversationContextPane.module.css";

interface PersistedContextRow {
  context: MessageContextSnapshot;
  messageId: string;
  messageSeq: number;
}

interface ContextRowViewModel {
  key: string;
  kind: "object_ref" | "reader_selection";
  type?: ContextItemType | null;
  id?: string | null;
  color?: ContextItemColor;
  exact?: string;
  preview?: string;
  prefix?: string;
  suffix?: string;
  title?: string;
  route?: string;
  mediaId?: string;
  mediaTitle?: string;
  mediaKind?: string;
  messageSeq?: number;
  onRemove?: () => void;
}

interface ConversationContextPaneProps {
  scope?: ConversationScope;
  memory?: ConversationMemoryInspection | null;
  contexts: ContextItem[];
  persistedRows?: PersistedContextRow[];
  onRemoveContext?: (index: number) => void;
  testId?: string;
}

export default function ConversationContextPane({
  scope,
  memory,
  contexts,
  persistedRows = [],
  onRemoveContext,
  testId = "conversation-context-pane",
}: ConversationContextPaneProps) {
  const hasMemory =
    Boolean(memory?.state_snapshot) || (memory?.memory_items?.length ?? 0) > 0;

  return (
    <div className={styles.content} data-testid={testId}>
      {(!scope || scope.type === "general") &&
      contexts.length === 0 &&
      persistedRows.length === 0 &&
      !hasMemory ? (
        <FeedbackNotice severity="neutral" title="No linked context yet." />
      ) : null}

      {scope && scope.type !== "general" ? (
        <section className={styles.section} aria-label="Conversation scope">
          <h3 className={styles.sectionTitle}>Scope</h3>
          <ConversationScopeChip scope={scope} />
        </section>
      ) : null}

      {contexts.length > 0 ? (
        <section className={styles.section} aria-label="Pending contexts">
          <h3 className={styles.sectionTitle}>Pending context</h3>
          <div className={styles.contextList}>
            {contexts.map((contextItem, index) =>
              renderContextRow({
                key:
                  contextItem.kind === "reader_selection"
                    ? `${contextItem.client_context_id}-${index}`
                    : `${contextItem.type}-${contextItem.id}-${index}`,
                kind: contextItem.kind,
                type: contextItem.kind === "object_ref" ? contextItem.type : null,
                id: contextItem.kind === "object_ref" ? contextItem.id : null,
                color: contextItem.color,
                exact: contextItem.exact,
                preview: contextItem.preview,
                prefix: contextItem.prefix,
                suffix: contextItem.suffix,
                mediaId:
                  contextItem.kind === "reader_selection"
                    ? contextItem.media_id
                    : contextItem.mediaId,
                mediaTitle:
                  contextItem.kind === "reader_selection"
                    ? contextItem.media_title
                    : contextItem.mediaTitle,
                mediaKind:
                  contextItem.kind === "reader_selection"
                    ? contextItem.media_kind
                    : contextItem.mediaKind,
                onRemove: onRemoveContext ? () => onRemoveContext(index) : undefined,
              }),
            )}
          </div>
        </section>
      ) : null}

      {persistedRows.length > 0 ? (
        <section className={styles.section} aria-label="Message contexts">
          <h3 className={styles.sectionTitle}>Message context</h3>
          <div className={styles.contextList}>
            {persistedRows.map(({ context, messageId, messageSeq }, index) =>
              renderContextRow({
                key: `${messageId}-${context.kind}-${context.id ?? context.client_context_id ?? index}`,
                kind: context.kind,
                type: context.type,
                id: context.id,
                color: context.color,
                exact: context.exact,
                preview: context.preview,
                prefix: context.prefix,
                suffix: context.suffix,
                title: context.title,
                route: context.route,
                mediaId: context.media_id,
                mediaTitle: context.media_title,
                mediaKind: context.media_kind,
                messageSeq,
              }),
            )}
          </div>
        </section>
      ) : null}

      <ConversationMemoryPanel memory={memory} />
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
  } else if (row.route) {
    menuOptions.push({
      id: "open-context",
      label: "Open",
      href: row.route,
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
      title={formatContextTitle(row.kind, row.type, row.exact, row.preview, row.title, row.color)}
      titleClassName={styles.contextTitle}
      description={formatSelectionContext(row.prefix, row.suffix)}
      descriptionClassName={styles.contextDescription}
      meta={meta || undefined}
      metaClassName={styles.contextMeta}
      actions={menuOptions.length > 0 ? <ActionMenu options={menuOptions} /> : undefined}
    />
  );
}

function formatContextTitle(
  kind: "object_ref" | "reader_selection",
  type?: ContextItemType | null,
  exact?: string,
  preview?: string,
  title?: string,
  color?: ContextItemColor,
): ReactNode {
  const text = exact || preview || title;
  if (text) {
    return <HighlightSnippet exact={text} color={color ?? "neutral"} compact />;
  }
  if (kind === "reader_selection") {
    return "Selected quote";
  }
  if (type === "highlight") {
    return "Highlight";
  }
  if (type === "note_block") {
    return "Note";
  }
  if (type === "page") {
    return "Page";
  }
  if (type === "message") {
    return "Message";
  }
  if (type === "conversation") {
    return "Conversation";
  }
  if (type === "podcast") {
    return "Podcast";
  }
  if (type === "content_chunk") {
    return "Passage";
  }
  if (type === "contributor") {
    return "Contributor";
  }
  return "Media";
}
