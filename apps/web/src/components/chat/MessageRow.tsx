"use client";

import { useCallback, useRef, useState, type Ref } from "react";
import { BookOpen, ExternalLink, GitBranch, Globe, Search } from "lucide-react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import {
  MarkdownMessage,
  StreamingMarkdownMessage,
} from "@/components/ui/MarkdownMessage";
import ReaderCitation, {
  type ReaderCitationColor,
} from "@/components/ui/ReaderCitation";
import { dispatchReaderPulse } from "@/lib/reader/pulseEvent";
import Button from "@/components/ui/Button";
import {
  assistantSelectionAnchor,
  mapAssistantSelectionToSource,
} from "@/lib/conversations/assistantSelection";
import type {
  BranchDraft,
  ConversationMessage,
  ForkOption,
  MessageClaim,
  MessageClaimEvidence,
  MessageClaimSupportStatus,
  MessageContextSnapshot,
  MessageEvidenceLocator,
  MessageEvidenceRole,
  MessageEvidenceSummary,
  MessageToolCall,
} from "@/lib/conversations/types";
import AssistantSelectionPopover, {
  type AssistantSelectionDraft,
} from "./AssistantSelectionPopover";
import ForkStrip from "./ForkStrip";
import styles from "./MessageRow.module.css";

export type ReaderSourceTargetSource = "message_context" | "claim_evidence";

export interface ReaderSourceTarget {
  source: ReaderSourceTargetSource;
  media_id: string;
  locator: MessageEvidenceLocator | Record<string, unknown>;
  snippet: string | null;
  status: string;
  label?: string;
  href?: string | null;
  evidence_span_id?: string | null;
  evidence_id?: string;
  context_id?: string | null;
}

