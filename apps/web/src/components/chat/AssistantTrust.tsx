"use client";

import Button from "@/components/ui/Button";

import { useState } from "react";
import { Hold, useOutcome } from "@/components/feedback/Feedback";
import { isApiError, outcomeUnknown } from "@/lib/api/client";
import { undoAssistantWrite, undoReason, UNDO_REFUSED } from "@/lib/assistantWrites";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { MAY_HAVE } from "@/lib/chat/commands";
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
  const { say, fail } = useOutcome();
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
      } else if (outcomeUnknown(error)) {
        setUnknown((current) => ({ id, attempt: (current?.id === id ? current.attempt : 0) + 1 }));
      } else {
        setUnknown(null);
        const reason = isApiError(error) ? undoReason(error) : null;
        if (reason === null) fail(error, UNDO_REFUSED, retry(id));
        else say({ fact: UNDO_REFUSED, reason });
      }
    }
    setBusy(false);
  };
  return <div role="list" aria-label="Assistant actions">
    {unknown ? <Hold id={`undo:${unknown.id}`} attempt={unknown.attempt} line={{ fact: "not sure that was undone.", reason: MAY_HAVE }}
      verbs={[retry(unknown.id)]} /> : null}
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
            disabled={busy} aria-busy={busy}
            onClick={() => { if (tool.id !== null) void undo(tool.id); }}
            aria-label={`Undo: ${kicker}${target ? ` ${target}` : ""}`}>Undo</Button> : historicalFiling ? <span className={styles.kicker}>older filings can’t be undone.</span> : null}
      </div>;
    })}
  </div>;
}
