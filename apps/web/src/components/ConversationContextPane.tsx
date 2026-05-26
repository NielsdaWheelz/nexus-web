"use client";

import { useMemo, useState } from "react";
import ContextRow from "@/components/ui/ContextRow";
import HighlightSnippet from "@/components/ui/HighlightSnippet";
import ActionMenu from "@/components/ui/ActionMenu";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import ConversationMemoryPanel from "@/components/chat/ConversationMemoryPanel";
import ConversationForksPanel from "@/components/chat/ConversationForksPanel";
import ConversationProvenancePanel from "@/components/chat/ConversationProvenancePanel";
import { countProvenanceSignals } from "@/lib/conversations/provenance/buildModel";
import type { ActionMenuOption } from "@/components/ui/ActionMenu";
import type {
  ContextItem,
  ContextItemColor,
  ContextItemType,
} from "@/lib/api/sse/requests";
import {
  SINGLETON_KIND_ICONS,
  formatContextMeta,
  formatSelectionContext,
  formatSingletonLabel,
} from "@/lib/conversations/display";
import type {
  ConversationMemoryInspection,
  ConversationMessage,
  ConversationSingleton,
  BranchGraph,
  ForkOption,
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

interface ReferencedMedia {
  mediaId: string;
  mediaTitle?: string;
  mediaKind?: string;
}

interface ConversationContextPaneProps {
  conversationId?: string;
  singleton?: ConversationSingleton | null;
  memory?: ConversationMemoryInspection | null;
  messages?: ConversationMessage[];
  contexts: ContextItem[];
  persistedRows?: PersistedContextRow[];
  forkOptionsByParentId?: Record<string, ForkOption[]>;
  branchGraph?: BranchGraph;
  switchableLeafIds?: Set<string>;
  activeLeafMessageId?: string | null;
  selectedPathMessageIds?: Set<string>;
  onSelectFork?: (fork: ForkOption) => void;
  onSelectGraphLeaf?: (leafMessageId: string) => void;
  onForksChanged?: () => void;
  onRemoveContext?: (index: number) => void;
  testId?: string;
}

export default function ConversationContextPane({
  conversationId,
  singleton,
  memory,
  messages = [],
  contexts,
  persistedRows = [],
  forkOptionsByParentId = {},
  branchGraph = { nodes: [], edges: [], root_message_id: null },
  switchableLeafIds,
  activeLeafMessageId = null,
  selectedPathMessageIds = new Set(),
  onSelectFork,
  onSelectGraphLeaf,
  onForksChanged,
  onRemoveContext,
  testId = "conversation-context-pane",
}: ConversationContextPaneProps) {
  const [mode, setMode] = useState<"context" | "provenance" | "forks">(
    "context",
  );
  const hasMemory =
    Boolean(memory?.state_snapshot) || (memory?.memory_items?.length ?? 0) > 0;
  const provenanceCount = countProvenanceSignals(messages, memory);
  const forkCount = Object.values(forkOptionsByParentId).reduce(
    (count, forks) => count + forks.length,
    0,
  );

  const referencedMedia = useMemo<ReferencedMedia[]>(() => {
    const byMediaId = new Map<string, ReferencedMedia>();
    for (const message of messages) {
      for (const context of message.contexts ?? []) {
        const mediaId = context.media_id;
        if (!mediaId || byMediaId.has(mediaId)) continue;
        byMediaId.set(mediaId, {
          mediaId,
          mediaTitle: context.media_title,
          mediaKind: context.media_kind,
        });
      }
    }
    return [...byMediaId.values()];
  }, [messages]);

  return (
    <div className={styles.shell} data-testid={testId}>
      <div className={styles.toggle} role="tablist" aria-label="Chat side panel">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "context"}
          onClick={() => setMode("context")}
        >
          Context
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "provenance"}
          onClick={() => setMode("provenance")}
        >
          Provenance{provenanceCount > 0 ? ` ${provenanceCount}` : ""}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "forks"}
          onClick={() => setMode("forks")}
        >
          Forks{forkCount > 0 ? ` ${forkCount}` : ""}
        </button>
      </div>

      <div className={styles.content}>
        {mode === "forks" ? (
          conversationId && onSelectFork ? (
            <ConversationForksPanel
              conversationId={conversationId}
              forkOptionsByParentId={forkOptionsByParentId}
              branchGraph={branchGraph}
              switchableLeafIds={switchableLeafIds}
              activeLeafMessageId={activeLeafMessageId}
              selectedPathMessageIds={selectedPathMessageIds}
              onSelectFork={onSelectFork}
              onSelectGraphLeaf={onSelectGraphLeaf ?? (() => undefined)}
              onForksChanged={onForksChanged}
            />
          ) : (
            <FeedbackNotice severity="neutral" title="No forks yet." />
          )
        ) : mode === "provenance" ? (
          <ConversationProvenancePanel
            messages={messages}
            memory={memory}
          />
        ) : (
          <ContextContent
            singleton={singleton}
            referencedMedia={referencedMedia}
            memory={memory}
            contexts={contexts}
            persistedRows={persistedRows}
            hasMemory={hasMemory}
            onRemoveContext={onRemoveContext}
          />
        )}
      </div>
    </div>
  );
}

function ContextContent({
  singleton,
  referencedMedia,
  memory,
  contexts,
  persistedRows,
  hasMemory,
  onRemoveContext,
}: {
  singleton?: ConversationSingleton | null;
  referencedMedia: ReferencedMedia[];
  memory?: ConversationMemoryInspection | null;
  contexts: ContextItem[];
  persistedRows: PersistedContextRow[];
  hasMemory: boolean;
  onRemoveContext?: (index: number) => void;
}) {
  const hasContent =
    Boolean(singleton) ||
    referencedMedia.length > 0 ||
    contexts.length > 0 ||
    persistedRows.length > 0 ||
    hasMemory;

  return (
    <>
      {!hasContent ? (
        <FeedbackNotice severity="neutral" title="No linked context yet." />
      ) : null}

      {singleton ? <SingletonSection singleton={singleton} /> : null}

      {referencedMedia.length > 0 ? (
        <ReferencedMediaSection media={referencedMedia} />
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
    </>
  );
}

function SingletonSection({ singleton }: { singleton: ConversationSingleton }) {
  const Icon = SINGLETON_KIND_ICONS[singleton.kind];
  return (
    <section className={styles.section} aria-label="Conversation singleton">
      <h3 className={styles.sectionTitle}>Singleton</h3>
      <ContextRow
        leading={<Icon size={16} aria-hidden="true" />}
        title={formatSingletonLabel(singleton)}
        titleClassName={styles.contextTitle}
      />
    </section>
  );
}

function ReferencedMediaSection({ media }: { media: ReferencedMedia[] }) {
  return (
    <section className={styles.section} aria-label="Referenced media">
      <h3 className={styles.sectionTitle}>Referenced media</h3>
      <div className={styles.contextList}>
        {media.map((item) => (
          <ContextRow
            key={item.mediaId}
            title={item.mediaTitle || "Media"}
            titleClassName={styles.contextTitle}
            meta={item.mediaKind}
            metaClassName={styles.contextMeta}
            actions={
              <ActionMenu
                options={[
                  {
                    id: "open-source",
                    label: "Open source",
                    href: `/media/${item.mediaId}`,
                  },
                ]}
              />
            }
          />
        ))}
      </div>
    </section>
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