interface MessageRowProps {
  message: ConversationMessage;
  forkOptions?: ForkOption[];
  switchableLeafIds?: Set<string>;
  onSelectFork?: (fork: ForkOption) => void;
  onReplyToAssistant?: (draft: BranchDraft) => void;
  onReaderSourceActivate?: (target: ReaderSourceTarget) => void;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = Date.now();
  const diffSec = Math.floor((now - d.getTime()) / 1000);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function MessageRow({
  message,
  forkOptions = [],
  switchableLeafIds,
  onSelectFork,
  onReplyToAssistant,
  onReaderSourceActivate,
}: MessageRowProps) {
  const answerRef = useRef<HTMLDivElement>(null);
  const [selectionDraft, setSelectionDraft] =
    useState<AssistantSelectionDraft | null>(null);
  const contexts = message.contexts ?? [];
  const toolCalls = message.tool_calls ?? [];
  const errorLabel =
    message.error_code === "E_LLM_INCOMPLETE"
      ? "Response stopped before completion."
      : "The response failed.";
  const canBranchFromAssistant =
    message.role === "assistant" &&
    message.status === "complete" &&
    Boolean(onReplyToAssistant);

  const activateTarget = useCallback(
    (target: ReaderSourceTarget) => {
      dispatchReaderPulse({
        mediaId: target.media_id,
        locator: target.locator,
        snippet: target.snippet,
      });
      onReaderSourceActivate?.(target);
    },
    [onReaderSourceActivate],
  );

  const createBranchDraft = useCallback(
    (selection?: AssistantSelectionDraft): BranchDraft => ({
      parentMessageId: message.id,
      parentMessageSeq: message.seq,
      parentMessagePreview: message.content,
      anchor: selection
        ? assistantSelectionAnchor({
            messageId: message.id,
            exact: selection.exact,
            prefix: selection.prefix,
            suffix: selection.suffix,
            clientSelectionId: selection.client_selection_id,
            mapping: selection,
          })
        : {
            kind: "assistant_message",
          },
    }),
    [message.content, message.id, message.seq],
  );

  const captureAssistantSelection = useCallback(() => {
    if (!canBranchFromAssistant) return;
    const selection = window.getSelection();
    const container = answerRef.current;
    if (!selection || !container || selection.rangeCount === 0) {
      setSelectionDraft(null);
      return;
    }
    const range = selection.getRangeAt(0);
    if (
      !container.contains(range.startContainer) ||
      !container.contains(range.endContainer) ||
      selection.isCollapsed
    ) {
      setSelectionDraft(null);
      return;
    }

    const exact = selection.toString().trim();
    if (!exact) {
      setSelectionDraft(null);
      return;
    }

    const renderedContext = renderedSelectionContext(container, range);
    const mapping = mapAssistantSelectionToSource(
      message.content,
      container.innerText.trim(),
      exact,
    );
    let prefix = renderedContext.prefix;
    let suffix = renderedContext.suffix;
    if (
      mapping.offset_status === "mapped" &&
      typeof mapping.start_offset === "number" &&
      typeof mapping.end_offset === "number"
    ) {
      prefix = message.content.slice(Math.max(0, mapping.start_offset - 80), mapping.start_offset) || null;
      suffix = message.content.slice(mapping.end_offset, mapping.end_offset + 80) || null;
    }
    const rect = range.getBoundingClientRect();
    const fallbackRect = container.getBoundingClientRect();
    const top = rect.top || fallbackRect.top;
    const left = rect.left || fallbackRect.left;
    const width = rect.width || fallbackRect.width;

    setSelectionDraft({
      exact,
      prefix,
      suffix,
      start_offset: mapping.start_offset,
      end_offset: mapping.end_offset,
      offset_status: mapping.offset_status,
      client_selection_id: crypto.randomUUID(),
      rect: {
        top,
        left: left + width / 2,
      },
    });
  }, [canBranchFromAssistant, message.content]);

  const branchFromSelection = useCallback(() => {
    if (!selectionDraft) return;
    onReplyToAssistant?.(createBranchDraft(selectionDraft));
    setSelectionDraft(null);
    window.getSelection()?.removeAllRanges();
  }, [createBranchDraft, onReplyToAssistant, selectionDraft]);

  if (message.role === "user") {
    return (
      <div
        className={styles.message}
        data-message-id={message.id}
        data-role="user"
      >
        <div className={styles.userAttribution}>You</div>
        {contexts.length === 1 ? (
          <ReaderCitation
            index={1}
            color={citationColorFromContext(contexts[0])}
            preview={citationPreviewFromContext(contexts[0])}
            target={readerTargetFromContext(contexts[0])}
            onActivate={activateTarget}
            ariaLabel="Open citation 1"
          />
        ) : null}
        {contexts.length > 1 ? (
          <span className={styles.citationRow}>
            {contexts.map((context, index) => (
              <ReaderCitation
                key={contextKey(context, index)}
                index={index + 1}
                color={citationColorFromContext(context)}
                preview={citationPreviewFromContext(context)}
                target={readerTargetFromContext(context)}
                onActivate={activateTarget}
                ariaLabel={`Open citation ${index + 1}`}
              />
            ))}
          </span>
        ) : null}
        <span className={styles.userBody}>
          {message.content || (message.status === "pending" ? "..." : "")}
        </span>
        {message.status === "error" && errorLabel ? (
          <FeedbackNotice
            severity="error"
            title={errorLabel}
            className={styles.messageFeedback}
          />
        ) : null}
        <span className={styles.timestamp}>{formatTime(message.created_at)}</span>
      </div>
    );
  }

  if (message.role === "assistant") {
    return (
      <div
        className={styles.message}
        data-message-id={message.id}
        data-role="assistant"
        onMouseUp={captureAssistantSelection}
        onKeyUp={captureAssistantSelection}
      >
        {canBranchFromAssistant ? (
          <div className={styles.messageActions}>
            <Button
              variant="ghost"
              size="sm"
              leadingIcon={<GitBranch size={14} aria-hidden="true" />}
              onClick={() => onReplyToAssistant?.(createBranchDraft())}
            >
              Reply / fork from here
            </Button>
          </div>
        ) : null}
        <ToolActivity toolCalls={toolCalls} />
        {message.status === "pending" ? (
          <div ref={answerRef} className={styles.assistantBody}>
            {message.content ? (
              <StreamingMarkdownMessage content={message.content} />
            ) : (
              <div
                className={styles.streamingCue}
                data-testid="streaming-cue"
                aria-hidden="true"
              />
            )}
          </div>
        ) : (
          <ClaimEvidenceMessage
            message={message}
            answerRef={answerRef}
            onActivateTarget={activateTarget}
            hasReaderActivator={Boolean(onReaderSourceActivate)}
          />
        )}
        {selectionDraft ? (
          <AssistantSelectionPopover
            selection={selectionDraft}
            onBranch={branchFromSelection}
          />
        ) : null}
        {message.status === "error" && errorLabel ? (
          <FeedbackNotice
            severity="error"
            title={errorLabel}
            className={styles.messageFeedback}
          />
        ) : null}
        {onSelectFork ? (
          <ForkStrip
            forks={forkOptions}
            switchableLeafIds={switchableLeafIds}
            onSelectFork={onSelectFork}
          />
        ) : null}
        <span className={styles.timestamp}>{formatTime(message.created_at)}</span>
      </div>
    );
  }

  // System
  return (
    <div className={styles.message} data-message-id={message.id} data-role="system">
      <span className={styles.systemBody}>
        {message.content || (message.status === "pending" ? "..." : "")}
      </span>
      {message.status === "error" && errorLabel ? (
        <FeedbackNotice
          severity="error"
          title={errorLabel}
          className={styles.messageFeedback}
        />
      ) : null}
      <span className={styles.timestamp}>{formatTime(message.created_at)}</span>
    </div>
  );
}

function renderedSelectionContext(container: HTMLElement, range: Range) {
  const before = range.cloneRange();
  before.selectNodeContents(container);
  before.setEnd(range.startContainer, range.startOffset);

  const after = range.cloneRange();
  after.selectNodeContents(container);
  after.setStart(range.endContainer, range.endOffset);

  const prefix = before.toString().slice(-80) || null;
  const suffix = after.toString().slice(0, 80) || null;
  before.detach();
  after.detach();
  return { prefix, suffix };
}

function contextKey(context: MessageContextSnapshot, fallback: number): string {
  if (context.kind === "reader_selection") {
    return `reader-selection-${context.client_context_id ?? fallback}`;
  }
  return `${context.type ?? "ref"}-${context.id ?? fallback}`;
}

function citationColorFromContext(
  context: MessageContextSnapshot,
): ReaderCitationColor {
  switch (context.color) {
    case "yellow":
    case "green":
    case "blue":
    case "pink":
    case "purple":
      return context.color;
    case undefined:
    case null:
      return "neutral";
  }
  return "neutral";
}

function citationPreviewFromContext(context: MessageContextSnapshot) {
  const title = context.title ?? context.media_title;
  const excerpt = context.exact ?? context.preview;
  const meta: string[] = [];
  if (context.media_title && context.media_title !== title) {
    meta.push(context.media_title);
  }
  if (context.route) meta.push(context.route);
  return {
    ...(title ? { title } : {}),
    ...(excerpt ? { excerpt } : {}),
    meta,
  };
}

function readerTargetFromContext(
  context: MessageContextSnapshot,
): ReaderSourceTarget | null {
  if (context.kind !== "reader_selection") return null;
  const mediaId = context.source_media_id ?? context.media_id;
  if (!mediaId || !context.locator || Object.keys(context.locator).length === 0) {
    return null;
  }
  return {
    source: "message_context",
    media_id: mediaId,
    locator: context.locator,
    snippet: context.exact ?? context.preview ?? null,
    status: "attached_context",
    label: context.title ?? context.media_title,
    context_id: context.client_context_id ?? null,
  };
}

function ClaimEvidenceMessage({
  message,
  answerRef,
  onActivateTarget,
  hasReaderActivator,
}: {
  message: ConversationMessage;
  answerRef?: Ref<HTMLDivElement>;
  onActivateTarget: (target: ReaderSourceTarget) => void;
  hasReaderActivator: boolean;
}) {
  const claims = [...(message.claims ?? [])].sort(
    (a, b) => a.ordinal - b.ordinal,
  );
  const claimEvidence = [...(message.claim_evidence ?? [])].sort(
    (a, b) => a.ordinal - b.ordinal,
  );
  const visibleClaims = claims.filter(
    (claim) =>
      claim.support_status !== "not_source_grounded" ||
      claimEvidence.some((evidence) => evidence.claim_id === claim.id),
  );
  const hasEvidence =
    Boolean(message.evidence_summary) ||
    visibleClaims.length > 0 ||
    claimEvidence.length > 0;

  if (!hasEvidence) {
    return (
      <div ref={answerRef} className={styles.assistantBody}>
        <MarkdownMessage content={message.content} />
      </div>
    );
  }

  const citations = buildClaimCitations(visibleClaims, claimEvidence);
  const placeholderContent = insertCitationPlaceholders(
    message.content,
    visibleClaims,
    citations.byClaimId,
  );

  return (
    <>
      <div ref={answerRef} className={`${styles.assistantBody} ${styles.claimAnswer}`}>
        <MarkdownMessage
          content={placeholderContent}
          citations={citations.list.map((entry) => ({
            index: entry.index,
            color: entry.color,
            preview: entry.preview,
            target: entry.target,
          }))}
          onCitationActivate={onActivateTarget}
        />
      </div>
      <section className={styles.claimEvidencePanel} aria-label="Claim evidence">
        {message.evidence_summary ? (
          <EvidenceSummary summary={message.evidence_summary} />
        ) : null}
        {visibleClaims.map((claim, index) => (
          <ClaimEvidenceCard
            key={claim.id}
            claim={claim}
            claimNumber={index + 1}
            evidence={claimEvidence.filter((item) => item.claim_id === claim.id)}
            onActivateTarget={onActivateTarget}
            hasReaderActivator={hasReaderActivator}
          />
        ))}
      </section>
    </>
  );
}

interface ClaimCitationEntry {
  index: number;
  claimId: string;
  color: ReaderCitationColor;
  preview: { title?: string; excerpt?: string; meta?: string[] };
  target: ReaderSourceTarget | null;
}

function buildClaimCitations(
  claims: MessageClaim[],
  evidence: MessageClaimEvidence[],
): { list: ClaimCitationEntry[]; byClaimId: Map<string, number> } {
  const list: ClaimCitationEntry[] = [];
  const byClaimId = new Map<string, number>();
  claims.forEach((claim, position) => {
    const supporting = evidence.find(
      (item) => item.claim_id === claim.id && item.evidence_role === "supports",
    );
    const primary = supporting ?? evidence.find((item) => item.claim_id === claim.id);
    const isWeb = primary ? isWebEvidence(primary) : false;
    const label = primary ? evidenceLabel(primary, isWeb) : claim.claim_text;
    const target = primary ? readerTargetFromEvidence(primary, label) : null;
    const meta: string[] = [];
    if (primary?.locator?.type === "web_url" && primary.locator.display_url) {
      meta.push(primary.locator.display_url);
    } else if (primary?.locator) {
      meta.push(locatorLabel(primary.locator));
    }
    list.push({
      index: position + 1,
      claimId: claim.id,
      color: "neutral",
      preview: {
        title: label,
        excerpt: primary?.exact_snippet ?? undefined,
        meta,
      },
      target,
    });
    byClaimId.set(claim.id, position + 1);
  });
  return { list, byClaimId };
}

function insertCitationPlaceholders(
  content: string,
  claims: MessageClaim[],
  citationIndexByClaimId: Map<string, number>,
): string {
  let next = "";
  let cursor = 0;
  claims.forEach((claim) => {
    const start = claim.answer_start_offset;
    const end = claim.answer_end_offset;
    const citationIndex = citationIndexByClaimId.get(claim.id);
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      start < cursor ||
      end <= start ||
      end > content.length ||
      citationIndex === undefined
    ) {
      return;
    }
    next += content.slice(cursor, end);
    next += `<<cite:${citationIndex}>>`;
    cursor = end;
  });
  return next + content.slice(cursor);
}

