"use client";

import { AlertCircle, BookOpen, ExternalLink, Globe, Search } from "lucide-react";
import InlineCitations from "@/components/ui/InlineCitations";
import {
  MarkdownMessage,
  StreamingMarkdownMessage,
} from "@/components/ui/MarkdownMessage";
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

export function MessageRow({ message }: { message: ConversationMessage }) {
  const roleClass = styles[message.role] ?? "";
  const statusClass =
    message.status !== "complete" ? (styles[message.status] ?? "") : "";
  const contexts = message.contexts ?? [];
  const toolCalls = message.tool_calls ?? [];
  let errorLabel = message.error_code;
  if (message.error_code === "E_LLM_INCOMPLETE") {
    errorLabel = "Response stopped before completion.";
  }

  return (
    <div className={`${styles.message} ${roleClass} ${statusClass}`}>
      {message.role === "user" && contexts.length === 1 ? (
        <ReplyBar context={contexts[0]} />
      ) : null}
      {message.role === "user" && contexts.length > 1 ? (
        <InlineCitations contexts={contexts} />
      ) : null}

      {message.role === "assistant" ? (
        <>
          <ToolActivity toolCalls={toolCalls} />
          {message.status === "pending" ? (
            <StreamingMarkdownMessage content={message.content} />
          ) : (
            <ClaimEvidenceMessage message={message} />
          )}
        </>
      ) : (
        <span>{message.content || (message.status === "pending" ? "..." : "")}</span>
      )}

      {message.status === "error" && errorLabel ? (
        <span className={styles.messageError}>
          <AlertCircle size={14} />
          {errorLabel}
          {message.error_code !== errorLabel ? (
            <span className={styles.errorCode}> {message.error_code}</span>
          ) : null}
        </span>
      ) : null}

      <span className={styles.timestamp}>{formatTime(message.created_at)}</span>
    </div>
  );
}

function ClaimEvidenceMessage({ message }: { message: ConversationMessage }) {
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
}: {
  claim: MessageClaim;
  claimNumber: number;
  domId: string;
  evidence: MessageClaimEvidence[];
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
              <EvidenceItem key={item.id} evidence={item} />
            ))}
          </div>
        );
      })}
    </article>
  );
}

function EvidenceItem({ evidence }: { evidence: MessageClaimEvidence }) {
  const isWeb = isWebEvidence(evidence);
  const href = evidenceHref(evidence);
  const label = evidenceLabel(evidence, isWeb);
  const location = evidence.locator ? locatorLabel(evidence.locator) : null;

  return (
    <div
      className={`${styles.evidenceItem} ${
        isWeb ? styles.webEvidence : styles.appEvidence
      }`}
    >
      <div className={styles.evidenceSource}>
        {isWeb ? <Globe size={14} /> : <BookOpen size={14} />}
        {href ? (
          <a
            href={href}
            target={isWeb ? "_blank" : undefined}
            rel={isWeb ? "noreferrer" : undefined}
          >
            <span>{label}</span>
            <ExternalLink size={12} />
          </a>
        ) : (
          <span>{label}</span>
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
        {location ? <span>{location}</span> : null}
      </div>
    </div>
  );
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

function evidenceHref(evidence: MessageClaimEvidence): string | null {
  if (evidence.deep_link) return evidence.deep_link;
  if (evidence.locator?.type === "web_url") return evidence.locator.url;
  if (evidence.locator?.type === "external_source") return evidence.locator.url ?? null;
  return null;
}

function evidenceLabel(
  evidence: MessageClaimEvidence,
  isWeb: boolean,
): string {
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
  const text = context.exact || context.preview;
  const colorClass = styles[`replyBar-${context.color ?? ""}`] ?? "";

  return (
    <div className={`${styles.replyBar} ${colorClass}`}>
      {text ? <div>{truncateText(text, 140)}</div> : null}
      {context.annotation_body ? (
        <div className={styles.replyBarAnnotation}>{context.annotation_body}</div>
      ) : null}
      {!text && !context.annotation_body && context.media_title ? (
        <div>{context.media_title}</div>
      ) : null}
    </div>
  );
}
