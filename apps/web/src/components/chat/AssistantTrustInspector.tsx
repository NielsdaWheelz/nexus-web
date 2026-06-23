"use client";

import { AlertTriangle, Search, Wrench } from "lucide-react";
import { toReaderCitationData } from "@/lib/conversations/citations";
import type {
  AssistantTrustTrail,
  MessageRetrieval,
  MessageToolCall,
} from "@/lib/conversations/types";
import type { ReaderSourceTarget } from "@/lib/conversations/readerTarget";
import type { ResourceActivation } from "@/lib/resources/activation";
import styles from "./MessageRow.module.css";

export default function AssistantTrustInspector({
  trustTrail,
  onCitationActivate,
}: {
  trustTrail: AssistantTrustTrail;
  onCitationActivate?: (
    activation: ResourceActivation,
    target: ReaderSourceTarget | null,
    event?: React.MouseEvent,
  ) => void;
}) {
  const retrievalPlan = trustTrail.run?.retrieval_plan ?? null;
  const retrieved = trustTrail.tool_calls.reduce(
    (count, tool) => count + tool.retrievals.length,
    0,
  );
  const selected = trustTrail.tool_calls.reduce(
    (count, tool) =>
      count + tool.retrievals.filter((retrieval) => retrieval.selected).length,
    0,
  );
  const included = trustTrail.tool_calls.reduce(
    (count, tool) =>
      count +
      tool.retrievals.filter((retrieval) => retrieval.included_in_prompt).length,
    0,
  );
  const contextRefs = trustTrail.context_refs_added.length;
  const warnings = trustTrail.integrity_notices.length;

  return (
    <details className={styles.trustInspector}>
      <summary>
        <span>
          {trustTrail.tool_calls.length} tools - {retrieved} retrieved - {selected}{" "}
          selected - {included} included - {trustTrail.citations.length} cited -{" "}
          {contextRefs} context refs
        </span>
        {warnings > 0 ? <strong>{warnings} notices</strong> : null}
      </summary>
      <div className={styles.trustInspectorPanel}>
        {trustTrail.run ? (
          <section>
            <h4>Run</h4>
            <dl className={styles.trustMeta}>
              <div>
                <dt>Model</dt>
                <dd>
                  {trustTrail.run.provider}/{trustTrail.run.model_name}
                </dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>
                  {trustTrail.run.status}
                  {trustTrail.run.error_code ? ` - ${trustTrail.run.error_code}` : ""}
                </dd>
              </div>
              <div>
                <dt>Mode</dt>
                <dd>
                  {trustTrail.run.reasoning_mode ?? "default"} /{" "}
                  {trustTrail.run.key_mode ?? "auto"}
                </dd>
              </div>
              <div>
                <dt>Output</dt>
                <dd>{trustTrail.run.final_chars ?? 0} chars</dd>
              </div>
            </dl>
          </section>
        ) : null}

        {retrievalPlan ? (
          <section>
            <h4>Retrieval</h4>
            <dl className={styles.trustMeta}>
              <div>
                <dt>Route</dt>
                <dd>
                  {retrievalPlan.route_intent} / {retrievalPlan.source_domain}
                </dd>
              </div>
              <div>
                <dt>Policy</dt>
                <dd>
                  {retrievalPlan.query_class} / {retrievalPlan.mixing_policy}
                </dd>
              </div>
              <div>
                <dt>Tools</dt>
                <dd>{retrievalPlan.allowed_tools.join(", ") || "none"}</dd>
              </div>
              <div>
                <dt>Blocked</dt>
                <dd>{retrievalPlan.blocked_tools.join(", ") || "none"}</dd>
              </div>
              <div>
                <dt>Sequence</dt>
                <dd>{retrievalPlan.candidate_tool_sequence.join(", ") || "none"}</dd>
              </div>
              {retrievalPlan.internal_tool_sequence.length > 0 ? (
                <div>
                  <dt>Internal</dt>
                  <dd>{retrievalPlan.internal_tool_sequence.join(", ")}</dd>
                </div>
              ) : null}
              <div>
                <dt>Refs</dt>
                <dd>
                  {retrievalPlan.context_ref_count} context /{" "}
                  {retrievalPlan.search_scope_count} scopes
                </dd>
              </div>
              <div>
                <dt>Budget</dt>
                <dd>{retrievalPlan.budget_policy}</dd>
              </div>
              <div>
                <dt>Reason</dt>
                <dd>{retrievalPlan.reason}</dd>
              </div>
            </dl>
          </section>
        ) : null}

        {trustTrail.prompt ? (
          <section>
            <h4>Prompt</h4>
            <dl className={styles.trustMeta}>
              <div>
                <dt>Budget</dt>
                <dd>
                  {trustTrail.prompt.estimated_input_tokens}/
                  {trustTrail.prompt.input_budget_tokens} input tokens
                </dd>
              </div>
              <div>
                <dt>Reserved</dt>
                <dd>
                  {trustTrail.prompt.reserved_output_tokens} output /{" "}
                  {trustTrail.prompt.reserved_reasoning_tokens} reasoning
                </dd>
              </div>
              <div>
                <dt>Included</dt>
                <dd>
                  {trustTrail.prompt.included_message_ids.length} messages /{" "}
                  {trustTrail.prompt.included_retrieval_ids.length} retrievals /{" "}
                  {trustTrail.prompt.included_context_refs.length} refs
                </dd>
              </div>
              <div>
                <dt>Dropped</dt>
                <dd>{trustTrail.prompt.dropped_items.length}</dd>
              </div>
            </dl>
          </section>
        ) : null}

        {trustTrail.tool_calls.length > 0 ? (
          <section>
            <h4>Tools</h4>
            <ol className={styles.trustToolList}>
              {trustTrail.tool_calls.map((tool) => (
                <ToolRow key={tool.id ?? tool.tool_call_index} tool={tool} />
              ))}
            </ol>
          </section>
        ) : null}

        {trustTrail.citations.length > 0 ? (
          <section>
            <h4>Citations</h4>
            <ol className={styles.trustNestedList}>
              {trustTrail.citations.map((item) => {
                const citation = toReaderCitationData(item.citation);
                return (
                  <li key={item.citation_edge_id}>
                    <div className={styles.trustLine}>
                      <Search size={13} aria-hidden="true" />
                      {onCitationActivate ? (
                        <button
                          type="button"
                          onClick={(event) =>
                            onCitationActivate(
                              citation.activation,
                              citation.target,
                              event,
                            )
                          }
                        >
                          [{item.ordinal}] {citation.preview.title || "Citation"}
                        </button>
                      ) : (
                        <span>
                          [{item.ordinal}] {citation.preview.title || "Citation"}
                        </span>
                      )}
                    </div>
                    <div className={styles.trustCode}>
                      edge {shortId(item.citation_edge_id)}
                      {item.retrieval_id ? ` - retrieval ${shortId(item.retrieval_id)}` : ""}
                      {item.tool_call_id ? ` - tool ${shortId(item.tool_call_id)}` : ""}
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        ) : null}

        {trustTrail.context_refs_added.length > 0 ? (
          <section>
            <h4>Context refs</h4>
            <ol className={styles.trustNestedList}>
              {trustTrail.context_refs_added.map((contextRef) => (
                <li key={`${contextRef.chat_run_event_seq}:${contextRef.id}`}>
                  <div className={styles.trustLine}>
                    <span>{contextRef.label || contextRef.resource_ref}</span>
                    <span className={styles.trustFlags}>
                      {contextRef.missing ? "missing" : "added"}
                    </span>
                  </div>
                  <div className={styles.trustCode}>
                    {contextRef.resource_ref}
                    {contextRef.citation_edge_id
                      ? ` - edge ${shortId(contextRef.citation_edge_id)}`
                      : ""}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        {warnings > 0 ? (
          <section>
            <h4>Notices</h4>
            <ol className={styles.trustNestedList}>
              {trustTrail.integrity_notices.map((notice) => (
                <li key={notice.code}>
                  <div className={styles.trustLine}>
                    <AlertTriangle size={13} aria-hidden="true" />
                    <span>{notice.message}</span>
                  </div>
                  <div className={styles.trustCode}>{notice.code}</div>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
      </div>
    </details>
  );
}

function ToolRow({ tool }: { tool: MessageToolCall }) {
  return (
    <li>
      <div className={styles.trustLine}>
        <Wrench size={13} aria-hidden="true" />
        <span>
          #{tool.tool_call_index} {tool.tool_name} - {tool.status}
          {tool.error_code ? ` - ${tool.error_code}` : ""}
        </span>
      </div>
      <div className={styles.trustCode}>
        tool {tool.id ? shortId(tool.id) : "pending"} - {tool.scope ?? "all"} -{" "}
        {tool.result_count ?? tool.result_refs.length} results /{" "}
        {tool.selected_count ?? tool.selected_context_refs.length} selected
        {tool.more_candidates_available ? " - more available" : ""}
        {typeof tool.latency_ms === "number" ? ` - ${tool.latency_ms}ms` : ""}
      </div>
      {tool.source_domain && tool.source_policy ? (
        <div className={styles.trustCode}>
          source {tool.source_domain} - {tool.source_policy.decision} -{" "}
          {tool.source_policy.reason}
          {" - "}
          {tool.source_policy.version} - mix{" "}
          {tool.source_policy.mixing_allowed ? "allowed" : "blocked"} - seen{" "}
          {tool.source_policy.domains_seen.join(",") || "none"} - requested{" "}
          {tool.source_policy.requested_domains.join(",") || "none"}
        </div>
      ) : null}
      {tool.retrievals.length > 0 ? (
        <ol className={styles.trustNestedList}>
          {tool.retrievals.map((retrieval) => (
            <RetrievalRow
              key={retrieval.id ?? `${tool.id}:${retrieval.ordinal}`}
              retrieval={retrieval}
            />
          ))}
        </ol>
      ) : null}
      {tool.candidate_ledgers.length > 0 ? (
        <ol className={styles.trustNestedList}>
          {tool.candidate_ledgers.map((ledger) => (
            <li key={ledger.id}>
              <div className={styles.trustLine}>
                <span>
                  candidate {ledger.ordinal}: {ledger.source_id}
                </span>
                <span className={styles.trustFlags}>
                  {ledger.selected ? "selected" : "candidate"} /{" "}
                  {ledger.included_in_prompt ? "included" : "not included"}
                </span>
              </div>
              <div className={styles.trustCode}>
                {ledger.selection_status} - {ledger.selection_reason}
                {ledger.score !== null && ledger.score !== undefined
                  ? ` - score ${ledger.score.toFixed(3)}`
                  : ""}
                {!ledger.included_in_prompt_reconciled ? " - mismatch" : ""}
              </div>
            </li>
          ))}
        </ol>
      ) : null}
      {tool.rerank_ledgers.length > 0 ? (
        <ol className={styles.trustNestedList}>
          {tool.rerank_ledgers.map((ledger) => {
            const candidateLimit =
              typeof ledger.metadata.candidate_limit === "number"
                ? ledger.metadata.candidate_limit
                : null;
            const selectedLimit =
              typeof ledger.metadata.selected_limit === "number"
                ? ledger.metadata.selected_limit
                : null;
            const queryClass =
              typeof ledger.metadata.query_class === "string"
                ? ledger.metadata.query_class
                : null;
            const retrievalMode =
              typeof ledger.metadata.retrieval_mode === "string"
                ? ledger.metadata.retrieval_mode
                : null;
            const policyReason =
              typeof ledger.metadata.policy_reason === "string"
                ? ledger.metadata.policy_reason
                : null;
            const rerankMode =
              typeof ledger.metadata.rerank_mode === "string"
                ? ledger.metadata.rerank_mode
                : null;
            const rerankReason =
              typeof ledger.metadata.rerank_reason === "string"
                ? ledger.metadata.rerank_reason
                : null;
            const contextRoute =
              typeof ledger.metadata.context_route === "string"
                ? ledger.metadata.context_route
                : null;
            const contextRouteReason =
              typeof ledger.metadata.context_route_reason === "string"
                ? ledger.metadata.context_route_reason
                : null;
            const selectionVersion =
              typeof ledger.metadata.selection_policy_version === "string"
                ? ledger.metadata.selection_policy_version
                : null;
            const orderingPolicy =
              typeof ledger.metadata.ordering_policy === "string"
                ? ledger.metadata.ordering_policy
                : null;
            const diversityPolicy =
              typeof ledger.metadata.diversity_policy === "string"
                ? ledger.metadata.diversity_policy
                : null;
            const budgetPolicy =
              typeof ledger.metadata.budget_policy === "string"
                ? ledger.metadata.budget_policy
                : null;
            const provider =
              typeof ledger.metadata.provider === "string"
                ? ledger.metadata.provider
                : null;
            const model =
              typeof ledger.metadata.model === "string" ? ledger.metadata.model : null;
            const keyMode =
              typeof ledger.metadata.key_mode_used === "string"
                ? ledger.metadata.key_mode_used
                : null;
            const llmCallId =
              typeof ledger.metadata.llm_call_id === "string"
                ? ledger.metadata.llm_call_id
                : null;
            const llmCallIds = Array.isArray(ledger.metadata.llm_call_ids)
              ? ledger.metadata.llm_call_ids.filter(
                  (item): item is string => typeof item === "string",
                )
              : [];
            const providerRequestId =
              typeof ledger.metadata.provider_request_id === "string"
                ? ledger.metadata.provider_request_id
                : null;
            const providerRequestIds = Array.isArray(
              ledger.metadata.provider_request_ids,
            )
              ? ledger.metadata.provider_request_ids.filter(
                  (item): item is string => typeof item === "string",
                )
              : [];
            const showCallList =
              (llmCallIds.length > 0 && !llmCallId) ||
              llmCallIds.some((id) => id !== llmCallId) ||
              (providerRequestIds.length > 0 && !providerRequestId) ||
              providerRequestIds.some((id) => id !== providerRequestId);
            const inputTokens =
              typeof ledger.metadata.input_tokens === "number"
                ? ledger.metadata.input_tokens
                : null;
            const outputTokens =
              typeof ledger.metadata.output_tokens === "number"
                ? ledger.metadata.output_tokens
                : null;
            const totalTokens =
              typeof ledger.metadata.total_tokens === "number"
                ? ledger.metadata.total_tokens
                : null;
            const latencyMs =
              typeof ledger.metadata.latency_ms === "number"
                ? ledger.metadata.latency_ms
                : null;
            const costMicros =
              typeof ledger.metadata.estimated_cost_usd_micros === "number"
                ? ledger.metadata.estimated_cost_usd_micros
                : null;
            const costStatus =
              typeof ledger.metadata.cost_status === "string"
                ? ledger.metadata.cost_status
                : null;
            const costStatuses = Array.isArray(ledger.metadata.cost_statuses)
              ? ledger.metadata.cost_statuses.filter(
                  (item): item is string => typeof item === "string",
                )
              : [];
            const rerankInputCount =
              typeof ledger.metadata.rerank_input_count === "number"
                ? ledger.metadata.rerank_input_count
                : null;
            const rerankOutputCount =
              typeof ledger.metadata.rerank_output_count === "number"
                ? ledger.metadata.rerank_output_count
                : null;
            const failureCode =
              typeof ledger.metadata.failure_error_code === "string"
                ? ledger.metadata.failure_error_code
                : typeof ledger.metadata.error_code === "string"
                  ? ledger.metadata.error_code
                : null;
            const privateSnippetPolicy =
              typeof ledger.metadata.private_snippet_policy === "string"
                ? ledger.metadata.private_snippet_policy
                : null;
            const privateSnippetReason =
              typeof ledger.metadata.private_snippet_policy_reason === "string"
                ? ledger.metadata.private_snippet_policy_reason
                : null;
            const rerankTrace = rerankTraceItems(
              ledger.metadata.candidate_rerank_trace,
            );
            const retrievalGuidance =
              ledger.metadata.retrieval_guidance &&
              typeof ledger.metadata.retrieval_guidance === "object" &&
              !Array.isArray(ledger.metadata.retrieval_guidance)
                ? (ledger.metadata.retrieval_guidance as Record<string, unknown>)
                : null;
            const guidanceStatus =
              typeof retrievalGuidance?.status === "string"
                ? retrievalGuidance.status
                : null;
            const policy = [
              retrievalMode,
              policyReason,
              rerankMode,
              rerankReason,
              candidateLimit === null ? null : `candidates ${candidateLimit}`,
              selectedLimit === null ? null : `selected cap ${selectedLimit}`,
              queryClass,
            ]
              .filter(Boolean)
              .join(" - ");
            const selectionPolicy = [
              selectionVersion,
              orderingPolicy,
              diversityPolicy,
              budgetPolicy,
            ]
              .filter(Boolean)
              .join(" - ");

            return (
              <li key={ledger.id}>
                <div className={styles.trustLine}>
                  <span>{ledger.strategy}</span>
                  <span className={styles.trustFlags}>{ledger.status}</span>
                </div>
                <div className={styles.trustCode}>
                  {ledger.selected_count}/{ledger.input_count} selected -{" "}
                  {ledger.selected_chars}
                  {ledger.budget_chars ? `/${ledger.budget_chars}` : ""} chars
                </div>
                {policy ? <div className={styles.trustCode}>{policy}</div> : null}
                {selectionPolicy ? (
                  <div className={styles.trustCode}>{selectionPolicy}</div>
                ) : null}
                {contextRoute || contextRouteReason ? (
                  <div className={styles.trustCode}>
                    context {contextRoute ?? "unknown"}
                    {contextRouteReason ? ` - ${contextRouteReason}` : ""}
                  </div>
                ) : null}
                {provider || model || keyMode ? (
                  <div className={styles.trustCode}>
                    reranker {provider ?? "unknown"}/{model ?? "unknown"}
                    {keyMode ? ` - ${keyMode}` : ""}
                  </div>
                ) : null}
                {llmCallId ||
                providerRequestId ||
                latencyMs !== null ||
                costMicros !== null ||
                costStatus ? (
                  <div className={styles.trustCode}>
                    {llmCallId ? `call ${shortId(llmCallId)}` : "call unknown"}
                    {providerRequestId ? ` - request ${providerRequestId}` : ""}
                    {latencyMs === null ? "" : ` - ${latencyMs}ms`}
                    {costMicros === null ? "" : ` - ${costMicros} micros`}
                    {costStatus ? ` - ${costStatus}` : ""}
                  </div>
                ) : null}
                {showCallList ? (
                  <div className={styles.trustCode}>
                    calls {llmCallIds.map(shortId).join(",") || "none"} - requests{" "}
                    {providerRequestIds.join(",") || "none"}
                    {costStatuses.length > 1
                      ? ` - cost statuses ${costStatuses.join(",")}`
                      : ""}
                  </div>
                ) : null}
                {inputTokens !== null || outputTokens !== null || totalTokens !== null ? (
                  <div className={styles.trustCode}>
                    tokens input {inputTokens ?? "unknown"} - output{" "}
                    {outputTokens ?? "unknown"} - total {totalTokens ?? "unknown"}
                  </div>
                ) : null}
                {privateSnippetPolicy || privateSnippetReason ? (
                  <div className={styles.trustCode}>
                    private snippets {privateSnippetPolicy ?? "unknown"}
                    {privateSnippetReason ? ` - ${privateSnippetReason}` : ""}
                  </div>
                ) : null}
                {rerankInputCount !== null || rerankOutputCount !== null || failureCode ? (
                  <div className={styles.trustCode}>
                    rerank {rerankOutputCount ?? "unknown"}/
                    {rerankInputCount ?? "unknown"} output/input
                    {failureCode ? ` - ${failureCode}` : ""}
                  </div>
                ) : null}
                {guidanceStatus && guidanceStatus !== "unused" ? (
                  <div className={styles.trustCode}>
                    retrieval guidance {guidanceStatus}
                  </div>
                ) : null}
                {rerankTrace.length > 0 ? (
                  <ol className={styles.trustNestedList}>
                    {rerankTrace.map((item, index) => (
                      <li
                        key={`${item.sourceId ?? "candidate"}:${item.from ?? index}:${item.to ?? index}`}
                      >
                        <div className={styles.trustLine}>
                          <span>
                            rerank {item.from ?? "?"} -&gt; {item.to ?? "?"}
                            {item.sourceId ? `: ${item.sourceId}` : ""}
                          </span>
                          <span className={styles.trustFlags}>
                            {item.selected ? "selected" : "candidate"} /{" "}
                            {item.includedInPrompt ? "included" : "not included"}
                          </span>
                        </div>
                        <div className={styles.trustCode}>
                          {item.providerReason ?? item.reason ?? "provider_rank"}
                          {item.providerScore === null
                            ? ""
                            : ` - provider ${item.providerScore.toFixed(3)}`}
                          {item.selectionScore === null
                            ? ""
                            : ` - selection ${item.selectionScore.toFixed(3)}`}
                          {item.score === null ? "" : ` - base ${item.score.toFixed(3)}`}
                          {item.citationQuality === null
                            ? ""
                            : ` - citation ${item.citationQuality.toFixed(3)}`}
                          {item.selectionStatus ? ` - ${item.selectionStatus}` : ""}
                          {item.resultType ? ` - ${item.resultType}` : ""}
                          {item.selectionReason ? ` - ${item.selectionReason}` : ""}
                        </div>
                        {item.source ||
                        item.section ||
                        item.lexical !== null ||
                        item.sourcePenalty !== null ||
                        item.sectionPenalty !== null ? (
                          <div className={styles.trustCode}>
                            {item.source ? `source ${item.source}` : ""}
                            {item.section ? ` - section ${item.section}` : ""}
                            {item.lexical === null
                              ? ""
                              : ` - lexical ${item.lexical.toFixed(3)}`}
                            {item.sourcePenalty === null
                              ? ""
                              : ` - source penalty ${item.sourcePenalty.toFixed(3)}`}
                            {item.sectionPenalty === null
                              ? ""
                              : ` - section penalty ${item.sectionPenalty.toFixed(3)}`}
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
    </li>
  );
}

function RetrievalRow({ retrieval }: { retrieval: MessageRetrieval }) {
  const snippet =
    retrieval.exact_snippet ||
    ("snippet" in retrieval.result_ref && typeof retrieval.result_ref.snippet === "string"
      ? retrieval.result_ref.snippet
      : "");

  return (
    <li>
      <div className={styles.trustLine}>
        <span>
          retrieval {retrieval.ordinal}:{" "}
          {retrieval.source_title || retrieval.section_label || retrieval.source_id}
        </span>
        <span className={styles.trustFlags}>
          {retrieval.selected ? "selected" : "retrieved"} /{" "}
          {retrieval.included_in_prompt ? "included" : "not included"} /{" "}
          {retrieval.cited_edge_id ? "cited" : "uncited"}
        </span>
      </div>
      {snippet ? <p className={styles.trustSnippet}>{snippet}</p> : null}
      <div className={styles.trustCode}>
        {retrieval.id ? `retrieval ${shortId(retrieval.id)} - ` : ""}
        {retrieval.result_type}:{retrieval.source_id}
        {retrieval.score !== null && retrieval.score !== undefined
          ? ` - score ${retrieval.score.toFixed(3)}`
          : ""}
        {retrieval.cited_edge_id ? ` - edge ${shortId(retrieval.cited_edge_id)}` : ""}
        {retrieval.citation_number ? ` - [${retrieval.citation_number}]` : ""}
        {retrieval.included_in_prompt_source
          ? ` - source ${retrieval.included_in_prompt_source}`
          : ""}
      </div>
    </li>
  );
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function rerankTraceItems(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && !Array.isArray(item),
    )
    .map((item) => ({
      from: typeof item.from === "number" ? item.from : null,
      to: typeof item.to === "number" ? item.to : null,
      sourceId: typeof item.source_id === "string" ? item.source_id : null,
      source: typeof item.source === "string" ? item.source : null,
      section: typeof item.section === "string" ? item.section : null,
      reason: typeof item.reason === "string" ? item.reason : null,
      resultType: typeof item.result_type === "string" ? item.result_type : null,
      score: typeof item.score === "number" ? item.score : null,
      selectionScore:
        typeof item.selection_score === "number" ? item.selection_score : null,
      lexical: typeof item.lexical === "number" ? item.lexical : null,
      citationQuality:
        typeof item.citation_quality === "number" ? item.citation_quality : null,
      sourcePenalty:
        typeof item.source_penalty === "number" ? item.source_penalty : null,
      sectionPenalty:
        typeof item.section_penalty === "number" ? item.section_penalty : null,
      providerReason:
        typeof item.provider_reason === "string" ? item.provider_reason : null,
      providerScore:
        typeof item.provider_score === "number" ? item.provider_score : null,
      selectionReason:
        typeof item.selection_reason === "string" ? item.selection_reason : null,
      selectionStatus:
        typeof item.selection_status === "string" ? item.selection_status : null,
      selected: item.selected === true,
      includedInPrompt: item.included_in_prompt === true,
    }));
}
