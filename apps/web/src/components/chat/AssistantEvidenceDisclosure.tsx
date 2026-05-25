"use client";

import {
  useId,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import {
  BookOpen,
  ChevronDown,
  ExternalLink,
  Globe,
  Search,
} from "lucide-react";
import {
  MarkdownMessage,
  type ReaderCitationRange,
} from "@/components/ui/MarkdownMessage";
import type {
  ReaderCitationColor,
  ReaderCitationPreview,
} from "@/components/ui/ReaderCitation";
import Button from "@/components/ui/Button";
import {
  isMediaRetrievalLocator,
  isRetrievalLocator,
} from "@/lib/api/sse/locators";
import { apiFetch } from "@/lib/api/client";
import { SEARCH_TYPE_ICON } from "@/lib/search/searchTypeIcon";
import { useLazyFetchOnOpen } from "@/lib/useLazyFetchOnOpen";
import type {
  AssistantVerifierRun,
  ConversationMessage,
  MessageCitationAudit,
  MessageClaim,
  MessageClaimEvidence,
  MessageClaimSupportStatus,
  MessageEvidenceLocator,
  MessageEvidenceRole,
  MessageEvidenceSummary,
  MessageRerankLedger,
  MessageRetrieval,
  MessageRetrievalCandidateLedger,
  MessageSourceManifestDelta,
} from "@/lib/conversations/types";
import type { ReaderSourceTarget } from "./MessageRow";
import styles from "./MessageRow.module.css";

export default function AssistantEvidenceDisclosure({
  message,
  answerRef,
  onActivateTarget,
  onAskAboutSource,
  onSaveSourceQuote,
  hasReaderActivator,
}: {
  message: ConversationMessage;
  answerRef?: Ref<HTMLDivElement>;
  onActivateTarget: (target: ReaderSourceTarget) => void;
  onAskAboutSource?: (target: ReaderSourceTarget) => void;
  onSaveSourceQuote?: (target: ReaderSourceTarget) => void;
  hasReaderActivator: boolean;
}) {
  const documentClaims = messageDocumentClaims(message);
  const claims = [...documentClaims].sort((a, b) => a.ordinal - b.ordinal);
  const summary = messageDocumentVerificationSummary(message);
  const citationAudit = messageDocumentCitationAudit(message);
  const [open, setOpen] = useState(
    claims.some((claim) => claim.support_status !== "supported") ||
      Boolean(summary && summary.support_status !== "supported") ||
      Boolean(citationAudit && citationAuditHasIssue(citationAudit)),
  );
  const panelId = useId();
  const claimEvidence = [...messageDocumentClaimEvidence(message)].sort(
    (a, b) => a.ordinal - b.ordinal,
  );
  const visibleClaims = claims;
  const hasEvidence =
    Boolean(summary) ||
    Boolean(citationAudit) ||
    visibleClaims.length > 0 ||
    claimEvidence.length > 0;
  const retrievals = messageDocumentRetrievals(message);
  const hasRetrievals = retrievals.length > 0;
  const manifestDeltas = messageDocumentSourceManifests(message);
  const hasManifest = manifestDeltas.length > 0;
  const answerContent = messageDocumentText(message);

  if (!hasEvidence && !hasRetrievals && !hasManifest) {
    return (
      <div ref={answerRef} className={styles.assistantBody}>
        <MarkdownMessage content={answerContent} />
      </div>
    );
  }

  const citations = buildClaimCitations(visibleClaims, claimEvidence);
  const renderedCitations = citations.list.map((entry) => {
    const target = hasReaderActivator ? entry.target : null;
    return {
      ...entry,
      target,
      href: target ? null : entry.href,
    };
  });
  const renderedCitationByIndex = new Map(
    renderedCitations.map((entry) => [entry.index, entry]),
  );
  const citationRanges = buildCitationRanges(
    answerContent,
    visibleClaims,
    citations.byClaimId,
    renderedCitationByIndex,
  );
  const missingCitationOffsets = claimsWithMissingCitationOffsets(
    answerContent,
    visibleClaims,
    citations.byClaimId,
  );

  return (
    <>
      <AssistantSourceManifest
        messageId={message.id}
        manifestDeltas={manifestDeltas}
      />
      <AssistantRetrievalResults
        retrievals={retrievals}
        onActivateTarget={onActivateTarget}
        onAskAboutSource={onAskAboutSource}
        onSaveSourceQuote={onSaveSourceQuote}
        hasReaderActivator={hasReaderActivator}
      />
      <div
        ref={answerRef}
        className={`${styles.assistantBody} ${styles.claimAnswer}`}
      >
        <MarkdownMessage
          content={answerContent}
          citationRanges={citationRanges}
          onCitationActivate={onActivateTarget}
          onAskAboutSource={onAskAboutSource}
          onSaveSourceQuote={onSaveSourceQuote}
        />
      </div>
      {hasEvidence ? (
        <section
          className={styles.evidenceDisclosure}
          aria-label="Claim evidence"
        >
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
              <span>
                {supportStatusLabel(
                  summary?.support_status ?? aggregateSupport(visibleClaims),
                )}
              </span>
              <span>{supportedClaimLabel(summary, visibleClaims)}</span>
              {unsupportedClaimLabel(summary, visibleClaims)}
              {citationAudit ? (
                <span>{citationAuditStatusLabel(citationAudit)}</span>
              ) : null}
              <span>{sourceCountLabel(claimEvidence)}</span>
            </span>
          </Button>
          {open ? (
            <div id={panelId} className={styles.claimEvidencePanel}>
              {summary ? <EvidenceSummary summary={summary} /> : null}
              {summary ? <VerifierRunLedger messageId={message.id} /> : null}
              {citationAudit ? (
                <CitationAuditSummary audit={citationAudit} />
              ) : null}
              {missingCitationOffsets.length > 0 ? (
                <div className={styles.evidenceSummary}>
                  <div className={styles.evidenceSummaryTitle}>
                    Citation placement
                  </div>
                  <div className={styles.evidenceFacts}>
                    <span>
                      {missingCitationOffsets.length} supported claims need
                      answer offsets
                    </span>
                  </div>
                </div>
              ) : null}
              {visibleClaims.map((claim, index) => (
                <ClaimEvidenceCard
                  key={claim.id}
                  claim={claim}
                  claimNumber={index + 1}
                  evidence={claimEvidence.filter(
                    (item) => item.claim_id === claim.id,
                  )}
                  onActivateTarget={onActivateTarget}
                  onAskAboutSource={onAskAboutSource}
                  onSaveSourceQuote={onSaveSourceQuote}
                  hasReaderActivator={hasReaderActivator}
                />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </>
  );
}

function messageDocumentText(message: ConversationMessage): string {
  const blocks = message.message_document?.blocks ?? [];
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");
}

function messageDocumentSourceManifests(
  message: ConversationMessage,
): MessageSourceManifestDelta[] {
  return (message.message_document?.blocks ?? []).flatMap((block) => {
    if (
      block.type !== "source_manifest" ||
      !["pending", "running", "complete", "error", "cancelled"].includes(
        block.status,
      )
    ) {
      return [];
    }
    return [block as MessageSourceManifestDelta];
  });
}

function messageDocumentRetrievals(
  message: ConversationMessage,
): MessageRetrieval[] {
  return (message.message_document?.blocks ?? []).flatMap((block) =>
    block.type === "retrieval_result" ? [block] : [],
  );
}

function messageDocumentVerificationSummary(
  message: ConversationMessage,
): MessageEvidenceSummary | null {
  return (
    (message.message_document?.blocks ?? []).find(
      (
        block,
      ): block is MessageEvidenceSummary & { type: "verification_summary" } =>
        block.type === "verification_summary",
    ) ?? null
  );
}

function messageDocumentCitationAudit(
  message: ConversationMessage,
): MessageCitationAudit | null {
  return (
    (message.message_document?.blocks ?? []).find(
      (block): block is MessageCitationAudit & { type: "citation_audit" } =>
        block.type === "citation_audit",
    ) ?? null
  );
}

function messageDocumentClaims(message: ConversationMessage): MessageClaim[] {
  const claims = new Map<string, MessageClaim>();
  for (const block of message.message_document?.blocks ?? []) {
    if (block.type !== "claim") continue;
    claims.set(block.claim_id, {
      id: block.claim_id,
      message_id: block.message_id ?? message.id,
      ordinal: block.ordinal,
      claim_text: block.claim_text,
      answer_start_offset: block.answer_start_offset ?? null,
      answer_end_offset: block.answer_end_offset ?? null,
      claim_kind: block.claim_kind ?? "answer",
      support_status: block.support_status,
      unsupported_reason: block.unsupported_reason ?? null,
      confidence: block.confidence ?? null,
      verifier_status: block.verifier_status,
      created_at: block.created_at ?? "",
    });
  }
  return [...claims.values()];
}

function messageDocumentClaimEvidence(
  message: ConversationMessage,
): MessageClaimEvidence[] {
  const evidence = new Map<string, MessageClaimEvidence>();
  for (const block of message.message_document?.blocks ?? []) {
    if (block.type === "claim_evidence") {
      evidence.set(block.id, block);
    }
  }
  return [...evidence.values()];
}

function AssistantSourceManifest({
  messageId,
  manifestDeltas,
}: {
  messageId: string;
  manifestDeltas: MessageSourceManifestDelta[];
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  const searchedTypes = [
    ...new Set(manifestDeltas.flatMap((delta) => delta.requested_types ?? [])),
  ];
  const manifestSelectedCount = manifestDeltas.reduce(
    (sum, delta) => sum + delta.selected_count,
    0,
  );
  const manifestResultCount = manifestDeltas.reduce(
    (sum, delta) => sum + delta.result_count,
    0,
  );
  const latency = manifestDeltas
    .map((delta) => delta.latency_ms)
    .filter((value): value is number => typeof value === "number");
  const manifestRows = manifestDeltas;
  const totalSelected = manifestSelectedCount;
  const totalResults = manifestResultCount;
  const ledgerSignature = manifestRows
    .map(
      (row) =>
        `${row.tool_call_id ?? row.tool_call_index}:${row.status}:${row.candidate_count}:${row.result_count}:${row.selected_count}:${row.included_in_prompt_count}:${row.excluded_by_budget_count}:${row.excluded_by_scope_count}`,
    )
    .join("|");

  const ledgers = useLazyFetchOnOpen<{
    candidate: MessageRetrievalCandidateLedger[];
    rerank: MessageRerankLedger[];
  }>({
    open,
    cacheKey: `${messageId}|${ledgerSignature}`,
    load: async () => {
      const [candidateResponse, rerankResponse] = await Promise.all([
        apiFetch<{ data: MessageRetrievalCandidateLedger[] }>(
          `/api/messages/${messageId}/retrieval-candidate-ledgers`,
        ),
        apiFetch<{ data: MessageRerankLedger[] }>(
          `/api/messages/${messageId}/rerank-ledgers`,
        ),
      ]);
      return {
        candidate: candidateResponse.data,
        rerank: rerankResponse.data,
      };
    },
    errorMessage: "Audit ledger is unavailable.",
  });
  const candidateLedgers = ledgers.data?.candidate ?? [];
  const rerankLedgers = ledgers.data?.rerank ?? [];
  const ledgersLoaded = ledgers.loaded;
  const ledgersLoading = ledgers.loading;
  const ledgerError = ledgers.error;

  if (manifestRows.length === 0) {
    return null;
  }

  return (
    <section className={styles.sourceManifest} aria-label="Source manifest">
      <Button
        variant="ghost"
        size="sm"
        className={styles.sourceManifestButton}
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
        <span className={styles.sourceManifestSummary}>
          <span className={styles.sourceManifestTitle}>
            <Search size={14} aria-hidden="true" />
            <span>Sources searched</span>
          </span>
          <span className={styles.evidenceFacts}>
            {manifestRows.map((row) => (
              <span
                key={
                  row.tool_call_id ?? `${row.tool_name}-${row.tool_call_index}`
                }
              >
                {row.tool_name === "web_search"
                  ? "web"
                  : (row.scope ?? "library")}
              </span>
            ))}
            {searchedTypes.length > 0 ? (
              <span>{searchedTypes.join(", ")}</span>
            ) : null}
            <span>
              {totalSelected}/{totalResults} selected
            </span>
            {manifestRows.some((row) => row.candidate_count !== undefined) ? (
              <span>
                {manifestRows.reduce(
                  (sum, row) => sum + (row.candidate_count ?? 0),
                  0,
                )}{" "}
                candidates
              </span>
            ) : null}
            {manifestRows.some(
              (row) => row.included_in_prompt_count !== undefined,
            ) ? (
              <span>
                {manifestRows.reduce(
                  (sum, row) => sum + (row.included_in_prompt_count ?? 0),
                  0,
                )}{" "}
                in prompt
              </span>
            ) : null}
            {manifestRows.some((row) => row.excluded_by_budget_count) ? (
              <span>
                {manifestRows.reduce(
                  (sum, row) => sum + (row.excluded_by_budget_count ?? 0),
                  0,
                )}{" "}
                budget-excluded
              </span>
            ) : null}
            {manifestRows.some((row) => row.excluded_by_scope_count) ? (
              <span>
                {manifestRows.reduce(
                  (sum, row) => sum + (row.excluded_by_scope_count ?? 0),
                  0,
                )}{" "}
                scope-excluded
              </span>
            ) : null}
            {manifestRows.some(
              (row) => row.stale_count || row.unreadable_count,
            ) ? (
              <span>
                {manifestRows.reduce(
                  (sum, row) => sum + (row.stale_count ?? 0),
                  0,
                )}{" "}
                stale,{" "}
                {manifestRows.reduce(
                  (sum, row) => sum + (row.unreadable_count ?? 0),
                  0,
                )}{" "}
                unreadable
              </span>
            ) : null}
            {manifestRows.some((row) => row.web_search_mode) ? (
              <span>
                web{" "}
                {manifestRows
                  .map((row) => row.web_search_mode)
                  .filter(Boolean)
                  .join(", ")}
              </span>
            ) : null}
            {manifestRows.some((row) => row.query_hash) ? (
              <span>query hashed</span>
            ) : null}
            {manifestRows.some((row) => row.status !== "complete") ? (
              <span>{manifestRows.map((row) => row.status).join(", ")}</span>
            ) : null}
            {latency.length > 0 ? <span>{Math.max(...latency)} ms</span> : null}
          </span>
        </span>
      </Button>
      {open ? (
        <div id={panelId} className={styles.sourceManifestRows}>
          {manifestRows.map((row) => (
            <div
              key={
                row.tool_call_id ??
                `${row.tool_name}-${row.tool_call_index}-details`
              }
              className={styles.sourceManifestRow}
            >
              <div className={styles.sourceManifestRowHeader}>
                <span>
                  {row.tool_name === "web_search" ? "Web search" : "App search"}
                </span>
                <span>{row.status}</span>
              </div>
              <div className={styles.evidenceFacts}>
                <span>
                  {row.scope ??
                    (row.tool_name === "web_search" ? "public_web" : "library")}
                </span>
                {row.requested_types && row.requested_types.length > 0 ? (
                  <span>{row.requested_types.join(", ")}</span>
                ) : null}
                <span>
                  {row.selected_count}/{row.result_count} selected
                </span>
                {row.candidate_count !== undefined ? (
                  <span>{row.candidate_count} candidates</span>
                ) : null}
                {row.included_in_prompt_count !== undefined ? (
                  <span>{row.included_in_prompt_count} in prompt</span>
                ) : null}
                {row.excluded_by_budget_count ? (
                  <span>{row.excluded_by_budget_count} budget-excluded</span>
                ) : null}
                {row.excluded_by_scope_count ? (
                  <span>{row.excluded_by_scope_count} scope-excluded</span>
                ) : null}
                {row.stale_count ? <span>{row.stale_count} stale</span> : null}
                {row.unreadable_count ? (
                  <span>{row.unreadable_count} unreadable</span>
                ) : null}
                {row.web_search_mode ? (
                  <span>web {row.web_search_mode}</span>
                ) : null}
                {row.query_hash ? <span>query hashed</span> : null}
                {row.index_versions.length > 0 ? (
                  <span>{row.index_versions.join(", ")}</span>
                ) : null}
                {row.latency_ms !== null && row.latency_ms !== undefined ? (
                  <span>{row.latency_ms} ms</span>
                ) : null}
              </div>
              {row.filters && recordEntries(row.filters).length > 0 ? (
                <div className={styles.evidenceFacts}>
                  {recordEntries(row.filters).map(([key, value]) => (
                    <span key={key}>
                      {key}: {value}
                    </span>
                  ))}
                </div>
              ) : null}
              <SourceManifestAuditLedger
                toolCallId={row.tool_call_id ?? null}
                candidateLedgers={candidateLedgers}
                rerankLedgers={rerankLedgers}
                loading={ledgersLoading}
                error={ledgerError}
                loaded={ledgersLoaded}
              />
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function SourceManifestAuditLedger({
  toolCallId,
  candidateLedgers,
  rerankLedgers,
  loading,
  error,
  loaded,
}: {
  toolCallId: string | null;
  candidateLedgers: MessageRetrievalCandidateLedger[];
  rerankLedgers: MessageRerankLedger[];
  loading: boolean;
  error: string | null;
  loaded: boolean;
}) {
  if (!toolCallId) return null;

  const candidates = candidateLedgers.filter(
    (candidate) => candidate.tool_call_id === toolCallId,
  );
  const reranks = rerankLedgers.filter(
    (rerank) => rerank.tool_call_id === toolCallId,
  );

  return (
    <div className={styles.sourceManifestFilters}>
      <div className={styles.sourceManifestRowHeader}>
        <span>Audit ledger</span>
        {loading ? <span>loading</span> : null}
        {error ? <span>unavailable</span> : null}
        {loaded && !loading && !error ? (
          <span>
            {candidates.length} candidates, {reranks.length} rerank passes
          </span>
        ) : null}
      </div>
      {error ? <div>{error}</div> : null}
      {reranks.map((rerank) => (
        <div key={rerank.id} className={styles.evidenceFacts}>
          <span>{rerank.strategy}</span>
          <span>{rerank.status}</span>
          <span>
            {rerank.selected_count}/{rerank.input_count} selected
          </span>
          <span>{rerank.selected_chars} chars</span>
          {typeof rerank.budget_chars === "number" ? (
            <span>{rerank.budget_chars} budget</span>
          ) : null}
        </div>
      ))}
      {candidates.map((candidate) => (
        <div key={candidate.id} className={styles.evidenceFacts}>
          <span>
            {textField(candidate.result_ref, "title") || candidate.source_id}
          </span>
          <span>{candidate.result_type.replace(/_/g, " ")}</span>
          <span>{candidate.selected ? "selected" : "not selected"}</span>
          <span>
            {candidate.included_in_prompt ? "in prompt" : "not in prompt"}
          </span>
          <span>{candidate.selection_status}</span>
          <span>{candidate.selection_reason.replace(/_/g, " ")}</span>
          {candidate.included_in_prompt_reconciled ? null : (
            <strong>prompt mismatch</strong>
          )}
          {candidate.source_version ? (
            <span>{candidate.source_version}</span>
          ) : null}
          {typeof candidate.score === "number" ? (
            <span>score {candidate.score.toFixed(2)}</span>
          ) : null}
        </div>
      ))}
      {loaded &&
      !loading &&
      !error &&
      candidates.length === 0 &&
      reranks.length === 0 ? (
        <div>No audit ledger rows for this tool call.</div>
      ) : null}
    </div>
  );
}

function AssistantRetrievalResults({
  retrievals,
  onActivateTarget,
  onAskAboutSource,
  onSaveSourceQuote,
  hasReaderActivator,
}: {
  retrievals: MessageRetrieval[];
  onActivateTarget: (target: ReaderSourceTarget) => void;
  onAskAboutSource?: (target: ReaderSourceTarget) => void;
  onSaveSourceQuote?: (target: ReaderSourceTarget) => void;
  hasReaderActivator: boolean;
}) {
  if (retrievals.length === 0) return null;

  return (
    <section className={styles.retrievalResults} aria-label="Retrieved sources">
      {retrievals.map((retrieval) => {
        const target = hasReaderActivator
          ? readerTargetFromRetrieval(retrieval)
          : null;
        const ResultIcon = SEARCH_TYPE_ICON[retrieval.result_type];
        return (
          <article
            key={
              retrieval.id ?? `${retrieval.result_type}-${retrieval.source_id}`
            }
            className={`${styles.retrievalResult} ${
              retrieval.selected ? styles.retrievalResultSelected : ""
            }`}
          >
            <div className={styles.retrievalResultHeader}>
              <ResultIcon size={14} aria-hidden="true" />
              <span>{retrievalTitle(retrieval)}</span>
              {retrieval.selected ? <strong>selected</strong> : null}
            </div>
            {retrievalSnippet(retrieval) ? (
              <blockquote className={styles.evidenceSnippet}>
                {retrievalSnippet(retrieval)}
              </blockquote>
            ) : null}
            <div className={styles.evidenceFacts}>
              <span>{retrieval.result_type.replace(/_/g, " ")}</span>
              {retrieval.section_label ? (
                <span>{retrieval.section_label}</span>
              ) : null}
              {textField(retrieval.result_ref, "media_kind") ? (
                <span>{textField(retrieval.result_ref, "media_kind")}</span>
              ) : null}
              {retrieval.retrieval_status ? (
                <span>{retrievalStatusLabel(retrieval.retrieval_status)}</span>
              ) : null}
              {retrieval.included_in_prompt ? <span>in prompt</span> : null}
              {retrieval.source_version ? (
                <span>{retrieval.source_version}</span>
              ) : null}
              {retrieval.snippet_prefix ? <span>prefix available</span> : null}
              {retrieval.snippet_suffix ? <span>suffix available</span> : null}
              {typeof retrieval.score === "number" ? (
                <span>score {retrieval.score.toFixed(2)}</span>
              ) : null}
              {target ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className={styles.retrievalAction}
                  onClick={() => onActivateTarget(target)}
                >
                  Open source
                </Button>
              ) : retrieval.deep_link ? (
                <a
                  href={retrieval.deep_link}
                  target={
                    retrieval.result_type === "web_result"
                      ? "_blank"
                      : undefined
                  }
                  rel={
                    retrieval.result_type === "web_result"
                      ? "noopener noreferrer"
                      : undefined
                  }
                >
                  Open source
                </a>
              ) : null}
              {target && onAskAboutSource ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className={styles.retrievalAction}
                  onClick={() => onAskAboutSource(target)}
                >
                  Ask about this
                </Button>
              ) : null}
              {target && canSaveQuote(target) && onSaveSourceQuote ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className={styles.retrievalAction}
                  onClick={() => onSaveSourceQuote(target)}
                >
                  Save quote
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                className={styles.retrievalAction}
                onClick={() =>
                  void navigator.clipboard.writeText(
                    retrievalCitationText(retrieval),
                  )
                }
              >
                Copy citation
              </Button>
            </div>
          </article>
        );
      })}
    </section>
  );
}

function buildReaderSourceTarget(input: {
  source: ReaderSourceTarget["source"];
  mediaId: string;
  locator: MessageEvidenceLocator;
  sourceVersion: string;
  status: string;
  label: string;
  snippet?: string | null;
  href?: string | null;
  evidenceSpanId?: string | null;
  evidenceId?: string | null;
  contextId?: string | null;
}): ReaderSourceTarget {
  return {
    source: input.source,
    media_id: input.mediaId,
    locator: input.locator,
    snippet: input.snippet ?? null,
    source_version: input.sourceVersion,
    highlight_behavior: "pulse",
    focus_behavior: "scroll_into_view",
    status: input.status,
    label: input.label,
    href: input.href ?? null,
    evidence_span_id: input.evidenceSpanId ?? null,
    ...(input.evidenceId ? { evidence_id: input.evidenceId } : {}),
    context_id: input.contextId ?? null,
  };
}

function retrievalTitle(retrieval: MessageRetrieval): string {
  const ref = retrieval.result_ref;
  if ("title" in ref && typeof ref.title === "string" && ref.title) {
    return ref.title;
  }
  return (
    retrieval.source_title || retrieval.section_label || retrieval.source_id
  );
}

function retrievalSnippet(retrieval: MessageRetrieval): string | null {
  if (retrieval.exact_snippet) return retrieval.exact_snippet;
  const ref = retrieval.result_ref;
  if ("snippet" in ref && typeof ref.snippet === "string" && ref.snippet) {
    return ref.snippet;
  }
  if ("excerpt" in ref && typeof ref.excerpt === "string" && ref.excerpt) {
    return ref.excerpt;
  }
  return null;
}

function readerTargetFromRetrieval(
  retrieval: MessageRetrieval,
): ReaderSourceTarget | null {
  if (
    retrieval.result_type === "web_result" ||
    !retrieval.media_id ||
    !retrieval.locator ||
    !retrieval.source_version
  ) {
    return null;
  }
  if (!("type" in retrieval.locator)) {
    return null;
  }
  return buildReaderSourceTarget({
    source: "message_retrieval",
    mediaId: retrieval.media_id,
    locator: retrieval.locator,
    sourceVersion: retrieval.source_version,
    status: retrieval.retrieval_status ?? "retrieved",
    label: retrievalTitle(retrieval),
    snippet: retrievalSnippet(retrieval),
    href: retrieval.deep_link,
    evidenceSpanId: retrieval.evidence_span_id ?? null,
    evidenceId: retrieval.id,
    contextId:
      typeof retrieval.context_ref.id === "string"
        ? retrieval.context_ref.id
        : null,
  });
}

function retrievalCitationText(retrieval: MessageRetrieval): string {
  return [
    retrievalTitle(retrieval),
    retrievalSnippet(retrieval),
    retrieval.deep_link,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n");
}

interface ClaimCitationEntry {
  index: number;
  color: ReaderCitationColor;
  preview: ReaderCitationPreview;
  target: ReaderSourceTarget | null;
  href: string | null;
}

function buildClaimCitations(
  claims: MessageClaim[],
  evidence: MessageClaimEvidence[],
): {
  list: ClaimCitationEntry[];
  byClaimId: Map<string, number>;
  byIndex: Map<number, ClaimCitationEntry>;
} {
  const list: ClaimCitationEntry[] = [];
  const byClaimId = new Map<string, number>();
  const byIndex = new Map<number, ClaimCitationEntry>();
  claims.forEach((claim) => {
    if (
      claim.support_status !== "supported" &&
      claim.support_status !== "partially_supported" &&
      claim.support_status !== "contradicted"
    ) {
      return;
    }
    const evidenceRole =
      claim.support_status === "contradicted" ? "contradicts" : "supports";
    const primary = evidence.find(
      (item) =>
        item.claim_id === claim.id && item.evidence_role === evidenceRole,
    );
    if (!primary) return;
    const isWeb = primary ? isWebEvidence(primary) : false;
    const label = primary ? evidenceLabel(primary, isWeb) : claim.claim_text;
    const target = primary ? readerTargetFromEvidence(primary, label) : null;
    const href = primary ? evidenceHref(primary) : null;
    const meta: string[] = [];
    if (primary) {
      meta.push(evidenceRoleLabel(primary.evidence_role));
      meta.push(retrievalStatusLabel(primary.retrieval_status));
    }
    if (
      primary?.locator?.type === "external_url" &&
      primary.locator.display_url
    ) {
      meta.push(primary.locator.display_url);
    } else if (primary?.locator) {
      meta.push(locatorLabel(primary.locator));
    }
    if (typeof primary?.score === "number") {
      meta.push(`score ${primary.score.toFixed(2)}`);
    }
    if (primary?.source_version) {
      meta.push(primary.source_version);
    }
    const citationIndex = list.length + 1;
    const entry: ClaimCitationEntry = {
      index: citationIndex,
      color: "neutral" as ReaderCitationColor,
      preview: {
        title: label,
        excerpt: primary?.exact_snippet ?? undefined,
        meta,
        copyText: primary
          ? citationTextForEvidence(primary, label, meta.join("\n"))
          : undefined,
        saveable: target ? canSaveQuote(target) : false,
      },
      target,
      href,
    };
    list.push(entry);
    byClaimId.set(claim.id, citationIndex);
    byIndex.set(citationIndex, entry);
  });
  return { list, byClaimId, byIndex };
}

function buildCitationRanges(
  content: string,
  claims: MessageClaim[],
  citationIndexByClaimId: Map<string, number>,
  citationByIndex: Map<number, ClaimCitationEntry>,
): ReaderCitationRange[] {
  const ranges: ReaderCitationRange[] = [];
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
    const entry = citationByIndex.get(citationIndex);
    if (!entry) return;
    ranges.push({
      start,
      end,
      citation: entry,
    });
    cursor = end;
  });
  return ranges;
}

function claimsWithMissingCitationOffsets(
  content: string,
  claims: MessageClaim[],
  citationIndexByClaimId: Map<string, number>,
): MessageClaim[] {
  return claims.filter((claim) => {
    if (citationIndexByClaimId.get(claim.id) === undefined) return false;
    const start = claim.answer_start_offset;
    const end = claim.answer_end_offset;
    return (
      typeof start !== "number" ||
      typeof end !== "number" ||
      start < 0 ||
      end <= start ||
      end > content.length
    );
  });
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
        <span>Scope type: {summary.scope_type}</span>
        <span>Support: {supportStatusLabel(summary.support_status)}</span>
        <span>Retrieval: {retrievalStatusLabel(summary.retrieval_status)}</span>
        <span>Verifier: {summary.verifier_status.replaceAll("_", " ")}</span>
        {summary.verifier_run_id ? (
          <span>Verifier run: {summary.verifier_run_id}</span>
        ) : null}
        {summary.prompt_assembly_id ? (
          <span>Prompt assembly: {summary.prompt_assembly_id}</span>
        ) : null}
        <span>Claims checked: {summary.claim_count}</span>
        <span>Needs more evidence: {summary.not_enough_evidence_count}</span>
      </DiagnosticsDisclosure>
    </div>
  );
}

function VerifierRunLedger({ messageId }: { messageId: string }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const {
    data: runs,
    loaded,
    loading,
    error,
  } = useLazyFetchOnOpen<AssistantVerifierRun[]>({
    open,
    cacheKey: messageId,
    load: async () => {
      const response = await apiFetch<{ data: AssistantVerifierRun[] }>(
        `/api/messages/${messageId}/verifier-runs`,
      );
      return response.data;
    },
    errorMessage: "Verifier ledger is unavailable.",
  });
  const runList = runs ?? [];

  return (
    <div className={styles.evidenceSummary}>
      <Button
        variant="ghost"
        size="sm"
        className={styles.diagnosticsButton}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panelId}
      >
        Verifier ledger
      </Button>
      {open ? (
        <div id={panelId}>
          <div className={styles.evidenceFacts}>
            {loading ? <span>loading</span> : null}
            {error ? <span>unavailable</span> : null}
            {loaded && !loading && !error ? (
              <span>{runList.length} runs</span>
            ) : null}
          </div>
          {error ? (
            <div className={styles.sourceManifestFilters}>{error}</div>
          ) : null}
          {runList.map((run) => (
            <DiagnosticsDisclosure
              key={run.id}
              label={`${run.verifier_name} ${run.verifier_status.replaceAll("_", " ")}`}
            >
              <span>Run: {run.id}</span>
              {run.chat_run_id ? (
                <span>Chat run: {run.chat_run_id}</span>
              ) : null}
              {run.prompt_assembly_id ? (
                <span>Prompt assembly: {run.prompt_assembly_id}</span>
              ) : null}
              <span>Version: {run.verifier_version}</span>
              <span>Support: {supportStatusLabel(run.support_status)}</span>
              <span>Claims checked: {run.claim_count}</span>
              <span>Supported: {run.supported_claim_count}</span>
              <span>Unsupported: {run.unsupported_claim_count}</span>
              <span>Needs more evidence: {run.not_enough_evidence_count}</span>
              <span>Created: {new Date(run.created_at).toLocaleString()}</span>
            </DiagnosticsDisclosure>
          ))}
          {loaded && !loading && !error && runList.length === 0 ? (
            <div className={styles.sourceManifestFilters}>
              No verifier runs.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CitationAuditSummary({ audit }: { audit: MessageCitationAudit }) {
  const supportedCount = audit.supported_claim_count;
  const invalidOffsetCount = Math.max(
    supportedCount - audit.supported_claims_with_valid_offsets_count,
    0,
  );
  const missingCitationCount = Math.max(
    supportedCount - audit.supported_claims_with_citation_count,
    0,
  );

  return (
    <section className={styles.evidenceSummary} aria-label="Citation audit">
      <div className={styles.evidenceSummaryTitle}>Citation audit</div>
      <div className={styles.evidenceFacts}>
        <span
          className={
            audit.supported_claims_have_valid_offsets
              ? styles.auditFactOk
              : styles.auditFactIssue
          }
        >
          {supportedCount === 0
            ? "No supported claims"
            : `${audit.supported_claims_with_valid_offsets_count}/${supportedCount} offsets valid`}
        </span>
        <span
          className={
            audit.supported_claims_have_citation_placement
              ? styles.auditFactOk
              : styles.auditFactIssue
          }
        >
          {supportedCount === 0
            ? "No citation placement needed"
            : `${audit.supported_claims_with_citation_count}/${supportedCount} citations placed`}
        </span>
        <span
          className={
            audit.claim_evidence_has_required_locators
              ? styles.auditFactOk
              : styles.auditFactIssue
          }
        >
          {audit.missing_locator_count === 0
            ? "Locators present"
            : `${audit.missing_locator_count} missing ${pluralize("locator", audit.missing_locator_count)}`}
        </span>
        <span
          className={
            audit.claim_evidence_has_source_versions
              ? styles.auditFactOk
              : styles.auditFactIssue
          }
        >
          {audit.missing_source_version_count === 0
            ? "Source versions present"
            : `${audit.missing_source_version_count} missing source ${pluralize(
                "version",
                audit.missing_source_version_count,
              )}`}
        </span>
      </div>
      {citationAuditDetailsCount(audit) > 0 ? (
        <DiagnosticsDisclosure label="Details">
          {invalidOffsetCount > 0 ? (
            <span>
              {invalidOffsetCount} invalid offset{" "}
              {pluralize("claim", invalidOffsetCount)}
            </span>
          ) : null}
          {missingCitationCount > 0 ? (
            <span>
              {missingCitationCount} missing citation{" "}
              {pluralize("claim", missingCitationCount)}
            </span>
          ) : null}
          {audit.missing_locator_count > 0 ? (
            <span>{audit.missing_locator_count} missing locator evidence</span>
          ) : null}
          {audit.missing_source_version_count > 0 ? (
            <span>
              {audit.missing_source_version_count} missing source version
              evidence
            </span>
          ) : null}
          {citationAuditDetailEntries(audit).map(([key, value]) => (
            <span key={key}>
              {key}: {value}
            </span>
          ))}
        </DiagnosticsDisclosure>
      ) : null}
    </section>
  );
}

function ClaimEvidenceCard({
  claim,
  claimNumber,
  evidence,
  onActivateTarget,
  onAskAboutSource,
  onSaveSourceQuote,
  hasReaderActivator,
}: {
  claim: MessageClaim;
  claimNumber: number;
  evidence: MessageClaimEvidence[];
  onActivateTarget: (target: ReaderSourceTarget) => void;
  onAskAboutSource?: (target: ReaderSourceTarget) => void;
  onSaveSourceQuote?: (target: ReaderSourceTarget) => void;
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
            {claim.unsupported_reason ? (
              <span>unsupported_reason: {claim.unsupported_reason}</span>
            ) : null}
            {typeof claim.confidence === "number" ? (
              <span>confidence: {claim.confidence.toFixed(2)}</span>
            ) : null}
            <span>{claimOffsetLabel(claim)}</span>
          </DiagnosticsDisclosure>
        </div>
      </div>
      <blockquote className={styles.claimText}>{claim.claim_text}</blockquote>

      {evidenceRoles.map((role) => {
        const roleEvidence = evidence.filter(
          (item) => item.evidence_role === role,
        );
        if (roleEvidence.length === 0) return null;

        return (
          <div key={role} className={styles.evidenceRoleGroup}>
            <div className={styles.evidenceRoleLabel}>
              {evidenceRoleLabel(role)}
            </div>
            {roleEvidence.map((item) => (
              <EvidenceItem
                key={item.id}
                evidence={item}
                onActivateTarget={onActivateTarget}
                onAskAboutSource={onAskAboutSource}
                onSaveSourceQuote={onSaveSourceQuote}
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
  onAskAboutSource,
  onSaveSourceQuote,
  hasReaderActivator,
}: {
  evidence: MessageClaimEvidence;
  onActivateTarget: (target: ReaderSourceTarget) => void;
  onAskAboutSource?: (target: ReaderSourceTarget) => void;
  onSaveSourceQuote?: (target: ReaderSourceTarget) => void;
  hasReaderActivator: boolean;
}) {
  const isWeb = isWebEvidence(evidence);
  const href = evidenceHref(evidence);
  const label = evidenceLabel(evidence, isWeb);
  const readerTarget =
    !isWeb && hasReaderActivator
      ? readerTargetFromEvidence(evidence, label)
      : null;
  const hasBackendLabel = Boolean(
    evidence.citation_label || textField(evidence.result_ref, "citation_label"),
  );
  const location =
    !hasBackendLabel && evidence.locator
      ? locatorLabel(evidence.locator)
      : null;
  const citationText = citationTextForEvidence(evidence, label, location);

  return (
    <div
      className={`${styles.evidenceItem} ${
        isWeb ? styles.webEvidence : styles.appEvidence
      }`}
    >
      <div className={styles.evidenceSource}>
        {isWeb ? (
          <Globe size={14} aria-hidden="true" />
        ) : (
          <BookOpen size={14} aria-hidden="true" />
        )}
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
        ) : href ? (
          <a
            href={href}
            target={isWeb ? "_blank" : undefined}
            rel={isWeb ? "noreferrer" : undefined}
          >
            <span>{label}</span>
            <ExternalLink size={12} aria-hidden="true" />
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
      {location ? (
        <div className={styles.evidenceLocation}>{location}</div>
      ) : null}

      <DiagnosticsDisclosure label="Details">
        <span>{retrievalStatusLabel(evidence.retrieval_status)}</span>
        {evidence.included_in_prompt ? <span>Used in the answer</span> : null}
        {evidence.source_version ? (
          <span>Source version: {evidence.source_version}</span>
        ) : null}
      </DiagnosticsDisclosure>
      <Button
        variant="ghost"
        size="sm"
        className={styles.diagnosticsButton}
        onClick={() => void navigator.clipboard.writeText(citationText)}
      >
        Copy citation
      </Button>
      {readerTarget && onAskAboutSource ? (
        <Button
          variant="ghost"
          size="sm"
          className={styles.diagnosticsButton}
          onClick={() => onAskAboutSource(readerTarget)}
        >
          Ask about this
        </Button>
      ) : null}
      {readerTarget && canSaveQuote(readerTarget) && onSaveSourceQuote ? (
        <Button
          variant="ghost"
          size="sm"
          className={styles.diagnosticsButton}
          onClick={() => onSaveSourceQuote(readerTarget)}
        >
          Save quote
        </Button>
      ) : null}
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

function citationAuditHasIssue(audit: MessageCitationAudit): boolean {
  return (
    !audit.supported_claims_have_valid_offsets ||
    !audit.supported_claims_have_citation_placement ||
    !audit.claim_evidence_has_required_locators ||
    !audit.claim_evidence_has_source_versions ||
    audit.missing_locator_count > 0 ||
    audit.missing_source_version_count > 0
  );
}

function citationAuditStatusLabel(audit: MessageCitationAudit): string {
  return citationAuditHasIssue(audit)
    ? "Citation audit needs review"
    : "Citation audit passed";
}

function citationAuditDetailsCount(audit: MessageCitationAudit): number {
  const offsetIssues = audit.supported_claims_have_valid_offsets ? 0 : 1;
  const placementIssues = audit.supported_claims_have_citation_placement
    ? 0
    : 1;
  const locatorIssues = audit.missing_locator_count > 0 ? 1 : 0;
  const sourceVersionIssues = audit.missing_source_version_count > 0 ? 1 : 0;
  return (
    offsetIssues +
    placementIssues +
    locatorIssues +
    sourceVersionIssues +
    citationAuditDetailEntries(audit).length
  );
}

function citationAuditDetailEntries(
  audit: MessageCitationAudit,
): Array<[string, string]> {
  return Object.entries(audit.details ?? {})
    .filter(([, value]) => {
      if (Array.isArray(value)) return value.length > 0;
      return value !== null && value !== undefined && value !== "";
    })
    .map(([key, value]) => [key, citationAuditDetailValueLabel(value)]);
}

function citationAuditDetailValueLabel(value: unknown): string {
  if (Array.isArray(value)) {
    return `${value.length} ${pluralize("entry", value.length)}`;
  }
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return "available";
}

function pluralize(word: string, count: number): string {
  if (word === "entry") return count === 1 ? "entry" : "entries";
  return count === 1 ? word : `${word}s`;
}

function recordEntries(
  record: Record<string, unknown>,
): Array<[string, string]> {
  return Object.entries(record)
    .filter(([, value]) => {
      if (Array.isArray(value)) return value.length > 0;
      return value !== null && value !== undefined && value !== "";
    })
    .map(([key, value]) => [key, recordValueLabel(value)]);
}

function recordValueLabel(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => recordValueLabel(item)).join(", ");
  }
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value && typeof value === "object") {
    // justify-type-assertion: value was just narrowed to a non-null,
    // non-array object, which is structurally a Record<string, unknown>.
    return recordEntries(value as Record<string, unknown>)
      .map(([key, nested]) => `${key}: ${nested}`)
      .join(", ");
  }
  return "available";
}

function supportedClaimLabel(
  summary: MessageEvidenceSummary | null | undefined,
  claims: MessageClaim[],
): string {
  if (summary) {
    return `${summary.supported_claim_count}/${summary.claim_count} claims supported`;
  }
  const supported = claims.filter(
    (claim) => claim.support_status === "supported",
  ).length;
  return `${supported}/${claims.length} claims supported`;
}

function claimOffsetLabel(claim: MessageClaim): string {
  if (
    typeof claim.answer_start_offset !== "number" ||
    typeof claim.answer_end_offset !== "number"
  ) {
    return "answer_offsets: missing";
  }
  if (claim.answer_end_offset <= claim.answer_start_offset) {
    return "answer_offsets: invalid";
  }
  return `answer_offsets: ${claim.answer_start_offset}-${claim.answer_end_offset}`;
}

function unsupportedClaimLabel(
  summary: MessageEvidenceSummary | null | undefined,
  claims: MessageClaim[],
): ReactNode {
  const count =
    summary?.unsupported_claim_count ??
    claims.filter((claim) => claim.support_status !== "supported").length;
  return count > 0 ? <span>{count} unsupported</span> : null;
}

function sourceCountLabel(evidence: MessageClaimEvidence[]): string {
  const count = new Set(evidence.map((item) => item.id)).size;
  return `${count} ${count === 1 ? "source" : "sources"}`;
}

function citationTextForEvidence(
  evidence: MessageClaimEvidence,
  label: string,
  location: string | null,
): string {
  return [
    label,
    evidence.exact_snippet ? `"${evidence.exact_snippet}"` : null,
    location,
    evidenceHref(evidence),
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n");
}

function canSaveQuote(target: ReaderSourceTarget): boolean {
  const locator = target.locator;
  if (
    (locator.type === "epub_fragment_offsets" ||
      locator.type === "web_text_offsets") &&
    typeof locator.fragment_id === "string" &&
    typeof locator.start_offset === "number" &&
    typeof locator.end_offset === "number" &&
    locator.end_offset > locator.start_offset
  ) {
    return true;
  }
  return (
    locator.type === "pdf_page_geometry" &&
    typeof locator.page_number === "number" &&
    Array.isArray(locator.quads) &&
    locator.quads.length > 0
  );
}

function retrievalStatusLabel(
  status: MessageEvidenceSummary["retrieval_status"] | undefined,
): string {
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
  if (!isMediaRetrievalLocator(locator)) {
    return null;
  }
  const mediaId = mediaIdFromLocator(locator);
  if (!mediaId) {
    return null;
  }
  if (!evidence.source_version) {
    return null;
  }
  return buildReaderSourceTarget({
    source: "claim_evidence",
    mediaId,
    locator,
    sourceVersion: evidence.source_version,
    status: evidence.retrieval_status,
    label,
    snippet: evidence.exact_snippet ?? null,
    href: evidenceHref(evidence),
    evidenceSpanId: evidence.evidence_span_id ?? null,
    evidenceId: evidence.id,
    contextId: textField(evidence.context_ref, "id"),
  });
}

function mediaIdFromLocator(locator: MessageEvidenceLocator): string | null {
  return isMediaRetrievalLocator(locator) ? locator.media_id : null;
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
    default:
      return status;
  }
}

function locatorLabel(locator: MessageEvidenceLocator): string {
  switch (locator.type) {
    case "web_text_offsets":
      return `Fragment ${locator.fragment_id}, offsets ${locator.start_offset}-${locator.end_offset}`;
    case "epub_fragment_offsets":
      return `Section ${locator.section_id}, fragment ${locator.fragment_id}`;
    case "pdf_page_geometry":
      return `Page ${locator.page_number}`;
    case "transcript_time_range":
      return `Timestamp ${formatMs(locator.t_start_ms)}-${formatMs(locator.t_end_ms)}`;
    case "message_offsets":
      return locator.message_seq ? `Message ${locator.message_seq}` : "Message";
    case "external_url":
      return locator.display_url || locator.url;
    default:
      return "Source";
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
    evidence.locator?.type === "external_url" ||
    Boolean(textField(evidence.result_ref, "url"))
  );
}

function evidenceHref(evidence: MessageClaimEvidence): string | null {
  if (evidence.deep_link) return evidence.deep_link;
  if (evidence.locator?.type === "external_url") return evidence.locator.url;
  return null;
}

function evidenceLabel(evidence: MessageClaimEvidence, isWeb: boolean): string {
  if (evidence.citation_label) return evidence.citation_label;
  const resultCitationLabel = textField(evidence.result_ref, "citation_label");
  if (resultCitationLabel) return resultCitationLabel;
  if (evidence.source_ref.label) return evidence.source_ref.label;
  if (evidence.locator?.type === "external_url") {
    return (
      evidence.locator.title ||
      evidence.locator.display_url ||
      evidence.locator.url
    );
  }
  return (
    textField(evidence.result_ref, "title") ||
    textField(evidence.result_ref, "source_label") ||
    textField(evidence.result_ref, "display_url") ||
    (isWeb ? "Web source" : "App source")
  );
}

function textField(record: unknown, key: string): string | null {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return null;
  }
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : null;
}
