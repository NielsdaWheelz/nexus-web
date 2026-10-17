"use client";

import { useState } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { undoAssistantWrite, undoFailureMessage } from "@/lib/assistantWrites";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { Message } from "@/lib/chat/wire";
import { formatDisplayNumber, truncateText } from "@/lib/display/format";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import ResourceOutlineList from "@/components/resources/ResourceOutlineList";
import ResourceOutlineRow from "@/components/resources/ResourceOutlineRow";
import styles from "./ChatSurface.module.css";

type Trail = NonNullable<Message["trust_trail"]>;
const KICKERS: Record<string, string> = {
  entry: "Filed to",
  highlight: "Highlighted",
  edge: "Connected",
  note_block: "Noted in",
  queue: "Queued",
};

/** Completed writes remain visible because they changed the user's world. */
export default function AssistantTrust({ message }: { message: Message }) {
  return message.trust_trail ? <WriteTrail trail={message.trust_trail} /> : null;
}

/** Assistant writes; Undo only where a created target is proven and not yet undone. */
function WriteTrail({ trail }: { trail: Trail }) {
  const [undone, setUndone] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<
    { message: string } | { defect: unknown } | null
  >(null);
  if (failure && "defect" in failure) throw failure.defect;
  const writes = trail.tool_calls.filter(
    (t) =>
      t.effect === "Write" &&
      t.result_kind === "mutation" &&
      t.status === "complete",
  );
  if (!writes.length) return null;
  const undo = async (id: string) => {
    setBusy(true);
    try {
      await undoAssistantWrite(id);
      setUndone(new Set(undone).add(id));
    } catch (error) {
      if (!handleUnauthenticatedApiError(error)) {
        try {
          setFailure({ message: undoFailureMessage(error) });
        } catch (defect) {
          setFailure({ defect });
        }
      }
    }
    setBusy(false);
  };
  return (
    <div role="list" aria-label="Assistant actions">
      {failure && "message" in failure ? (
        <FeedbackNotice
          announcement="Assertive"
          content={{
            tone: "Warning",
            title: "Undo unavailable",
            message: failure.message,
          }}
        />
      ) : null}
      {writes.map((tool) => {
        const ref = tool.created_refs[0];
        const kicker = ref ? KICKERS[ref.kind] : "Assistant action";
        const target = ref ? truncateText(ref.label, 80) : tool.activity_label;
        const authorship = tool.machine_authorships[0];
        return (
          <div key={tool.id} className={styles.write} role="listitem">
            <span className={styles.kicker}>{kicker}</span>
            <span>
              <em>{target}</em>
              <span className={styles.code}>
                {tool.canonical_tool_id === "memory.save_note"
                  ? "Saved in shared memory"
                  : authorship
                  ? `Assistant-created · ${authorship.position_path}`
                  : "No new target created"}
              </span>
            </span>
            {tool.reverted_at || undone.has(tool.id) ? (
              <span className={styles.kicker}>Undone</span>
            ) : authorship ? (
              <button
                type="button"
                className={styles.kicker}
                disabled={busy || failure !== null}
                onClick={() => void undo(tool.id)}
                aria-label={`Undo: ${kicker} ${target}`}
              >
                Undo
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** The complete saved trust report, shown only when information is requested. */
export function AssistantReport({ message }: {
  message: Message;
}) {
  const display = useRenderEnvironment();
  const trail = message.trust_trail;
  if (!trail) return null;
  const messageId = message.id;
  const run = trail.run;
  const shown = run?.run_selection.display_at_dispatch;
  const retrievals = [
    ...trail.attached,
    ...trail.tool_calls.flatMap((tool) => tool.retrievals),
  ];
  const count = (n: unknown) =>
    typeof n === "number" ? `${formatDisplayNumber(n, display)} tokens` : null;
  const facts = {
    "Route / provider": shown?.route_label,
    Model: shown?.model_label,
    Thinking: shown?.reasoning_label,
    Status:
      run && `${run.status}${run.error_code ? ` - ${run.error_code}` : ""}`,
    Billing: shown?.billing.label,
    Privacy: shown?.privacy.summary,
    Input: count(run?.usage?.input_tokens),
    Output: count(run?.usage?.output_tokens),
    "Support ID":
      run?.support_id != null ? run.support_id : null,
  };
  return (
    <div className={styles.inspector}>
        <p>
          {trail.tool_calls.length} tools · {retrievals.length} retrieved ·{" "}
          {retrievals.filter((r) => r.selected).length} selected ·{" "}
          {retrievals.filter((r) => r.included_in_prompt).length} included ·{" "}
          {trail.citations.length} cited · {trail.context_refs_added.length}{" "}
          context refs
        </p>
        <dl>
          {Object.entries(facts).map(([term, value]) =>
            value != null ? (
              <div key={term}>
                <dt>{term}</dt>
                <dd>{value}</dd>
              </div>
            ) : null,
          )}
        </dl>
        {trail.attached.length ? (
          <ol aria-label="Attached context">
            <li>
              Attached context
              {trail.attached.map((r) => (
                <Retrieval key={r.id} retrieval={r} occurrenceKey={`attached:${messageId}:${r.id}`} />
              ))}
            </li>
          </ol>
        ) : null}
        {trail.tool_calls.length ? (
          <ol aria-label="Tools">
            {trail.tool_calls.map((tool) => (
              <li key={tool.id}>
                #{tool.tool_call_index} {tool.activity_label} - {tool.status}
                {tool.error_type ? ` - ${tool.error_type}` : ""}
                {tool.retrievals.map((r) => (
                  <Retrieval key={r.id} retrieval={r} occurrenceKey={`tool:${tool.id}:${r.id}`} />
                ))}
              </li>
            ))}
          </ol>
        ) : null}
        {trail.citations.length ? <ResourceOutlineList scope={`message-citations:${messageId}`} ariaLabel="Citations">
          {trail.citations.map(({ citation }) => <ResourceOutlineRow key={citation.edge_id} item={citation.item} occurrenceKey={`detail-citation:${citation.edge_id}`} historical occurrenceLabel={`citation ${citation.ordinal}`} />)}
        </ResourceOutlineList> : null}
        {trail.context_refs_added.length ? <ResourceOutlineList scope={`message-context:${messageId}`} ariaLabel="Added context">
          {trail.context_refs_added.map((ref) => <ResourceOutlineRow key={`${ref.chat_run_event_seq}:${ref.id}`} item={ref.item} occurrenceKey={`added-context:${messageId}:${ref.chat_run_event_seq}:${ref.id}`} />)}
        </ResourceOutlineList> : null}
    </div>
  );
}

function Retrieval({ retrieval: r, occurrenceKey }: { retrieval: Trail["attached"][number]; occurrenceKey: string }) {
  return <ResourceOutlineList scope={occurrenceKey} ariaLabel="Retrieved resource">
    <ResourceOutlineRow item={r.item} occurrenceKey={occurrenceKey} historical occurrenceLabel={`${r.selected ? "selected" : "retrieved"}${r.included_in_prompt ? " · included" : ""}${r.cited_edge_id ? " · cited" : ""}`} />
  </ResourceOutlineList>;
}
