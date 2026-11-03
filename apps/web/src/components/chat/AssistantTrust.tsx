"use client";

import Button from "@/components/ui/Button";

import { useState } from "react";
import { Hold, useOutcome, useResendFeedback } from "@/components/feedback/Feedback";
import { isRefusal, outcomeUnknown } from "@/lib/api/client";
import { undoAssistantWrite, UNDO_REFUSED } from "@/lib/assistantWrites";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import type { MessageAction } from "@/lib/chat/runTail";
import styles from "./ChatSurface.module.css";

const KICKERS: Record<string, string> = {
  entry: "Filed to",
  highlight: "Highlighted",
  edge: "Connected",
  note_block: "Noted in",
  queue: "Queued",
};

/** Completed writes stay visible; only a saved authorship can authorize undo. An undo whose answer
 * never came is held until the next undo answers; undo is idempotent, so its retry resends. */
export default function AssistantTrust({ actions, undone, onUndone }: {
  actions: readonly MessageAction[];
  undone: ReadonlySet<string>;
  onUndone(id: string): void;
}) {
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState<{ id: string; attempt: number } | null>(null);
  const { fail } = useOutcome();
  const resendFeedback = useResendFeedback();
  const writes = actions.filter(
    (tool) => tool.effect === "Write" && tool.result_kind === "mutation" &&
      (tool.status === "complete" || (tool.canonical_tool_id === "memory.save_note" && tool.status !== "running" &&
        !["InvalidInput", "BudgetExceeded", "ToolUnavailable"].includes(tool.error_type ?? ""))),
  );
  if (!writes.length) return null;
  const retry = (id: string) => ({ label: "retry", commandKey: `undo ${id}`, busy, run: () => void undo(id) });
  const undo = async (id: string) => {
    setBusy(true);
    try {
      await undoAssistantWrite(id);
      onUndone(id);
      setUnknown(null);
    } catch (error) {
      if (handleUnauthenticatedApiError(error)) {
        // the document is leaving for sign-in
      } else if (outcomeUnknown(error) || (isRefusal(error) && unknown?.id === id)) {
        setUnknown((current) => ({ id, attempt: (current?.id === id ? current.attempt : 0) + 1 }));
      } else {
        setUnknown(null);
        fail(error, UNDO_REFUSED, retry(id));
      }
    }
    setBusy(false);
  };
  return <div role="list" aria-label="Assistant actions">
    {unknown ? <Hold id={`undo:${unknown.id}`} attempt={unknown.attempt} {...resendFeedback({
      line: { fact: "not sure that was undone.", reason: UNKNOWN_OUTCOME_REASON }, resend: retry(unknown.id),
    })} /> : null}
    {writes.map((tool) => {
      const ref = tool.created_refs[0];
      const historicalFiling = tool.created_refs.some(ref => ref.kind === "entry" && ref.order_revision === null);
      const kicker = ref?.field === "annotation" ? "Annotated" : ref ? KICKERS[ref.kind] : tool.activity.verb;
      const target = ref?.label ?? tool.activity.subject;
      const reverted = tool.reverted_at !== null || (tool.id !== null && undone.has(tool.id));
      return <div key={tool.tool_call_index} className={styles.write} role="listitem">
        <span className={styles.kicker}>{kicker}</span>
        {target || tool.activity.outcome ? <span>
          {target ? <em>{target}</em> : null}
          {tool.activity.outcome ? <span>{target ? " · " : ""}{tool.activity.outcome}</span> : null}
        </span> : null}
        {reverted ? <span className={styles.kicker}>undone</span>
          : tool.undo_allowed && tool.id !== null ? <Button
            disabled={busy || (unknown !== null && tool.id !== unknown.id)} aria-busy={busy}
            onClick={() => { if (tool.id !== null) void undo(tool.id); }}
            aria-label={`Undo: ${kicker}${target ? ` ${target}` : ""}`}>Undo</Button> : historicalFiling ? <span className={styles.kicker}>older filings can’t be undone.</span> : null}
      </div>;
    })}
  </div>;
}
