"use client";

import { useState, type ReactNode } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { undoToolCall } from "@/lib/chat/toolCallUndo";
import { chatFailure, type ChatFailure, type Message } from "@/lib/chat/wire";
import { formatDisplayNumber, truncateText } from "@/lib/display/format";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { toReaderCitationData } from "@/lib/resourceGraph/citations";
import type { CitationOut } from "@/lib/resourceGraph/citationOut";
import type { ActivateSource } from "./ChatSurface";
import styles from "./ChatSurface.module.css";

type Trail = NonNullable<Message["trust_trail"]>;
const KICKERS: Record<string, string> = {
  entry: "Filed to",
  highlight: "Highlighted",
  edge: "Connected",
  note_block: "Noted in",
  queue: "Queued",
};

/** What an answer did and used: its write trail, its sources, its details. */
export default function AssistantTrust({
  message,
  activate,
}: {
  message: Message;
  activate: ActivateSource;
}) {
  const trail = message.trust_trail;
  const cite = (citation: CitationOut, label: (title: string) => string) => {
    const data = toReaderCitationData(citation);
    return (
      <button
        type="button"
        className={styles.link}
        onClick={(event) => activate(data.activation, data.target, event)}
      >
        {label(data.preview.title || `Source ${data.index}`)}
      </button>
    );
  };
  if (!trail) return null;
  return (
    <>
      <WriteTrail trail={trail} />
      {message.citations.length ? (
        <details className={styles.sources}>
          <summary>Sources ({message.citations.length})</summary>
          <ol aria-label="Sources">
            {message.citations.map((citation) => (
              <li key={citation.ordinal}>
                {cite(citation, (title) => `${citation.ordinal}. ${title}`)}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      <Details trail={trail} cite={cite} />
    </>
  );
}

/** Assistant writes; Undo only where a created target is proven and not yet undone. */
function WriteTrail({ trail }: { trail: Trail }) {
  const [undone, setUndone] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ChatFailure | null>(null);
  if (failure?.kind === "Defect") throw failure.error;
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
      await undoToolCall(trail.conversation_id, id);
      setUndone(new Set(undone).add(id));
    } catch (error) {
      setFailure(chatFailure(error, "Undo unavailable"));
    }
    setBusy(false);
  };
  return (
    <div role="list" aria-label="Assistant actions">
      {failure && failure.kind !== "Handled" ? (
        <FeedbackNotice
          announcement="Assertive"
          content={{
            tone: "Warning",
            title: "Undo unavailable",
            message:
              "Reload the conversation to check this write before trying again.",
            requestId:
              failure.kind === "Reload" ? failure.requestId : undefined,
          }}
        />
      ) : null}
      {writes.map((tool) => {
        const ref = tool.result_refs.find((r) => typeof r.kind === "string");
        const label = tool.result_refs
          .map((r) => r.label)
          .find((l) => typeof l === "string");
        const kicker = KICKERS[String(ref?.kind)] ?? "Assistant action";
        const target =
          typeof label === "string"
            ? truncateText(label, 80)
            : tool.activity_label;
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

/** Closed by default: the run, counts, notices, tools and retrievals, citations and context refs. */
function Details({
  trail,
  cite,
}: {
  trail: Trail;
  cite(citation: CitationOut, label: (title: string) => string): ReactNode;
}) {
  const display = useRenderEnvironment();
  const run = trail.run;
  const shown = run?.run_selection.display_at_dispatch;
  const retrievals = trail.tool_calls.flatMap((tool) => tool.retrievals);
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
      run?.support_id.kind === "Present" ? run.support_id.value : null,
    Notices: trail.integrity_notices.map((n) => n.message).join(" · "),
  };
  const notices = trail.integrity_notices.length;
  return (
    <details className={styles.details}>
      <summary>
        Details
        {notices ? ` ${notices} ${notices === 1 ? "notice" : "notices"}` : ""}
      </summary>
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
            value ? (
              <div key={term}>
                <dt>{term}</dt>
                <dd>{value}</dd>
              </div>
            ) : null,
          )}
        </dl>
        {trail.tool_calls.length ? (
          <ol aria-label="Tools">
            {trail.tool_calls.map((tool) => (
              <li key={tool.id}>
                #{tool.tool_call_index} {tool.activity_label} - {tool.status}
                {tool.error_type ? ` - ${tool.error_type}` : ""}
                {tool.retrievals.map((r) => (
                  <span key={r.id} className={styles.code}>
                    {r.source_title || r.source_id} —{" "}
                    {r.selected ? "selected" : "retrieved"}
                    {r.included_in_prompt ? " · included" : ""}
                    {r.cited_edge_id ? " · cited" : ""}
                  </span>
                ))}
              </li>
            ))}
          </ol>
        ) : null}
        {trail.citations.length ? (
          <ol aria-label="Citations">
            {trail.citations.map((item) => (
              <li key={item.citation_edge_id}>
                {cite(item.citation, (title) => `[${item.ordinal}] ${title}`)}
              </li>
            ))}
          </ol>
        ) : null}
        {trail.context_refs_added.length ? (
          <ol aria-label="Context refs">
            {trail.context_refs_added.map((ref) => (
              <li key={`${ref.chat_run_event_seq}:${ref.id}`}>
                {ref.label || ref.resource_ref} —{" "}
                {ref.missing ? "missing" : "added"}
                <span className={styles.code}>{ref.resource_ref}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </details>
  );
}
