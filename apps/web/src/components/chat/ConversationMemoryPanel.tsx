"use client";

import { ExternalLink } from "lucide-react";
import type {
  ConversationMemoryEvidenceRole,
  ConversationMemoryInspection,
  ConversationMemoryItem,
  ConversationSourceRef,
  ConversationSourceRefType,
  ConversationStateSnapshot,
} from "@/lib/conversations/types";
import styles from "./ConversationMemoryPanel.module.css";

interface ConversationMemoryPanelProps {
  memory?: ConversationMemoryInspection | null;
  testId?: string;
}

export default function ConversationMemoryPanel({
  memory,
  testId = "conversation-memory-panel",
}: ConversationMemoryPanelProps) {
  const activeSnapshot =
    memory?.state_snapshot?.status === "active" ? memory.state_snapshot : null;
  const activeItems = (memory?.memory_items ?? []).filter(
    (item) => item.status === "active",
  );

  if (!activeSnapshot && activeItems.length === 0) {
    return null;
  }

  return (
    <section
      className={styles.panel}
      aria-label="Conversation memory"
      data-testid={testId}
    >
      <h3 className={styles.title}>Memory</h3>

      {activeSnapshot ? <StateSnapshot snapshot={activeSnapshot} /> : null}

      {activeItems.length > 0 ? (
        <ul className={styles.memoryList}>
          {activeItems.map((item) => (
            <MemoryItemRow key={item.id} item={item} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function StateSnapshot({ snapshot }: { snapshot: ConversationStateSnapshot }) {
  const meta = [
    snapshot.memory_item_ids.length > 0
      ? `${snapshot.memory_item_ids.length} memory item${
          snapshot.memory_item_ids.length === 1 ? "" : "s"
        }`
      : null,
    snapshot.prompt_version ? `Prompt ${snapshot.prompt_version}` : null,
    snapshot.snapshot_version ? `Snapshot ${snapshot.snapshot_version}` : null,
  ].filter(Boolean);

  return (
    <div className={styles.snapshot}>
      <div className={styles.rowHeader}>
        <span className={styles.badge}>State</span>
        <span className={styles.coverage}>
          Covered through message #{snapshot.covered_through_seq}
        </span>
      </div>
      {meta.length > 0 ? <div className={styles.meta}>{meta.join(" - ")}</div> : null}
      {snapshot.source_refs.length > 0 ? (
        <SourceRefList
          label="State sources"
          sources={snapshot.source_refs.map((source_ref) => ({
            source_ref,
            evidence_role: "context" as const,
          }))}
        />
      ) : null}
    </div>
  );
}

function MemoryItemRow({ item }: { item: ConversationMemoryItem }) {
  const seqRange = formatSeqRange(item);
  const meta = [
    typeof item.confidence === "number"
      ? `${Math.round(item.confidence * 100)}% confidence`
      : null,
    item.memory_version ? `Memory ${item.memory_version}` : null,
    item.prompt_version ? `Prompt ${item.prompt_version}` : null,
  ].filter(Boolean);

  return (
    <li className={styles.memoryItem}>
      <div className={styles.rowHeader}>
        <span className={styles.badge}>{formatMemoryKind(item.kind)}</span>
        {seqRange ? <span className={styles.coverage}>{seqRange}</span> : null}
      </div>
      <p className={styles.body}>{item.body}</p>
      {meta.length > 0 ? <div className={styles.meta}>{meta.join(" - ")}</div> : null}
      {item.sources.length > 0 ? (
        <SourceRefList
          label={`${formatMemoryKind(item.kind)} sources`}
          sources={item.sources}
        />
      ) : null}
    </li>
  );
}

function SourceRefList({
  label,
  sources,
}: {
  label: string;
  sources: Array<{
    evidence_role: ConversationMemoryEvidenceRole;
    source_ref: ConversationSourceRef;
  }>;
}) {
  return (
    <ul className={styles.sourceList} aria-label={label}>
      {sources.map((source, index) => (
        <SourceRefRow
          key={`${source.source_ref.type}-${source.source_ref.id}-${index}`}
          role={source.evidence_role}
          sourceRef={source.source_ref}
        />
      ))}
    </ul>
  );
}

function SourceRefRow({
  role,
  sourceRef,
}: {
  role: ConversationMemoryEvidenceRole;
  sourceRef: ConversationSourceRef;
}) {
  const href = getSourceHref(sourceRef);
  const label = getSourceLabel(sourceRef);
  const detail = getSourceDetail(sourceRef, label);
  const external = href ? /^https?:\/\//.test(href) : false;
  const content = (
    <>
      <span className={styles.sourceLabel}>{label}</span>
      <span className={styles.sourceRole}>{formatEvidenceRole(role)}</span>
      {detail ? <span className={styles.sourceDetail}>{detail}</span> : null}
      {href ? <ExternalLink size={12} aria-hidden="true" /> : null}
    </>
  );

  return (
    <li className={styles.sourceItem}>
      {href ? (
        <a
          className={styles.sourceLink}
          href={href}
          target={external ? "_blank" : undefined}
          rel={external ? "noreferrer" : undefined}
        >
          {content}
        </a>
      ) : (
        <span className={styles.sourceLink}>{content}</span>
      )}
    </li>
  );
}

function getSourceLabel(sourceRef: ConversationSourceRef): string {
  if (sourceRef.label) {
    return sourceRef.label;
  }

  const resultTitle =
    getRecordString(sourceRef.result_ref, "title") ||
    getRecordString(sourceRef.result_ref, "source_label") ||
    getRecordString(sourceRef.result_ref, "source_name") ||
    getRecordString(sourceRef.result_ref, "display_url");
  if (resultTitle) {
    return resultTitle;
  }

  if (sourceRef.type === "message" && typeof sourceRef.message_seq === "number") {
    return `Message #${sourceRef.message_seq}`;
  }
  if (
    sourceRef.type === "message_context" &&
    typeof sourceRef.message_seq === "number"
  ) {
    return `Message context #${sourceRef.message_seq}`;
  }
  if (sourceRef.context_ref) {
    return `${formatEnumLabel(sourceRef.context_ref.type)} ${shortId(
      sourceRef.context_ref.id,
    )}`;
  }
  return `${formatSourceType(sourceRef.type)} ${shortId(sourceRef.id)}`;
}

function getSourceDetail(sourceRef: ConversationSourceRef, label: string): string {
  const parts: string[] = [];
  if (
    typeof sourceRef.message_seq === "number" &&
    !label.includes(`#${sourceRef.message_seq}`)
  ) {
    parts.push(`Message #${sourceRef.message_seq}`);
  }
  if (typeof sourceRef.location?.page === "number") {
    parts.push(`Page ${sourceRef.location.page}`);
  }
  if (typeof sourceRef.location?.t_start_ms === "number") {
    parts.push(`${Math.floor(sourceRef.location.t_start_ms / 1000)}s`);
  }
  if (
    typeof sourceRef.location?.start_offset === "number" &&
    typeof sourceRef.location?.end_offset === "number"
  ) {
    parts.push(
      `Offsets ${sourceRef.location.start_offset}-${sourceRef.location.end_offset}`,
    );
  }
  if (sourceRef.source_version) {
    parts.push(`Version ${sourceRef.source_version}`);
  }
  return parts.join(" - ");
}

function getSourceHref(sourceRef: ConversationSourceRef): string | undefined {
  return (
    sourceRef.deep_link ||
    getRecordString(sourceRef.result_ref, "url") ||
    getRecordString(sourceRef.result_ref, "deep_link")
  );
}

function getRecordString(
  record: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function formatSeqRange(item: ConversationMemoryItem): string | undefined {
  const from = item.valid_from_seq;
  const through = item.valid_through_seq;
  if (typeof from === "number" && typeof through === "number") {
    return from === through ? `Message #${from}` : `Messages #${from}-#${through}`;
  }
  if (typeof from === "number") {
    return `From message #${from}`;
  }
  if (typeof through === "number") {
    return `Through message #${through}`;
  }
  return undefined;
}

function formatMemoryKind(kind: ConversationMemoryItem["kind"]): string {
  if (kind === "open_question") return "Open question";
  if (kind === "assistant_commitment") return "Assistant commitment";
  if (kind === "user_preference") return "User preference";
  if (kind === "source_claim") return "Source claim";
  return formatEnumLabel(kind);
}

function formatEvidenceRole(role: ConversationMemoryEvidenceRole): string {
  return formatEnumLabel(role);
}

function formatSourceType(type: ConversationSourceRefType): string {
  if (type === "message_context") return "Message context";
  if (type === "message_retrieval") return "Retrieval";
  if (type === "app_context_ref") return "Context ref";
  if (type === "web_result") return "Web result";
  return "Message";
}

function formatEnumLabel(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}...` : id;
}
