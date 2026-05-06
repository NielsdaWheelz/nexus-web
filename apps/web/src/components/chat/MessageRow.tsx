"use client";

import { BookOpen, ExternalLink, Globe, Search } from "lucide-react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import InlineCitations from "@/components/ui/InlineCitations";
import {
  MarkdownMessage,
  StreamingMarkdownMessage,
} from "@/components/ui/MarkdownMessage";
import Button from "@/components/ui/Button";
import { truncateText } from "@/lib/conversations/display";
import type {
  ConversationMessage,
  MessageClaim,
  MessageClaimEvidence,
  MessageClaimSupportStatus,
  MessageContextSnapshot,
  MessageEvidenceLocator,
  MessageEvidenceRole,
  MessageEvidenceSummary,
  MessageToolCall,
} from "@/lib/conversations/types";
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

export function MessageRow({ message, onReaderSourceActivate }: MessageRowProps) {
  const roleClass = styles[message.role] ?? "";
  const statusClass =
    message.status !== "complete" ? (styles[message.status] ?? "") : "";
  const contexts = message.contexts ?? [];
  const toolCalls = message.tool_calls ?? [];
  const errorLabel =
    message.error_code === "E_LLM_INCOMPLETE"
      ? "Response stopped before completion."
      : "The response failed.";

  return (
    <div className={`${styles.message} ${roleClass} ${statusClass}`}>
      {message.role === "user" && contexts.length === 1 ? (
        <ReplyBar context={contexts[0]} />
      ) : null}
      {message.role === "user" && contexts.length > 1 ? (
        <InlineCitations
          contexts={contexts}
          onReaderSourceActivate={onReaderSourceActivate}
        />
      ) : null}

      {message.role === "assistant" ? (
        <>
          <ToolActivity toolCalls={toolCalls} />
          {message.status === "pending" ? (
            message.content ? (
              <StreamingMarkdownMessage content={message.content} />
            ) : (
              <div className={styles.pendingStatus} role="status">
                Generating response...
              </div>
            )
          ) : (
            <ClaimEvidenceMessage
              message={message}
              onReaderSourceActivate={onReaderSourceActivate}
            />
          )}
        </>
      ) : (
        <span>{message.content || (message.status === "pending" ? "..." : "")}</span>
      )}

      {message.status === "error" && errorLabel ? (
        <FeedbackNotice severity="error" title={errorLabel} className={styles.messageFeedback} />
      ) : null}

      <span className={styles.timestamp}>{formatTime(message.created_at)}</span>
    </div>
  );
}

function ClaimEvidenceMessage({
  message,
  onReaderSourceActivate,
}: {
  message: ConversationMessage;
  onReaderSourceActivate?: (target: ReaderSourceTarget) => void;
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
    return <MarkdownMessage content={message.content} />;
  }

  return (
    <>
      <div className={styles.claimAnswer}>
        <MarkdownMessage
          content={contentWithClaimMarkers(message.content, visibleClaims, message.seq)}
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
            domId={claimDomId(message.seq, index)}
            evidence={claimEvidence.filter((item) => item.claim_id === claim.id)}
            onReaderSourceActivate={onReaderSourceActivate}
          />
        ))}
      </section>
    </>
  );
}

function contentWithClaimMarkers(
  content: string,
  claims: MessageClaim[],
  messageSeq: number,
): string {
  let next = "";
  let cursor = 0;

  claims.forEach((claim, index) => {
    const start = claim.answer_start_offset;
    const end = claim.answer_end_offset;
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      start < cursor ||
      end <= start ||
      end > content.length
    ) {
      return;
    }
    next += content.slice(cursor, end);
    next += ` [${index + 1}](#${claimDomId(messageSeq, index)})`;
    cursor = end;
  });

  return next + content.slice(cursor);
}

function claimDomId(messageSeq: number, claimIndex: number): string {
  return `claim-evidence-${messageSeq}-${claimIndex + 1}`;
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
  domId,
  evidence,
  onReaderSourceActivate,
}: {
  claim: MessageClaim;
  claimNumber: number;
  domId: string;
  evidence: MessageClaimEvidence[];
  onReaderSourceActivate?: (target: ReaderSourceTarget) => void;
}) {
  const evidenceRoles: MessageEvidenceRole[] = [
    "supports",
    "contradicts",
    "context",
    "scope_boundary",
  ];

  return (
    <article id={domId} className={styles.claimEvidenceCard}>
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
                onReaderSourceActivate={onReaderSourceActivate}
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
  onReaderSourceActivate,
}: {
  evidence: MessageClaimEvidence;
  onReaderSourceActivate?: (target: ReaderSourceTarget) => void;
}) {
  const isWeb = isWebEvidence(evidence);
  const href = evidenceHref(evidence);
  const label = evidenceLabel(evidence, isWeb);
  const readerTarget =
    !isWeb && onReaderSourceActivate
      ? readerTargetFromEvidence(evidence, label)
      : null;
  const sourceUnavailable =
    Boolean(onReaderSourceActivate) && !isWeb && readerTarget === null;
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
            onClick={() => onReaderSourceActivate?.(readerTarget)}
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
  const resolverStatus = resolverStatusFromEvidence(evidence);
  if (resolverStatus && resolverStatus !== "resolved") {
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
    status: resolverStatus ?? evidence.retrieval_status,
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

export function ReplyBar({ context }: { context: MessageContextSnapshot }) {
  const text = context.exact || context.preview || context.title;
  const colorClass = styles[`replyBar-${context.color ?? ""}`] ?? "";

  return (
    <div className={`${styles.replyBar} ${colorClass}`}>
      {text ? <div>{truncateText(text, 140)}</div> : null}
      {!text && context.media_title ? (
        <div>{context.media_title}</div>
      ) : null}
    </div>
  );
}
