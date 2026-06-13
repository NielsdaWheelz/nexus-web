"use client";

import { AlertTriangle, Search, Wrench } from "lucide-react";
import { toReaderCitationData } from "@/lib/conversations/citations";
import type {
  AssistantTrustTrail,
  MessageRetrieval,
  MessageToolCall,
} from "@/lib/conversations/types";
import type { ReaderSourceTarget } from "@/lib/conversations/readerTarget";
import styles from "./MessageRow.module.css";

export default function AssistantTrustInspector({
  trustTrail,
  onCitationActivate,
}: {
  trustTrail: AssistantTrustTrail;
  onCitationActivate?: (target: ReaderSourceTarget, event?: React.MouseEvent) => void;
}) {
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
                      {citation.target && onCitationActivate ? (
                        <button
                          type="button"
                          onClick={(event) =>
                            citation.target
                              ? onCitationActivate(citation.target, event)
                              : undefined
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
        {typeof tool.latency_ms === "number" ? ` - ${tool.latency_ms}ms` : ""}
      </div>
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
          {tool.rerank_ledgers.map((ledger) => (
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
            </li>
          ))}
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
