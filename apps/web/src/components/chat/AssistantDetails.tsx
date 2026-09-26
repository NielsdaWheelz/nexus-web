"use client";

import { AlertTriangle, Search, Wrench } from "lucide-react";
import { toReaderCitationData } from "@/lib/resourceGraph/citations";
import { formatDisplayNumber } from "@/lib/display/format";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import type {
  AssistantTrustTrail,
  MessageRetrieval,
  MessageToolCall,
} from "@/lib/conversations/types";
import type { ReaderSourceTarget } from "@/lib/conversations/readerTarget";
import type { ResourceActivation } from "@/lib/resources/activation";
import styles from "./MessageRow.module.css";

export default function AssistantDetails({
  trustTrail,
  onCitationActivate,
}: {
  trustTrail: AssistantTrustTrail;
  onCitationActivate: (
    activation: ResourceActivation,
    target: ReaderSourceTarget | null,
    event?: React.MouseEvent,
  ) => void;
}) {
  const display = useRenderEnvironment();
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
      tool.retrievals.filter((retrieval) => retrieval.included_in_prompt)
        .length,
    0,
  );
  const contextRefs = trustTrail.context_refs_added.length;
  const warnings = trustTrail.integrity_notices.length;

  return (
    <details className={styles.details}>
      <summary>
        Details
        {warnings > 0
          ? ` ${warnings} ${warnings === 1 ? "notice" : "notices"}`
          : ""}
      </summary>
      <div className={styles.trustInspectorPanel}>
        <section>
          <h2>Activity</h2>
          <p>
            {trustTrail.tool_calls.length} tools · {retrieved} retrieved ·{" "}
            {selected} selected · {included} included ·{" "}
            {trustTrail.citations.length} cited · {contextRefs} context refs
          </p>
        </section>
        {trustTrail.run ? (
          <section>
            <h2>Run</h2>
            <dl className={styles.trustMeta}>
              <div>
                <dt>Route / provider</dt>
                <dd>{trustTrail.run.run_selection.display_at_dispatch.route_label}</dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>{trustTrail.run.run_selection.display_at_dispatch.model_label}</dd>
              </div>
              <div>
                <dt>Reasoning</dt>
                <dd>{trustTrail.run.run_selection.display_at_dispatch.reasoning_label}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>
                  {trustTrail.run.status}
                  {trustTrail.run.error_code
                    ? ` - ${trustTrail.run.error_code}`
                    : ""}
                </dd>
              </div>
              <div>
                <dt>Billing</dt>
                <dd>{trustTrail.run.run_selection.display_at_dispatch.billing.label}</dd>
              </div>
              <div>
                <dt>Processors</dt>
                <dd>{trustTrail.run.run_selection.display_at_dispatch.processor_chain.processors.join(" → ")}</dd>
              </div>
              <div>
                <dt>Privacy</dt>
                <dd>{trustTrail.run.run_selection.display_at_dispatch.privacy.summary}</dd>
              </div>
              <div>
                <dt>Retention</dt>
                <dd>{trustTrail.run.run_selection.display_at_dispatch.privacy.retention}</dd>
              </div>
              <div>
                <dt>Training</dt>
                <dd>{trustTrail.run.run_selection.display_at_dispatch.privacy.training}</dd>
              </div>
              <div>
                <dt>Write authority</dt>
                <dd>{trustTrail.run.run_selection.tool_authority === "AdditiveWrites" ? "Additive writes" : "Read-only"}</dd>
              </div>
              {trustTrail.run.publication_warning.kind === "Present" ? (
                <div>
                  <dt>Publication</dt>
                  <dd>{trustTrail.run.publication_warning.value.code}</dd>
                </div>
              ) : null}
              {trustTrail.run.support_id.kind === "Present" ? (
                <div>
                  <dt>Support ID</dt>
                  <dd>{trustTrail.run.support_id.value}</dd>
                </div>
              ) : null}
              {trustTrail.run.failure ? (
                <div>
                  <dt>Failure</dt>
                  <dd>{trustTrail.run.failure.code}</dd>
                </div>
              ) : null}
              <div>
                <dt>Output</dt>
                <dd>{trustTrail.run.final_chars ?? 0} chars</dd>
              </div>
              {typeof trustTrail.run.usage?.input_tokens === "number" ? (
                <div>
                  <dt>Input</dt>
                  <dd>
                    {formatDisplayNumber(
                      trustTrail.run.usage.input_tokens,
                      display,
                    )}{" "}
                    tokens
                  </dd>
                </div>
              ) : null}
              {typeof trustTrail.run.usage?.output_tokens === "number" ? (
                <div>
                  <dt>Output tokens</dt>
                  <dd>
                    {formatDisplayNumber(
                      trustTrail.run.usage.output_tokens,
                      display,
                    )}{" "}
                    tokens
                  </dd>
                </div>
              ) : null}
            </dl>
          </section>
        ) : null}

        {trustTrail.prompt ? (
          <section>
            <h2>Prompt</h2>
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
                <dd>{trustTrail.prompt.reserved_output_tokens} output tokens</dd>
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
            <h2>Tools</h2>
            <ol className={styles.trustToolList}>
              {trustTrail.tool_calls.map((tool) => (
                <ToolRow key={tool.id ?? tool.tool_call_index} tool={tool} />
              ))}
            </ol>
          </section>
        ) : null}

        {trustTrail.citations.length > 0 ? (
          <section>
            <h2>Citations</h2>
            <ol className={styles.trustNestedList}>
              {trustTrail.citations.map((item) => {
                const citation = toReaderCitationData(item.citation);
                return (
                  <li key={item.citation_edge_id}>
                    <div className={styles.trustLine}>
                      <Search size={13} aria-hidden="true" />
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
                    </div>
                    <div className={styles.trustCode}>
                      edge {shortId(item.citation_edge_id)}
                      {item.retrieval_id
                        ? ` - retrieval ${shortId(item.retrieval_id)}`
                        : ""}
                      {item.tool_call_id
                        ? ` - tool ${shortId(item.tool_call_id)}`
                        : ""}
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        ) : null}

        {trustTrail.context_refs_added.length > 0 ? (
          <section>
            <h2>Context refs</h2>
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
            <h2>Notices</h2>
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
  const authorships = tool.machine_authorships ?? [];
  return (
    <li>
      <div className={styles.trustLine}>
        <Wrench size={13} aria-hidden="true" />
        <span>
          #{tool.tool_call_index} {tool.activity_label} - {tool.status}
          {tool.error_type ? ` - ${tool.error_type}` : ""}
        </span>
      </div>
      <div className={styles.trustCode}>
        {tool.canonical_tool_id ?? tool.provider_wire_name ?? tool.record_kind} - tool{" "}
        {tool.id ? shortId(tool.id) : "pending"} - {tool.scope ?? "all"} -{" "}
        {tool.result_count ?? tool.result_refs.length} results /{" "}
        {tool.selected_count ?? tool.selected_context_refs.length} selected
        {typeof tool.latency_ms === "number" ? ` - ${tool.latency_ms}ms` : ""}
      </div>
      {authorships.length > 0 ? (
        <ol className={styles.trustNestedList} aria-label="Machine authorship">
          {authorships.map((authorship) => (
            <li key={`${authorship.target_kind}:${authorship.target_id}`}>
              <div className={styles.trustLine}>
                <span>
                  Assistant-created {authorship.target_kind.replaceAll("_", " ")}
                </span>
              </div>
              <div className={styles.trustCode}>
                {authorship.position_path}
              </div>
            </li>
          ))}
        </ol>
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
    </li>
  );
}

function RetrievalRow({ retrieval }: { retrieval: MessageRetrieval }) {
  const snippet =
    retrieval.exact_snippet ||
    ("snippet" in retrieval.result_ref &&
    typeof retrieval.result_ref.snippet === "string"
      ? retrieval.result_ref.snippet
      : "");

  return (
    <li>
      <div className={styles.trustLine}>
        <span>
          retrieval {retrieval.ordinal}:{" "}
          {retrieval.source_title ||
            retrieval.section_label ||
            retrieval.source_id}
        </span>
        <span className={styles.trustFlags}>
          {retrieval.selected ? "selected" : "retrieved"} /{" "}
          {retrieval.included_in_prompt ? "included" : "not included"} /{" "}
          {retrieval.citation_candidate_ordinal.kind === "Present"
            ? `candidate [${retrieval.citation_candidate_ordinal.value}]`
            : "not a candidate"}{" "}
          / {retrieval.cited_edge_id ? "cited" : "uncited"}
        </span>
      </div>
      {snippet ? <p className={styles.trustSnippet}>{snippet}</p> : null}
      <div className={styles.trustCode}>
        {retrieval.id ? `retrieval ${shortId(retrieval.id)} - ` : ""}
        {retrieval.result_type}:{retrieval.source_id}
        {retrieval.score !== null && retrieval.score !== undefined
          ? ` - score ${retrieval.score.toFixed(3)}`
          : ""}
        {retrieval.cited_edge_id
          ? ` - edge ${shortId(retrieval.cited_edge_id)}`
          : ""}
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
