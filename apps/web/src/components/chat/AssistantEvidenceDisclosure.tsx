"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import {
  BookOpen,
  ChevronDown,
  ExternalLink,
  FileText,
  Globe,
  ListTree,
  Search,
  Video,
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
import { isRetrievalLocator, type ContextItem } from "@/lib/api/sse";
import { apiFetch } from "@/lib/api/client";
import type {
  AssistantVerifierRun,
  ChatRunResponse,
  ConversationMessage,
  MessageArtifact,
  MessageArtifactCitationManifest,
  MessageArtifactDelta,
  MessageArtifactExport,
  MessageArtifactExportLedger,
  MessageArtifactFollowUp,
  MessageArtifactPart,
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
import type { ArtifactFocusTarget, ReaderSourceTarget } from "./MessageRow";
import styles from "./MessageRow.module.css";

export default function AssistantEvidenceDisclosure({
  message,
  answerRef,
  onActivateTarget,
  onAskAboutSource,
  onSaveSourceQuote,
  onAttachContext,
  onChatRunCreated,
  artifactFocusTarget,
  hasReaderActivator,
}: {
  message: ConversationMessage;
  answerRef?: Ref<HTMLDivElement>;
  onActivateTarget: (target: ReaderSourceTarget) => void;
  onAskAboutSource?: (target: ReaderSourceTarget) => void;
  onSaveSourceQuote?: (target: ReaderSourceTarget) => void;
  onAttachContext?: (context: ContextItem) => void;
  onChatRunCreated?: (runData: ChatRunResponse["data"]) => void;
  artifactFocusTarget?: ArtifactFocusTarget | null;
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
  const artifacts = messageDocumentArtifacts(message);
  const hasArtifacts = artifacts.length > 0;
  const manifestDeltas = messageDocumentSourceManifests(message);
  const hasManifest = manifestDeltas.length > 0;
  const answerContent = messageDocumentText(message);

  if (!hasEvidence && !hasRetrievals && !hasManifest && !hasArtifacts) {
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
      <AssistantArtifactPreviews
        artifacts={artifacts}
        onActivateTarget={onActivateTarget}
        onAskAboutSource={onAskAboutSource}
        onAttachContext={onAttachContext}
        onChatRunCreated={onChatRunCreated}
        artifactFocusTarget={artifactFocusTarget}
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

function messageDocumentArtifacts(
  message: ConversationMessage,
): Array<MessageArtifactDelta | MessageArtifact> {
  const documentArtifacts = (message.message_document?.blocks ?? []).flatMap(
    (block) => (block.type === "artifact_preview" ? [block] : []),
  );
  const documentKeys = new Set(documentArtifacts.flatMap(artifactIdentityKeys));
  const durableArtifacts = (message.artifacts ?? []).filter(
    (artifact) =>
      !artifactIdentityKeys(artifact).some((key) => documentKeys.has(key)),
  );
  return [...documentArtifacts, ...durableArtifacts];
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
  const [candidateLedgers, setCandidateLedgers] = useState<
    MessageRetrievalCandidateLedger[]
  >([]);
  const [rerankLedgers, setRerankLedgers] = useState<MessageRerankLedger[]>([]);
  const [ledgersLoaded, setLedgersLoaded] = useState(false);
  const [ledgersLoading, setLedgersLoading] = useState(false);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
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

  useEffect(() => {
    setCandidateLedgers([]);
    setRerankLedgers([]);
    setLedgersLoaded(false);
    setLedgerError(null);
  }, [ledgerSignature]);

  useEffect(() => {
    if (!open || ledgersLoaded) return;
    let cancelled = false;
    setLedgersLoading(true);
    setLedgerError(null);
    Promise.all([
      apiFetch<{ data: MessageRetrievalCandidateLedger[] }>(
        `/api/messages/${messageId}/retrieval-candidate-ledgers`,
      ),
      apiFetch<{ data: MessageRerankLedger[] }>(
        `/api/messages/${messageId}/rerank-ledgers`,
      ),
    ])
      .then(([candidateResponse, rerankResponse]) => {
        if (cancelled) return;
        setCandidateLedgers(candidateResponse.data);
        setRerankLedgers(rerankResponse.data);
        setLedgersLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLedgerError("Audit ledger is unavailable.");
      })
      .finally(() => {
        if (!cancelled) setLedgersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ledgersLoaded, messageId, open]);

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
              {retrieval.result_type === "web_result" ? (
                <Globe size={14} aria-hidden="true" />
              ) : retrieval.result_type === "video" ? (
                <Video size={14} aria-hidden="true" />
              ) : retrieval.result_type === "content_chunk" ? (
                <BookOpen size={14} aria-hidden="true" />
              ) : (
                <FileText size={14} aria-hidden="true" />
              )}
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

const ARTIFACT_EXPORT_FORMATS: ReadonlyArray<MessageArtifactExport["format"]> = [
  "markdown",
  "json",
  "html",
  "csv",
  "pdf",
];

function exportFilenameFromContentDisposition(
  header: string | null,
  fallback: string,
): string {
  if (!header) return fallback;
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  if (!match) return fallback;
  return decodeURIComponent(match[1]);
}

function ArtifactExportButton({
  artifactId,
  format,
}: {
  artifactId: string;
  format: MessageArtifactExport["format"];
}) {
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState(false);

  const runExport = useCallback(async () => {
    setExporting(true);
    setError(false);
    try {
      const response = await fetch(
        `/api/artifacts/${artifactId}/export?format=${format}`,
        { method: "POST" },
      );
      if (!response.ok) {
        setError(true);
        return;
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = exportFilenameFromContentDisposition(
        response.headers.get("content-disposition"),
        `${artifactId}.${format}`,
      );
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch {
      setError(true);
    } finally {
      setExporting(false);
    }
  }, [artifactId, format]);

  return (
    <Button
      variant="ghost"
      size="sm"
      className={styles.retrievalAction}
      onClick={() => void runExport()}
      loading={exporting}
    >
      {error ? `Export ${format} failed` : `Export ${format}`}
    </Button>
  );
}

function AssistantArtifactPreviews({
  artifacts,
  onActivateTarget,
  onAskAboutSource,
  onAttachContext,
  onChatRunCreated,
  artifactFocusTarget,
  hasReaderActivator,
}: {
  artifacts: Array<MessageArtifactDelta | MessageArtifact>;
  onActivateTarget: (target: ReaderSourceTarget) => void;
  onAskAboutSource?: (target: ReaderSourceTarget) => void;
  onAttachContext?: (context: ContextItem) => void;
  onChatRunCreated?: (runData: ChatRunResponse["data"]) => void;
  artifactFocusTarget?: ArtifactFocusTarget | null;
  hasReaderActivator: boolean;
}) {
  const [openArtifactId, setOpenArtifactId] = useState<string | null>(null);
  const [openedFocusKey, setOpenedFocusKey] = useState<string | null>(null);
  const focusKey = artifactFocusTarget
    ? `${artifactFocusTarget.artifactId}:${artifactFocusTarget.artifactPartId ?? ""}`
    : null;
  useEffect(() => {
    if (!artifactFocusTarget || !focusKey || openedFocusKey === focusKey)
      return;
    const match = artifacts.find((artifact) =>
      artifactMatchesFocusTarget(artifact, artifactFocusTarget.artifactId),
    );
    const artifactId = match ? artifactIdForCard(match) : null;
    if (!artifactId) return;
    setOpenArtifactId(artifactId);
    setOpenedFocusKey(focusKey);
  }, [artifactFocusTarget, artifacts, focusKey, openedFocusKey]);
  if (artifacts.length === 0) return null;

  return (
    <section
      className={styles.retrievalResults}
      aria-label="Generated artifacts"
    >
      {artifacts.map((artifact, index) => {
        const citedParts = (artifact.parts ?? []).filter(
          artifactPartHasEvidence,
        ).length;
        const artifactId = artifactIdForCard(artifact);
        const focused =
          artifactFocusTarget &&
          artifactMatchesFocusTarget(artifact, artifactFocusTarget.artifactId);
        const open = Boolean(artifactId && openArtifactId === artifactId);
        const previewText = artifactPreviewText(artifact);
        return (
          <article
            key={
              artifactId ??
              artifact.artifact_key ??
              `${artifact.artifact_kind ?? "artifact"}-${index}`
            }
            className={styles.retrievalResult}
          >
            <div className={styles.retrievalResultHeader}>
              <FileText size={14} aria-hidden="true" />
              <span>
                {artifact.title ||
                  artifact.artifact_kind ||
                  "Generated artifact"}
              </span>
              {artifact.status ? <strong>{artifact.status}</strong> : null}
            </div>
            {previewText ? (
              <blockquote className={styles.evidenceSnippet}>
                {previewText}
              </blockquote>
            ) : null}
            <div className={styles.evidenceFacts}>
              <span>{artifact.artifact_kind || "artifact"}</span>
              {citedParts > 0 ? <span>{citedParts} cited parts</span> : null}
              {artifactId ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className={styles.retrievalAction}
                  onClick={() => setOpenArtifactId(open ? null : artifactId)}
                  aria-expanded={open}
                >
                  {open ? "Hide artifact" : "Inspect artifact"}
                </Button>
              ) : null}
              {artifactId
                ? ARTIFACT_EXPORT_FORMATS.map((format) => (
                    <ArtifactExportButton
                      key={format}
                      artifactId={artifactId}
                      format={format}
                    />
                  ))
                : null}
            </div>
            {artifactId && open ? (
              <ArtifactInspector
                artifactId={artifactId}
                fallbackArtifact={artifact}
                onActivateTarget={onActivateTarget}
                onAskAboutSource={onAskAboutSource}
                onAttachContext={onAttachContext}
                onChatRunCreated={onChatRunCreated}
                focusPartId={
                  focused ? artifactFocusTarget.artifactPartId : null
                }
                focusKey={focused ? focusKey : null}
                hasReaderActivator={hasReaderActivator}
              />
            ) : null}
          </article>
        );
      })}
    </section>
  );
}

function artifactIdForCard(
  artifact: MessageArtifactDelta | MessageArtifact,
): string | null {
  if (isDurableArtifact(artifact)) return artifact.id;
  return artifact.durable_artifact_id ?? null;
}

function artifactIdentityKeys(
  artifact: MessageArtifactDelta | MessageArtifact,
): string[] {
  const keys: string[] = [];
  if (isDurableArtifact(artifact)) {
    keys.push(`id:${artifact.id}`);
    keys.push(`key:${artifact.artifact_key}:v${artifact.artifact_version}`);
    return keys;
  }
  if (artifact.durable_artifact_id)
    keys.push(`id:${artifact.durable_artifact_id}`);
  if (artifact.artifact_id) keys.push(`id:${artifact.artifact_id}`);
  if (artifact.artifact_key && artifact.artifact_version) {
    keys.push(`key:${artifact.artifact_key}:v${artifact.artifact_version}`);
  }
  return keys;
}

function artifactMatchesFocusTarget(
  artifact: MessageArtifactDelta | MessageArtifact,
  artifactId: string,
): boolean {
  return (
    artifactIdForCard(artifact) === artifactId ||
    ("artifact_id" in artifact && artifact.artifact_id === artifactId)
  );
}

function artifactPreviewText(
  artifact: MessageArtifactDelta | MessageArtifact,
): string | null {
  if (isDurableArtifact(artifact)) return artifact.preview_text ?? null;
  return artifact.delta ?? null;
}

function isDurableArtifact(
  artifact: MessageArtifactDelta | MessageArtifact,
): artifact is MessageArtifact {
  return (
    "id" in artifact &&
    typeof artifact.id === "string" &&
    "conversation_id" in artifact
  );
}

function artifactManifest(
  artifact: MessageArtifact,
): MessageArtifactCitationManifest {
  return {
    artifact_id: artifact.id,
    message_id: artifact.message_id,
    conversation_id: artifact.conversation_id,
    entries: artifact.parts.map((part, index) => ({
      artifact_part_id: part.id ?? "",
      ordinal: part.ordinal ?? index,
      part_key: part.part_key,
      part_type: part.part_type,
      source_version: part.source_version,
      locator: part.locator,
      source_ref: part.source_ref,
      context_ref: part.context_ref,
      result_ref: part.result_ref,
      evidence_span_id: part.evidence_span_id,
      evidence_span_ids: part.evidence_span_ids,
      source_refs: part.source_refs,
      metadata: part.metadata,
    })),
  };
}

function ArtifactManifestEntryRow({
  entry,
}: {
  entry: MessageArtifactCitationManifest["entries"][number];
}) {
  const evidenceSpanIds = [
    ...(entry.evidence_span_id ? [entry.evidence_span_id] : []),
    ...(entry.evidence_span_ids ?? []),
  ];
  const sourceRefs = [
    ...(entry.source_ref ? [entry.source_ref] : []),
    ...(entry.source_refs ?? []),
  ];
  return (
    <div className={styles.sourceManifestRow}>
      <div className={styles.sourceManifestRowHeader}>
        <span>
          {entry.part_key || entry.part_type || `Part ${entry.ordinal + 1}`}
        </span>
        {entry.part_type && entry.part_key ? (
          <span>{entry.part_type}</span>
        ) : null}
      </div>
      <div className={styles.evidenceFacts}>
        <span>{locatorLabel(entry.locator)}</span>
        <span>{entry.source_version}</span>
        {sourceRefs.map((ref, index) => (
          <span key={`${ref.type}-${ref.id}-${index}`}>
            {ref.label || `${ref.type} ${ref.id}`}
          </span>
        ))}
        {evidenceSpanIds.map((spanId) => (
          <span key={spanId}>span {spanId}</span>
        ))}
      </div>
    </div>
  );
}

function ArtifactInspector({
  artifactId,
  fallbackArtifact,
  onActivateTarget,
  onAskAboutSource,
  onAttachContext,
  onChatRunCreated,
  focusPartId,
  focusKey,
  hasReaderActivator,
}: {
  artifactId: string;
  fallbackArtifact: MessageArtifactDelta | MessageArtifact;
  onActivateTarget: (target: ReaderSourceTarget) => void;
  onAskAboutSource?: (target: ReaderSourceTarget) => void;
  onAttachContext?: (context: ContextItem) => void;
  onChatRunCreated?: (runData: ChatRunResponse["data"]) => void;
  focusPartId?: string | null;
  focusKey?: string | null;
  hasReaderActivator: boolean;
}) {
  const inspectorRef = useRef<HTMLDivElement | null>(null);
  const focusedKeyRef = useRef<string | null>(null);
  const fallbackDurable = isDurableArtifact(fallbackArtifact)
    ? fallbackArtifact
    : null;
  const [artifact, setArtifact] = useState<MessageArtifact | null>(
    fallbackDurable,
  );
  const [manifest, setManifest] =
    useState<MessageArtifactCitationManifest | null>(
      fallbackDurable ? artifactManifest(fallbackDurable) : null,
    );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportLedgers, setExportLedgers] = useState<
    MessageArtifactExportLedger[]
  >([]);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  const [selectedPartId, setSelectedPartId] = useState<string>(
    focusPartId &&
      fallbackArtifact.parts?.some((part) => part.id === focusPartId)
      ? focusPartId
      : (fallbackArtifact.parts?.[0]?.id ?? ""),
  );
  const [askContent, setAskContent] = useState("");
  const [askLoading, setAskLoading] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [askResult, setAskResult] = useState<string | null>(null);

  const loadArtifact = useCallback(async (): Promise<MessageArtifact> => {
    const artifactResponse = await apiFetch<{ data: MessageArtifact }>(
      `/api/artifacts/${artifactId}`,
    );
    setArtifact(artifactResponse.data);
    setManifest(artifactManifest(artifactResponse.data));
    const focusedPart = focusPartId
      ? artifactResponse.data.parts.find((part) => part.id === focusPartId)
      : null;
    const selectedPart = artifactResponse.data.parts.find(
      (part) => part.id === selectedPartId,
    );
    setSelectedPartId(
      focusedPart?.id ??
        selectedPart?.id ??
        artifactResponse.data.parts?.[0]?.id ??
        "",
    );
    return artifactResponse.data;
  }, [artifactId, focusPartId, selectedPartId]);

  const loadExportLedgers = useCallback(async () => {
    setLedgerLoading(true);
    setLedgerError(null);
    try {
      const ledgerResponse = await apiFetch<{
        data: MessageArtifactExportLedger[];
      }>(`/api/artifacts/${artifactId}/exports`);
      setExportLedgers(ledgerResponse.data);
    } catch {
      setLedgerError("Export ledger is unavailable.");
    } finally {
      setLedgerLoading(false);
    }
  }, [artifactId]);

  const durableParts = artifact?.parts ?? [];
  const previewParts = (fallbackArtifact.parts ?? []).map((part, index) => ({
    ...part,
    ordinal: part.ordinal ?? index,
  }));
  const parts = durableParts.length > 0 ? durableParts : previewParts;
  const selectedPart =
    parts.find((part) => part.id === selectedPartId) ?? parts[0] ?? null;
  const selectedPartSourceTarget = selectedPart
    ? readerTargetFromArtifactPart(selectedPart)
    : null;
  const selectedPartSourceHref = selectedPart
    ? artifactPartHref(selectedPart)
    : null;

  const fetchArtifact = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await loadArtifact();
    } catch {
      setError("Artifact details are unavailable.");
    } finally {
      setLoading(false);
    }
  }, [loadArtifact]);

  useEffect(() => {
    if (artifact || loading) return;
    void fetchArtifact();
  }, [artifact, fetchArtifact, loading]);

  useEffect(() => {
    if (!focusPartId) return;
    const availableParts = artifact?.parts ?? fallbackArtifact.parts ?? [];
    if (availableParts.some((part) => part.id === focusPartId)) {
      setSelectedPartId(focusPartId);
    }
  }, [artifact, fallbackArtifact.parts, focusPartId]);

  useEffect(() => {
    void loadExportLedgers();
  }, [loadExportLedgers]);

  useEffect(() => {
    if (!focusKey || focusedKeyRef.current === focusKey) return;
    focusedKeyRef.current = focusKey;
    window.requestAnimationFrame(() => {
      inspectorRef.current?.scrollIntoView({ block: "center" });
      inspectorRef.current?.focus();
    });
  }, [focusKey]);

  const askAboutSelectedPart = useCallback(async () => {
    const content = askContent.trim();
    if (!content || askLoading) return;

    setAskLoading(true);
    setAskError(null);
    setAskResult(null);
    try {
      const durableArtifact = artifact ?? (await loadArtifact());
      const durablePart = selectedPart
        ? artifactPartForAsk(durableArtifact.parts, selectedPart)
        : (durableArtifact.parts[0] ?? null);
      if (!durablePart?.id) {
        setAskError("Select a durable artifact part first.");
        return;
      }
      if (!durableArtifact.chat_run_id) {
        setAskError("Artifact ask needs the originating chat run.");
        return;
      }

      setSelectedPartId(durablePart.id);
      const runResponse = await apiFetch<ChatRunResponse>(
        `/api/chat-runs/${durableArtifact.chat_run_id}`,
      );
      const askResponse = await apiFetch<{ data: MessageArtifactFollowUp }>(
        `/api/artifacts/${artifactId}/ask`,
        {
          method: "POST",
          body: JSON.stringify({
            mode: "chat_run_payload",
            content,
            artifact_part_id: durablePart.id,
            model_id: runResponse.data.run.model_id,
          }),
        },
      );
      const payload = askResponse.data.chat_run_payload;
      const context = payload?.contexts.find(
        (item) => item.kind === "object_ref",
      );
      if (!payload || !context) {
        setAskError("Artifact ask did not return a runnable chat payload.");
        return;
      }
      const evidenceSpanIds = [
        ...(durablePart.evidence_span_ids ?? []),
        ...(durablePart.evidence_span_id ? [durablePart.evidence_span_id] : []),
      ];
      const runPayload = {
        ...payload,
        contexts: payload.contexts.map((item) =>
          item === context
            ? {
                ...item,
                ...(evidenceSpanIds.length
                  ? { evidence_span_ids: [...new Set(evidenceSpanIds)] }
                  : {}),
                artifact_id: durableArtifact.id,
                artifact_key: durableArtifact.artifact_key ?? null,
                artifact_version: durableArtifact.artifact_version,
                source_version: durablePart.source_version,
                locator: durablePart.locator,
                artifact_part_provenance:
                  askResponse.data.artifact_part_provenance,
              }
            : item,
        ),
      };
      const createdRun = await apiFetch<ChatRunResponse>("/api/chat-runs", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(runPayload),
      });
      onChatRunCreated?.(createdRun.data);
      setAskResult("Started follow-up chat run.");
    } catch {
      setAskError("Artifact ask is unavailable.");
    } finally {
      setAskLoading(false);
    }
  }, [
    artifact,
    artifactId,
    askContent,
    askLoading,
    loadArtifact,
    onChatRunCreated,
    selectedPart,
  ]);

  return (
    <div
      ref={inspectorRef}
      className={styles.artifactInspector}
      role="region"
      aria-label="Artifact detail"
      tabIndex={-1}
    >
      <div className={styles.artifactInspectorToolbar}>
        <div className={styles.artifactInspectorTitle}>
          <ListTree size={14} aria-hidden="true" />
          <span>Artifact detail</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className={styles.retrievalAction}
          onClick={fetchArtifact}
          loading={loading}
        >
          {artifact ? "Reload durable data" : "Load durable data"}
        </Button>
      </div>
      {error ? <p className={styles.artifactStatus}>{error}</p> : null}
      <div className={styles.artifactInspectorGrid}>
        <div className={styles.artifactPartList} aria-label="Artifact parts">
          {parts.length > 0 ? (
            parts.map((part, index) => {
              const partId = part.id ?? `preview-part-${index}`;
              const selected = selectedPartId
                ? selectedPartId === part.id
                : index === 0;
              return (
                <button
                  key={partId}
                  type="button"
                  className={`${styles.artifactPartButton} ${
                    selected ? styles.artifactPartButtonSelected : ""
                  }`}
                  onClick={() => setSelectedPartId(part.id ?? "")}
                  aria-pressed={selected}
                >
                  <span>{part.part_key || `Part ${index + 1}`}</span>
                  <span>{part.part_type || partEvidenceLabel(part)}</span>
                </button>
              );
            })
          ) : (
            <p className={styles.artifactStatus}>
              No parts are available in the preview.
            </p>
          )}
        </div>
        <div className={styles.artifactDetailPane}>
          {artifact ? (
            <div className={styles.evidenceFacts}>
              <span>{artifact.artifact_kind || "artifact"}</span>
              <span>{artifact.status || "unknown status"}</span>
              {artifact.artifact_key ? (
                <span>{artifact.artifact_key}</span>
              ) : null}
              {artifact.parts ? (
                <span>{artifact.parts.length} parts</span>
              ) : null}
            </div>
          ) : null}
          <ArtifactKindView
            artifactKind={
              artifact?.artifact_kind ?? fallbackArtifact.artifact_kind ?? ""
            }
            parts={parts}
          />
          {selectedPart ? (
            <>
              {selectedPart.text ? (
                <blockquote className={styles.evidenceSnippet}>
                  {selectedPart.text}
                </blockquote>
              ) : null}
              {selectedPartSourceTarget || selectedPartSourceHref ? (
                <div className={styles.artifactInspectorToolbar}>
                  {hasReaderActivator && selectedPartSourceTarget ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className={styles.retrievalAction}
                      onClick={() => onActivateTarget(selectedPartSourceTarget)}
                    >
                      Open source
                    </Button>
                  ) : selectedPartSourceHref ? (
                    <a href={selectedPartSourceHref}>Open source</a>
                  ) : null}
                  {onAskAboutSource && selectedPartSourceTarget ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className={styles.retrievalAction}
                      onClick={() => onAskAboutSource(selectedPartSourceTarget)}
                    >
                      Ask source
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
          {manifest && manifest.entries.length > 0 ? (
            <>
              <div className={styles.artifactSubhead}>
                <span>Citation manifest</span>
              </div>
              <div className={styles.sourceManifestRows}>
                {manifest.entries.map((entry) => (
                  <ArtifactManifestEntryRow
                    key={entry.artifact_part_id || `entry-${entry.ordinal}`}
                    entry={entry}
                  />
                ))}
              </div>
            </>
          ) : null}
          <div className={styles.artifactInspectorToolbar}>
            <div className={styles.artifactSubhead}>
              <FileText size={14} aria-hidden="true" />
              <span>Export ledger</span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className={styles.retrievalAction}
              onClick={() => void loadExportLedgers()}
              loading={ledgerLoading}
            >
              Refresh
            </Button>
          </div>
          {ledgerError ? (
            <p className={styles.artifactStatus}>{ledgerError}</p>
          ) : exportLedgers.length > 0 ? (
            <ol className={styles.artifactJsonBlock}>
              {exportLedgers.map((ledger) => (
                <li key={ledger.id}>
                  <strong>{ledger.format}</strong>
                  {` v${ledger.artifact_version} - ${new Date(
                    ledger.created_at,
                  ).toLocaleString()} - viewer ${ledger.viewer_user_id} - content ${ledger.content_sha256.slice(
                    0,
                    12,
                  )} - manifest ${ledger.manifest_sha256.slice(0, 12)}`}
                </li>
              ))}
            </ol>
          ) : ledgerLoading ? (
            <p className={styles.artifactStatus}>Loading export ledger.</p>
          ) : (
            <p className={styles.artifactStatus}>No exports yet.</p>
          )}
        </div>
      </div>
      <div className={styles.artifactAskForm}>
        <div className={styles.artifactSubhead}>
          <FileText size={14} aria-hidden="true" />
          <span>Follow-up context</span>
        </div>
        <label>
          <span>Question</span>
          <textarea
            rows={3}
            value={askContent}
            onChange={(event) => setAskContent(event.target.value)}
          />
        </label>
        <div className={styles.artifactInspectorToolbar}>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            leadingIcon={<Search size={14} aria-hidden="true" />}
            onClick={() => void askAboutSelectedPart()}
            loading={askLoading}
            disabled={!selectedPart || !askContent.trim()}
          >
            Ask about selected part
          </Button>
          {selectedPart?.id && onAttachContext ? (
            <Button
              variant="secondary"
              size="sm"
              type="button"
              leadingIcon={<Search size={14} aria-hidden="true" />}
              onClick={() => {
                const evidenceSpanIds = [
                  ...(selectedPart.evidence_span_ids ?? []),
                  ...(selectedPart.evidence_span_id
                    ? [selectedPart.evidence_span_id]
                    : []),
                ];
                onAttachContext({
                  kind: "object_ref",
                  type: "artifact_part",
                  id: selectedPart.id ?? "",
                  ...(evidenceSpanIds.length
                    ? { evidence_span_ids: [...new Set(evidenceSpanIds)] }
                    : {}),
                  artifact_id:
                    artifact?.id ?? selectedPart.artifact_id ?? artifactId,
                  artifact_key:
                    artifact?.artifact_key ??
                    fallbackArtifact.artifact_key ??
                    null,
                  artifact_version:
                    artifact?.artifact_version ??
                    fallbackArtifact.artifact_version ??
                    null,
                  source_version: selectedPart.source_version,
                  locator: selectedPart.locator,
                  artifact_part_provenance: {
                    type: "artifact_part",
                    artifact_id:
                      artifact?.id ?? selectedPart.artifact_id ?? artifactId,
                    artifact_key:
                      artifact?.artifact_key ??
                      fallbackArtifact.artifact_key ??
                      null,
                    artifact_version:
                      artifact?.artifact_version ??
                      fallbackArtifact.artifact_version ??
                      null,
                    artifact_kind:
                      artifact?.artifact_kind ??
                      fallbackArtifact.artifact_kind ??
                      null,
                    artifact_title:
                      artifact?.title ?? fallbackArtifact.title ?? null,
                    artifact_part_id: selectedPart.id ?? "",
                    part_key: selectedPart.part_key ?? null,
                    part_type: selectedPart.part_type ?? null,
                    source_version: selectedPart.source_version,
                    locator: selectedPart.locator,
                    evidence_span_ids: [...new Set(evidenceSpanIds)],
                  },
                  preview:
                    selectedPart.text?.slice(0, 120) ||
                    artifact?.title ||
                    fallbackArtifact.title ||
                    "Artifact part",
                  ...(selectedPart.text ? { exact: selectedPart.text } : {}),
                  color: "purple",
                });
              }}
            >
              Attach selected part
            </Button>
          ) : null}
        </div>
        {askError ? <p className={styles.artifactStatus}>{askError}</p> : null}
        {askResult ? (
          <p className={styles.artifactStatus} role="status">
            {askResult}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ArtifactKindView({
  artifactKind,
  parts,
}: {
  artifactKind: string;
  parts: Array<{
    id?: string | null;
    part_key?: string | null;
    part_type?: string | null;
    text?: string | null;
  }>;
}) {
  if (!parts.length) return null;
  if (
    artifactKind === "briefing_document" ||
    artifactKind === "study_guide" ||
    artifactKind === "outline" ||
    artifactKind === "audio_overview_script" ||
    artifactKind === "audio_overview" ||
    artifactKind === "contradiction_report"
  ) {
    return (
      <section className={styles.artifactJsonBlock}>
        {parts.map((part, index) => (
          <div
            key={part.id ?? `${part.part_key ?? "part"}-${index}`}
            className={styles.artifactSection}
          >
            <h4>{part.part_key || part.part_type || `Section ${index + 1}`}</h4>
            <p>{part.text || ""}</p>
          </div>
        ))}
      </section>
    );
  }
  if (artifactKind === "faq") {
    return (
      <dl className={styles.artifactJsonBlock}>
        {parts.map((part, index) => (
          <Fragment key={part.id ?? `${part.part_key ?? "part"}-${index}`}>
            <dt>{part.part_key || `Question ${index + 1}`}</dt>
            <dd>{part.text || ""}</dd>
          </Fragment>
        ))}
      </dl>
    );
  }
  if (artifactKind === "timeline") {
    return (
      <ol className={styles.artifactJsonBlock}>
        {parts.map((part, index) => (
          <li key={part.id ?? `${part.part_key ?? "part"}-${index}`}>
            <strong>
              {part.part_key || part.part_type || `Event ${index + 1}`}
            </strong>
            {part.text ? <span> {part.text}</span> : null}
          </li>
        ))}
      </ol>
    );
  }
  if (
    artifactKind === "table" ||
    artifactKind === "comparison_table" ||
    artifactKind === "extraction_table" ||
    artifactKind === "claim_table"
  ) {
    return (
      <table className={styles.artifactJsonBlock}>
        <thead>
          <tr>
            <th>Part</th>
            <th>Type</th>
            <th>Text</th>
          </tr>
        </thead>
        <tbody>
          {parts.map((part, index) => (
            <tr key={part.id ?? `${part.part_key ?? "part"}-${index}`}>
              <td>{part.part_key || `Row ${index + 1}`}</td>
              <td>{part.part_type || ""}</td>
              <td>{part.text || ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (artifactKind === "source_map" || artifactKind === "concept_map") {
    return (
      <ul className={styles.artifactJsonBlock}>
        {parts.map((part, index) => (
          <li key={part.id ?? `${part.part_key ?? "part"}-${index}`}>
            <strong>
              {part.part_key || part.part_type || `Node ${index + 1}`}
            </strong>
            {part.text ? <span> {part.text}</span> : null}
          </li>
        ))}
      </ul>
    );
  }
  if (artifactKind === "flashcards" || artifactKind === "quiz") {
    return (
      <dl className={styles.artifactJsonBlock}>
        {parts.map((part, index) => (
          <Fragment key={part.id ?? `${part.part_key ?? "part"}-${index}`}>
            <dt>{part.part_key || part.part_type || `Prompt ${index + 1}`}</dt>
            <dd>{part.text || ""}</dd>
          </Fragment>
        ))}
      </dl>
    );
  }
  if (artifactKind === "video_slide_overview_manifest") {
    return (
      <ol className={styles.artifactJsonBlock}>
        {parts.map((part, index) => (
          <li key={part.id ?? `${part.part_key ?? "part"}-${index}`}>
            <strong>{part.part_key || `Slide ${index + 1}`}</strong>
            {part.part_type ? <span> [{part.part_type}]</span> : null}
            {part.text ? <p>{part.text}</p> : null}
          </li>
        ))}
      </ol>
    );
  }
  if (artifactKind === "bibliography") {
    return (
      <ol className={styles.artifactJsonBlock}>
        {parts.map((part, index) => (
          <li key={part.id ?? `${part.part_key ?? "part"}-${index}`}>
            {part.text || part.part_key || `Source ${index + 1}`}
          </li>
        ))}
      </ol>
    );
  }
  if (artifactKind === "citation_audit") {
    return (
      <ul className={styles.artifactJsonBlock}>
        {parts.map((part, index) => (
          <li key={part.id ?? `${part.part_key ?? "part"}-${index}`}>
            {part.part_key || part.part_type || `Finding ${index + 1}`}:{" "}
            {part.text || ""}
          </li>
        ))}
      </ul>
    );
  }
  return null;
}

function artifactPartHasEvidence(part: unknown): boolean {
  if (!part || typeof part !== "object") return false;
  const record = part as Record<string, unknown>;
  if (
    typeof record.source_version !== "string" ||
    !isRetrievalLocator(record.locator)
  ) {
    return false;
  }
  return (
    Boolean(record.source_ref && typeof record.source_ref === "object") ||
    Boolean(record.context_ref && typeof record.context_ref === "object") ||
    Boolean(record.result_ref && typeof record.result_ref === "object") ||
    (Array.isArray(record.source_refs) && record.source_refs.length > 0) ||
    typeof record.evidence_span_id === "string" ||
    (Array.isArray(record.evidence_span_ids) &&
      record.evidence_span_ids.length > 0)
  );
}

function partEvidenceLabel(part: MessageArtifact["parts"][number]): string {
  if (artifactPartHasEvidence(part)) return "cited";
  return "uncited";
}

function artifactPartForAsk(
  parts: MessageArtifactPart[],
  selectedPart: MessageArtifactPart,
): MessageArtifactPart | null {
  return (
    parts.find((part) => part.id && part.id === selectedPart.id) ??
    parts.find(
      (part) =>
        part.part_key &&
        selectedPart.part_key &&
        part.part_key === selectedPart.part_key,
    ) ??
    parts.find(
      (part) =>
        typeof part.ordinal === "number" &&
        part.ordinal === selectedPart.ordinal,
    ) ??
    parts[0] ??
    null
  );
}

function artifactPartHref(part: MessageArtifactPart): string | null {
  if (part.locator.type === "artifact_part_ref") {
    const conversationId = textField(part.locator, "conversation_id");
    const artifactId = textField(part.locator, "artifact_id");
    const artifactPartId = textField(part.locator, "artifact_part_id");
    if (conversationId && artifactId && artifactPartId) {
      return `/conversations/${encodeURIComponent(conversationId)}?artifact=${encodeURIComponent(
        artifactId,
      )}&artifactPart=${encodeURIComponent(artifactPartId)}`;
    }
  }

  for (const ref of [
    part.result_ref,
    part.source_ref?.result_ref,
    ...(part.source_refs ?? []).map((sourceRef) => sourceRef.result_ref),
  ]) {
    const href = textField(ref, "deep_link");
    if (href) return href;
  }
  return null;
}

function readerTargetFromArtifactPart(
  part: MessageArtifactPart,
): ReaderSourceTarget | null {
  if (isReaderMediaLocator(part.locator)) {
    const mediaId = mediaIdFromLocator(part.locator);
    if (mediaId) {
      if (!part.source_version) {
        return null;
      }
      return {
        source: "message_retrieval",
        media_id: mediaId,
        locator: part.locator,
        snippet: part.text ?? null,
        source_version: part.source_version,
        highlight_behavior: "pulse",
        focus_behavior: "scroll_into_view",
        status: "selected",
        label: part.part_key || "Artifact source",
        evidence_span_id: part.evidence_span_id ?? null,
        ...(part.id ? { evidence_id: part.id } : {}),
        context_id: textField(part.context_ref, "id"),
      };
    }
  }
  const refs = [
    part.result_ref,
    part.source_ref?.result_ref,
    ...(part.source_refs ?? []).map((sourceRef) => sourceRef.result_ref),
  ];
  for (const ref of refs) {
    const sourceVersion =
      part.source_version ?? textField(ref, "source_version");
    if (!sourceVersion) {
      continue;
    }
    const locator = objectField(ref, "locator");
    if (!isRetrievalLocator(locator) || !isReaderMediaLocator(locator)) {
      continue;
    }
    const mediaId = mediaIdFromLocator(locator);
    if (!mediaId) {
      continue;
    }
    const contextRef = objectField(ref, "context_ref");
    return {
      source: "message_retrieval",
      media_id: mediaId,
      locator,
      snippet:
        part.text ?? textField(ref, "snippet") ?? textField(ref, "excerpt"),
      source_version: sourceVersion,
      highlight_behavior: "pulse",
      focus_behavior: "scroll_into_view",
      status: "selected",
      label:
        textField(ref, "title") ||
        textField(ref, "source_label") ||
        part.part_key ||
        "Artifact source",
      href: textField(ref, "deep_link"),
      evidence_span_id:
        part.evidence_span_id ?? textField(ref, "evidence_span_id"),
      ...(part.id ? { evidence_id: part.id } : {}),
      context_id:
        textField(part.context_ref, "id") ?? textField(contextRef, "id"),
    };
  }
  return null;
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
  return {
    source: "message_retrieval",
    media_id: retrieval.media_id,
    locator: retrieval.locator,
    snippet: retrievalSnippet(retrieval),
    source_version: retrieval.source_version,
    highlight_behavior: "pulse",
    focus_behavior: "scroll_into_view",
    status: retrieval.retrieval_status ?? "retrieved",
    label: retrievalTitle(retrieval),
    href: retrieval.deep_link,
    evidence_span_id: retrieval.evidence_span_id ?? null,
    evidence_id: retrieval.id,
    context_id:
      typeof retrieval.context_ref.id === "string"
        ? retrieval.context_ref.id
        : null,
  };
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
  const [runs, setRuns] = useState<AssistantVerifierRun[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open || loaded) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<{ data: AssistantVerifierRun[] }>(
      `/api/messages/${messageId}/verifier-runs`,
    )
      .then((response) => {
        if (cancelled) return;
        setRuns(response.data);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setError("Verifier ledger is unavailable.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loaded, messageId, open]);

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
              <span>{runs.length} runs</span>
            ) : null}
          </div>
          {error ? (
            <div className={styles.sourceManifestFilters}>{error}</div>
          ) : null}
          {runs.map((run) => (
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
          {loaded && !loading && !error && runs.length === 0 ? (
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
  if (!isReaderMediaLocator(locator)) {
    return null;
  }
  const mediaId = mediaIdFromLocator(locator);
  if (!mediaId) {
    return null;
  }
  if (!evidence.source_version) {
    return null;
  }
  return {
    source: "claim_evidence",
    media_id: mediaId,
    locator,
    snippet: evidence.exact_snippet ?? null,
    source_version: evidence.source_version,
    highlight_behavior: "pulse",
    focus_behavior: "scroll_into_view",
    status: evidence.retrieval_status,
    label,
    href: evidenceHref(evidence),
    evidence_span_id: evidence.evidence_span_id ?? null,
    evidence_id: evidence.id,
    context_id: textField(evidence.context_ref, "id"),
  };
}

function isReaderMediaLocator(
  locator: MessageEvidenceLocator,
): locator is Extract<
  MessageEvidenceLocator,
  {
    type:
      | "web_text_offsets"
      | "epub_fragment_offsets"
      | "pdf_page_geometry"
      | "transcript_time_range"
      | "audio_time_range"
      | "video_time_range";
  }
> {
  return (
    locator.type === "web_text_offsets" ||
    locator.type === "epub_fragment_offsets" ||
    locator.type === "pdf_page_geometry" ||
    locator.type === "transcript_time_range" ||
    locator.type === "audio_time_range" ||
    locator.type === "video_time_range"
  );
}

function mediaIdFromLocator(locator: MessageEvidenceLocator): string | null {
  if (
    locator.type === "web_text_offsets" ||
    locator.type === "epub_fragment_offsets" ||
    locator.type === "pdf_page_geometry" ||
    locator.type === "transcript_time_range" ||
    locator.type === "audio_time_range" ||
    locator.type === "video_time_range"
  ) {
    return locator.media_id;
  }
  return null;
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

function objectField(
  record: unknown,
  key: string,
): Record<string, unknown> | null {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return null;
  }
  const value = (record as Record<string, unknown>)[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
