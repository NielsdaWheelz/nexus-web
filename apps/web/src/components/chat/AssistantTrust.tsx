"use client";

import { useState } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { undoAssistantWrite, undoFailureMessage } from "@/lib/assistantWrites";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { MessageAction } from "@/lib/chat/runTail";
import styles from "./ChatSurface.module.css";

const KICKERS: Record<string, string> = {
  entry: "Filed to",
  highlight: "Highlighted",
  edge: "Connected",
  note_block: "Noted in",
  queue: "Queued",
};

/** Completed writes stay visible; only a saved authorship can authorize undo. */
export default function AssistantTrust({ actions, undone, onUndone }: {
  actions: readonly MessageAction[];
  undone: ReadonlySet<string>;
  onUndone(id: string): void;
}) {
  const [busy, setBusy] = useState(false);
  // A refused undo says so until the next undo; it never disables the other writes.
  const [failure, setFailure] = useState<{ message: string } | { defect: unknown } | null>(null);
  if (failure && "defect" in failure) throw failure.defect;
  const writes = actions.filter(
    (tool) => tool.effect === "Write" && tool.result_kind === "mutation" &&
      (tool.status === "complete" || (tool.canonical_tool_id === "memory.save_note" && tool.status !== "running" &&
        !["InvalidInput", "BudgetExceeded", "ToolUnavailable"].includes(tool.error_type ?? ""))),
  );
  if (!writes.length) return null;
  const undo = async (id: string) => {
    setBusy(true);
    setFailure(null);
    try {
      await undoAssistantWrite(id);
      onUndone(id);
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
  return <div role="list" aria-label="Assistant actions">
    {failure && "message" in failure ? <FeedbackNotice
      announcement="Assertive"
      content={{ tone: "Warning", title: "Undo unavailable", message: failure.message }}
    /> : null}
    {writes.map((tool) => {
      const ref = tool.created_refs[0];
      const authorship = tool.machine_authorships[0];
      const kicker = ref ? KICKERS[ref.kind] : tool.activity.verb;
      const target = ref?.label ?? tool.activity.subject;
      const reverted = tool.reverted_at !== null || (tool.id !== null && undone.has(tool.id));
      return <div key={tool.tool_call_index} className={styles.write} role="listitem">
        <span className={styles.kicker}>{kicker}</span>
        {target || tool.activity.outcome ? <span>
          {target ? <em>{target}</em> : null}
          {tool.activity.outcome ? <span>{target ? " · " : ""}{tool.activity.outcome}</span> : null}
        </span> : null}
        {reverted ? <span className={styles.kicker}>Undone</span>
          : authorship && tool.id !== null ? <button type="button" className={styles.kicker}
            disabled={busy}
            onClick={() => { if (tool.id !== null) void undo(tool.id); }}
            aria-label={`Undo: ${kicker}${target ? ` ${target}` : ""}`}>Undo</button> : null}
      </div>;
    })}
  </div>;
}
