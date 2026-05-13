"use client";

import { useId, useState, type ReactNode, type Ref } from "react";
import { BookOpen, ChevronDown, ExternalLink, Globe } from "lucide-react";
import { MarkdownMessage } from "@/components/ui/MarkdownMessage";
import type { ReaderCitationColor } from "@/components/ui/ReaderCitation";
import Button from "@/components/ui/Button";
import type {
  ConversationMessage,
  MessageClaim,
  MessageClaimEvidence,
  MessageClaimSupportStatus,
  MessageEvidenceLocator,
  MessageEvidenceRole,
  MessageEvidenceSummary,
} from "@/lib/conversations/types";
import type { ReaderSourceTarget } from "./MessageRow";
import styles from "./MessageRow.module.css";

export default function AssistantEvidenceDisclosure({
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
  const [open, setOpen] = useState(false);
  const panelId = useId();
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
  const summary = message.evidence_summary;

  return (
    <>
      <div ref={answerRef} className={`${styles.assistantBody} ${styles.claimAnswer}`}>
        <MarkdownMessage
          content={placeholderContent}
          citations={citations.list.map((entry) => {
            const target = hasReaderActivator ? entry.target : null;
            return {
              index: entry.index,
              color: entry.color,
              preview: entry.preview,
              target,
              href: target ? null : entry.href,
            };
          })}
          onCitationActivate={onActivateTarget}
        />
      </div>
      <section className={styles.evidenceDisclosure} aria-label="Claim evidence">
        <Button
          variant="ghost"
          size="sm"
          className={styles.evidenceDisclosureButton}
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={panelId}
          trailingIcon={
            <ChevronDown
              size={14}
              aria-hidden="true"
              className={open ? styles.disclosureChevronOpen : undefined}
            />
          }
        >
          <span className={styles.evidenceDisclosureSummary}>
            <span>Evidence</span>
            <span>{supportStatusLabel(summary?.support_status ?? aggregateSupport(visibleClaims))}</span>
            <span>{supportedClaimLabel(summary, visibleClaims)}</span>
            <span>{sourceCountLabel(claimEvidence)}</span>
          </span>
        </Button>
        {open ? (
          <div id={panelId} className={styles.claimEvidencePanel}>
            {summary ? <EvidenceSummary summary={summary} /> : null}
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
          </div>
        ) : null}
      </section>
    </>
  );
}

interface ClaimCitationEntry {
  index: number;
  color: ReaderCitationColor;
  preview: { title?: string; excerpt?: string; meta?: string[] };
  target: ReaderSourceTarget | null;
  href: string | null;
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
    const resolverStatus = primary ? resolverStatusFromEvidence(primary) : null;
    const unavailable = Boolean(primary && !isWeb && resolverStatus && resolverStatus !== "resolved");
    const target = primary ? readerTargetFromEvidence(primary, label) : null;
    const href = primary && !unavailable ? evidenceHref(primary) : null;
    const meta: string[] = [];
    if (primary?.locator?.type === "web_url" && primary.locator.display_url) {
      meta.push(primary.locator.display_url);
    } else if (primary?.locator) {
      meta.push(locatorLabel(primary.locator));
    }
    list.push({
      index: position + 1,
      color: "neutral",
      preview: {
        title: label,
        excerpt: primary?.exact_snippet ?? undefined,
        meta,
      },
      target,
      href,
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
      <div className={styles.evidenceFacts}>
        <span>Scope: {scopeTitle}</span>
        <span>{supportStatusLabel(summary.support_status)}</span>
        <span>{supportedClaimLabel(summary, [])}</span>
        <span>{retrievalStatusLabel(summary.retrieval_status)}</span>
        {summary.not_enough_evidence_count > 0 ? (
          <span>{summary.not_enough_evidence_count} need more evidence</span>
        ) : null}
      </div>
      <DiagnosticsDisclosure label="Details">
        <span>scope_type: {summary.scope_type}</span>
        <span>support_status: {summary.support_status}</span>
        <span>retrieval_status: {summary.retrieval_status}</span>
        <span>verifier_status: {summary.verifier_status}</span>
        <span>claim_count: {summary.claim_count}</span>
        <span>not_enough_evidence_count: {summary.not_enough_evidence_count}</span>
        {summary.prompt_assembly_id ? (
          <span>prompt_assembly_id: {summary.prompt_assembly_id}</span>
        ) : null}
      </DiagnosticsDisclosure>
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
          <DiagnosticsDisclosure label="Details">
            <span>support_status: {claim.support_status}</span>
            <span>verifier_status: {claim.verifier_status}</span>
            <span>claim_kind: {claim.claim_kind}</span>
          </DiagnosticsDisclosure>
        </div>
      </div>
      <blockquote className={styles.claimText}>{claim.claim_text}</blockquote>

      {evidenceRoles.map((role) => {
        const roleEvidence = evidence.filter((item) => item.evidence_role === role);
        if (roleEvidence.length === 0) return null;

        return (
          <div key={role} className={styles.evidenceRoleGroup}>
            <div className={styles.evidenceRoleLabel}>{evidenceRoleLabel(role)}</div>
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
  const status = resolverStatusFromEvidence(evidence);
  const sourceUnavailable = !isWeb && Boolean(status && status !== "resolved");
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
        {sourceUnavailable ? (
          <span className={styles.sourceUnavailableLabel}>Source unavailable</span>
        ) : null}
      </div>

      {evidence.exact_snippet ? (
        <blockquote className={styles.evidenceSnippet}>
          {evidence.exact_snippet}
        </blockquote>
      ) : null}
      {location ? <div className={styles.evidenceLocation}>{location}</div> : null}

      <DiagnosticsDisclosure label="Details">
        <span>retrieval_status: {evidence.retrieval_status}</span>
        <span>selected: {String(evidence.selected)}</span>
        <span>included_in_prompt: {String(evidence.included_in_prompt)}</span>
        {evidence.score !== null && evidence.score !== undefined ? (
          <span>score: {evidence.score}</span>
        ) : null}
        {sourceUnavailable ? <span>source_status: unavailable</span> : null}
        {evidence.source_version ? (
          <span>source_version: {evidence.source_version}</span>
        ) : null}
      </DiagnosticsDisclosure>
    </div>
  );
}

function DiagnosticsDisclosure({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <div className={styles.diagnosticsDisclosure}>
      <Button
        variant="ghost"
        size="sm"
        className={styles.diagnosticsButton}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panelId}
      >
        {label}
      </Button>
      {open ? (
        <div id={panelId} className={styles.evidenceDiagnostics}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

function aggregateSupport(claims: MessageClaim[]): MessageClaimSupportStatus {
  if (claims.some((claim) => claim.support_status === "contradicted")) {
    return "contradicted";
  }
  if (claims.some((claim) => claim.support_status === "not_enough_evidence")) {
    return "not_enough_evidence";
  }
  if (claims.some((claim) => claim.support_status === "partially_supported")) {
    return "partially_supported";
  }
  if (claims.some((claim) => claim.support_status === "out_of_scope")) {
    return "out_of_scope";
  }
  if (claims.some((claim) => claim.support_status === "supported")) {
    return "supported";
  }
  return "not_source_grounded";
}

function supportedClaimLabel(
  summary: MessageEvidenceSummary | null | undefined,
  claims: MessageClaim[],
): string {
  if (summary) {
    return `${summary.supported_claim_count}/${summary.claim_count} claims supported`;
  }
  const supported = claims.filter((claim) => claim.support_status === "supported").length;
  return `${supported}/${claims.length} claims supported`;
}

function sourceCountLabel(evidence: MessageClaimEvidence[]): string {
  const count = new Set(evidence.map((item) => item.id)).size;
  return `${count} ${count === 1 ? "source" : "sources"}`;
}

function retrievalStatusLabel(status: MessageEvidenceSummary["retrieval_status"] | undefined): string {
  switch (status) {
    case "attached_context":
      return "Attached context";
    case "retrieved":
      return "Retrieved";
    case "selected":
      return "Selected";
    case "included_in_prompt":
      return "Available from prompt";
    case "excluded_by_budget":
      return "Excluded by budget";
    case "excluded_by_scope":
      return "Excluded by scope";
    case "web_result":
      return "Available from web";
    case undefined:
      return "Evidence available";
  }
}

function evidenceRoleLabel(role: MessageEvidenceRole): string {
  switch (role) {
    case "supports":
      return "Supporting sources";
    case "contradicts":
      return "Conflicting sources";
    case "context":
      return "Context";
    case "scope_boundary":
      return "Scope boundary";
  }
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
      return `Section ${locator.section_id}, fragment ${locator.fragment_id}`;
    case "pdf_page_geometry":
      return `Page ${locator.page_number}`;
    case "transcript_time_range":
      return `Timestamp ${formatMs(locator.t_start_ms)}-${formatMs(locator.t_end_ms)}`;
    case "conversation_message":
      return `Message ${locator.message_seq}`;
    case "web_url":
      return locator.display_url || locator.url;
    case "external_source":
      return locator.source_name;
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