function EvidenceSummary({ summary }: { summary: MessageEvidenceSummary }) {
  const scopeTitle =
    textField(summary.scope_ref, "title") ||
    textField(summary.scope_ref, "library_name") ||
    textField(summary.scope_ref, "media_title") ||
    summary.scope_type;

  return (
    <div className={styles.evidenceSummary}>
      <div className={styles.evidenceSummaryTitle}>Evidence summary</div>
      <div className={styles.evidenceBadges}>
        <span>scope: {scopeTitle}</span>
        <span>support_status: {summary.support_status}</span>
        <span>retrieval_status: {summary.retrieval_status}</span>
        <span>verifier_status: {summary.verifier_status}</span>
        <span>
          claims: {summary.supported_claim_count}/{summary.claim_count} supported
        </span>
        {summary.not_enough_evidence_count > 0 ? (
          <span>
            not_enough_evidence_count: {summary.not_enough_evidence_count}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function ClaimEvidenceCard({
  claim,
  claimNumber,
  evidence,
  onActivateTarget,
  hasReaderActivator,
}: {
  claim: MessageClaim;
  claimNumber: number;
  evidence: MessageClaimEvidence[];
  onActivateTarget: (target: ReaderSourceTarget) => void;
  hasReaderActivator: boolean;
}) {
  const evidenceRoles: MessageEvidenceRole[] = [
    "supports",
    "contradicts",
    "context",
    "scope_boundary",
  ];

  return (
    <article className={styles.claimEvidenceCard}>
      <div className={styles.claimHeader}>
        <span className={styles.claimNumber}>{claimNumber}</span>
        <div>
          <div className={styles.claimStatus}>
            {supportStatusLabel(claim.support_status)}
          </div>
          <div className={styles.evidenceBadges}>
            <span>support_status: {claim.support_status}</span>
            <span>verifier_status: {claim.verifier_status}</span>
          </div>
        </div>
      </div>
      <blockquote className={styles.claimText}>{claim.claim_text}</blockquote>

      {evidenceRoles.map((role) => {
        const roleEvidence = evidence.filter((item) => item.evidence_role === role);
        if (roleEvidence.length === 0) return null;

        return (
          <div key={role} className={styles.evidenceRoleGroup}>
            <div className={styles.evidenceRoleLabel}>evidence_role: {role}</div>
            {roleEvidence.map((item) => (
              <EvidenceItem
                key={item.id}
                evidence={item}
                onActivateTarget={onActivateTarget}
                hasReaderActivator={hasReaderActivator}
              />
            ))}
          </div>
        );
      })}
    </article>
  );
}

function EvidenceItem({
  evidence,
  onActivateTarget,
  hasReaderActivator,
}: {
  evidence: MessageClaimEvidence;
  onActivateTarget: (target: ReaderSourceTarget) => void;
  hasReaderActivator: boolean;
}) {
  const isWeb = isWebEvidence(evidence);
  const href = evidenceHref(evidence);
  const label = evidenceLabel(evidence, isWeb);
  const readerTarget =
    !isWeb && hasReaderActivator ? readerTargetFromEvidence(evidence, label) : null;
  const sourceUnavailable =
    hasReaderActivator && !isWeb && readerTarget === null;
  const hasBackendLabel = Boolean(
    evidence.citation_label || textField(evidence.result_ref, "citation_label"),
  );
  const location = !hasBackendLabel && evidence.locator ? locatorLabel(evidence.locator) : null;

  return (
    <div
      className={`${styles.evidenceItem} ${
        isWeb ? styles.webEvidence : styles.appEvidence
      }`}
    >
      <div className={styles.evidenceSource}>
        {isWeb ? <Globe size={14} /> : <BookOpen size={14} />}
        {readerTarget ? (
          <Button
            variant="ghost"
            size="sm"
            className={styles.evidenceSourceButton}
            onClick={() => onActivateTarget(readerTarget)}
            aria-label={`Open source ${label}`}
          >
            <span>{label}</span>
          </Button>
        ) : href && !sourceUnavailable ? (
          <a
            href={href}
            target={isWeb ? "_blank" : undefined}
            rel={isWeb ? "noreferrer" : undefined}
          >
            <span>{label}</span>
            <ExternalLink size={12} />
          </a>
        ) : (
          <span className={sourceUnavailable ? styles.evidenceSourceUnavailable : undefined}>
            {label}
          </span>
        )}
      </div>

      {evidence.exact_snippet ? (
        <blockquote className={styles.evidenceSnippet}>
          {evidence.exact_snippet}
        </blockquote>
      ) : null}

      <div className={styles.evidenceBadges}>
        <span>retrieval_status: {evidence.retrieval_status}</span>
        <span>selected: {String(evidence.selected)}</span>
        <span>included_in_prompt: {String(evidence.included_in_prompt)}</span>
        {evidence.score !== null && evidence.score !== undefined ? (
          <span>score: {evidence.score}</span>
        ) : null}
        {sourceUnavailable ? <span>source_status: unavailable</span> : null}
        {location ? <span>{location}</span> : null}
      </div>
    </div>
  );
}

function readerTargetFromEvidence(
  evidence: MessageClaimEvidence,
  label: string,
): ReaderSourceTarget | null {
  const locator = evidence.locator;
  if (!locator) {
    return null;
  }
  if (!isReaderMediaLocator(locator)) {
    return null;
  }
  const status = resolverStatusFromEvidence(evidence);
  if (status && status !== "resolved") {
    return null;
  }
  const mediaId = mediaIdFromLocator(locator);
  if (!mediaId) {
    return null;
  }
  return {
    source: "claim_evidence",
    media_id: mediaId,
    locator,
    snippet: evidence.exact_snippet ?? null,
    status: status ?? evidence.retrieval_status,
    label,
    href: evidenceHref(evidence),
    evidence_span_id: evidenceSpanIdFromEvidence(evidence),
    evidence_id: evidence.id,
    context_id: textField(evidence.context_ref, "id"),
  };
}

function evidenceSpanIdFromEvidence(evidence: MessageClaimEvidence): string | null {
  const sourceRefEvidenceSpanId = (evidence.source_ref as unknown as Record<string, unknown>)
    .evidence_span_id;
  if (typeof sourceRefEvidenceSpanId === "string" && sourceRefEvidenceSpanId) {
    return sourceRefEvidenceSpanId;
  }
  return (
    evidenceSpanIdFromResolver(evidence.resolver) ??
    evidenceSpanIdFromResolver(evidence.result_ref?.resolver)
  );
}

function evidenceSpanIdFromResolver(resolver: unknown): string | null {
  if (typeof resolver !== "object" || resolver === null || Array.isArray(resolver)) {
    return null;
  }
  const params = (resolver as { params?: unknown }).params;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return null;
  }
  const evidence = (params as { evidence?: unknown }).evidence;
  return typeof evidence === "string" && evidence ? evidence : null;
}

function isReaderMediaLocator(
  locator: MessageEvidenceLocator,
): locator is Extract<
  MessageEvidenceLocator,
  { type: "epub_fragment_offsets" | "pdf_page_geometry" | "transcript_time_range" }
> {
  return (
    locator.type === "epub_fragment_offsets" ||
    locator.type === "pdf_page_geometry" ||
    locator.type === "transcript_time_range"
  );
}

function mediaIdFromLocator(locator: MessageEvidenceLocator): string | null {
  if (
    locator.type === "epub_fragment_offsets" ||
    locator.type === "pdf_page_geometry" ||
    locator.type === "transcript_time_range"
  ) {
    return locator.media_id;
  }
  return null;
}

function resolverStatusFromEvidence(evidence: MessageClaimEvidence): string | null {
  const directStatus = resolverStatus(evidence.resolver);
  if (directStatus) {
    return directStatus;
  }
  const resultResolver = evidence.result_ref?.resolver;
  if (
    typeof resultResolver === "object" &&
    resultResolver !== null &&
    !Array.isArray(resultResolver)
  ) {
    return resolverStatus(resultResolver);
  }
  return null;
}

function resolverStatus(resolver: unknown): string | null {
  if (typeof resolver !== "object" || resolver === null || Array.isArray(resolver)) {
    return null;
  }
  const status = (resolver as { status?: unknown }).status;
  return typeof status === "string" && status ? status : null;
}

function supportStatusLabel(status: MessageClaimSupportStatus): string {
  switch (status) {
    case "supported":
      return "Supported";
    case "partially_supported":
      return "Partially supported";
    case "contradicted":
      return "Contradicted";
    case "not_enough_evidence":
      return "Not enough evidence";
    case "out_of_scope":
      return "Out of scope";
    case "not_source_grounded":
      return "Not source grounded";
  }
}

function locatorLabel(locator: MessageEvidenceLocator): string {
  switch (locator.type) {
    case "epub_fragment_offsets":
      return `section: ${locator.section_id}, fragment: ${locator.fragment_id}, offsets: ${locator.start_offset}-${locator.end_offset}`;
    case "pdf_page_geometry":
      return `page: ${locator.page_number}`;
    case "transcript_time_range":
      return `timestamp: ${formatMs(locator.t_start_ms)}-${formatMs(locator.t_end_ms)}`;
    case "conversation_message":
      return `message: ${locator.message_seq}`;
    case "web_url":
      return `url: ${locator.display_url || locator.url}`;
    case "external_source":
      return `source: ${locator.source_name}`;
  }
}

function formatMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function isWebEvidence(evidence: MessageClaimEvidence): boolean {
  return (
    evidence.source_ref.type === "web_result" ||
    evidence.locator?.type === "web_url" ||
    Boolean(textField(evidence.result_ref, "url"))
  );
}

function evidenceResolverHref(route: string, paramsRecord: Record<string, string>): string {
  const params = new URLSearchParams();
  const evidence = paramsRecord.evidence;
  if (evidence) {
    params.set("evidence", evidence);
  }
  for (const [key, value] of Object.entries(paramsRecord)) {
    if (key !== "evidence") {
      params.set(key, value);
    }
  }
  const query = params.toString();
  return query ? `${route}?${query}` : route;
}

function evidenceHref(evidence: MessageClaimEvidence): string | null {
  if (evidence.deep_link) return evidence.deep_link;
  if (evidence.resolver?.route) {
    return evidenceResolverHref(evidence.resolver.route, evidence.resolver.params);
  }
  const resultResolver = evidence.result_ref?.resolver;
  if (typeof resultResolver === "object" && resultResolver !== null && !Array.isArray(resultResolver)) {
    const resolver = resultResolver as Record<string, unknown>;
    if (
      typeof resolver.route === "string" &&
      typeof resolver.params === "object" &&
      resolver.params !== null &&
      !Array.isArray(resolver.params)
    ) {
      const paramsRecord = resolver.params as Record<string, unknown>;
      if (!Object.values(paramsRecord).every((value) => typeof value === "string")) {
        return null;
      }
      return evidenceResolverHref(resolver.route, paramsRecord as Record<string, string>);
    }
  }
  if (evidence.locator?.type === "web_url") return evidence.locator.url;
  if (evidence.locator?.type === "external_source") return evidence.locator.url ?? null;
  return null;
}

function evidenceLabel(
  evidence: MessageClaimEvidence,
  isWeb: boolean,
): string {
  if (evidence.citation_label) return evidence.citation_label;
  const resultCitationLabel = textField(evidence.result_ref, "citation_label");
  if (resultCitationLabel) return resultCitationLabel;
  if (evidence.source_ref.label) return evidence.source_ref.label;
  if (evidence.locator?.type === "web_url") {
    return evidence.locator.title || evidence.locator.display_url || evidence.locator.url;
  }
  if (evidence.locator?.type === "external_source") {
    return evidence.locator.source_name;
  }
  return (
    textField(evidence.result_ref, "title") ||
    textField(evidence.result_ref, "source_label") ||
    textField(evidence.result_ref, "display_url") ||
    (isWeb ? "Web source" : "App source")
  );
}

function textField(
  record: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === "string" && value ? value : null;
}

function ToolActivity({ toolCalls }: { toolCalls: MessageToolCall[] }) {
  const active = toolCalls.find((toolCall) =>
    ["started", "pending"].includes(toolCall.status),
  );
  if (!active) return null;
  const label = active.tool_name === "web_search" ? "Searching web" : "Searching library";

  return (
    <div className={styles.toolActivity}>
      <Search size={14} />
      <span>{label}</span>
    </div>
  );
}
