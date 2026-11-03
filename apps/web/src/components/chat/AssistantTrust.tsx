"use client";

import Button from "@/components/ui/Button";

import { useEffect, useId } from "react";
import { Hold, useOutcome, useResendFeedback } from "@/components/feedback/Feedback";
import { isRefusal, outcomeUnknown } from "@/lib/api/client";
import { undoAssistantWrite, UNDO_REFUSED } from "@/lib/assistantWrites";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { admissionReason, UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import type { MessageAction } from "@/lib/chat/runTail";
import styles from "./ChatSurface.module.css";

const KICKERS: Record<string, string> = {
  entry: "Filed to",
  highlight: "Highlighted",
  edge: "Connected",
  note_block: "Noted in",
  queue: "Queued",
};

/** Saved authorship authorizes undo. Its exact target belongs to the visit through dispatch and
 * uncertainty; acceptance or an observed reversion settles it. Undo is idempotent. */
export default function AssistantTrust({ messageId, actions, undone, onUndone }: {
  messageId: string;
  actions: readonly MessageAction[];
  undone: ReadonlySet<string>;
  onUndone(id: string): void;
}) {
  const draft = useResourceDraft<{ id: string; attempt: number; busy: boolean } | null>(`Chat.Undo:${messageId}`, () => null,
    value => ({ changed: false, unconfirmed: value !== null, stopsBrowserWork: false }));
  const { set: setPending } = draft;
  const pending = draft.value;
  const busy = pending?.busy ?? false;
  const unknown = pending !== null && pending.attempt > 0 ? pending : null;
  const waitsId = useId();
  const otherId = useId();
  useEffect(() => {
    if (pending && actions.some(tool => tool.id === pending.id && tool.reverted_at !== null)) setPending(null);
  }, [pending, actions, setPending]);
  const { fail } = useOutcome();
  const resendFeedback = useResendFeedback();
  const writes = actions.filter(
    (tool) => tool.effect === "Write" && tool.result_kind === "mutation" &&
      (tool.status === "complete" || (tool.canonical_tool_id === "memory.save_note" && tool.status !== "running" &&
        !["InvalidInput", "BudgetExceeded", "ToolUnavailable"].includes(tool.error_type ?? ""))),
  );
  if (!writes.length && pending === null) return null;
  const retry = (id: string) => ({ label: "retry", commandKey: `undo ${id}`, busy, run: () => void undo(id) });
  const undo = async (id: string) => {
    const previous = draft.read();
    if (previous !== null && (previous.busy || previous.id !== id)) return;
    draft.set({ id, attempt: previous?.attempt ?? 0, busy: true });
    try {
      await undoAssistantWrite(id);
      if (draft.read()?.id !== id) return;
      onUndone(id);
      draft.set(null);
    } catch (error) {
      if (draft.read()?.id !== id) return;
      if (handleUnauthenticatedApiError(error)) return;
      if (outcomeUnknown(error) || (isRefusal(error) && (previous?.attempt ?? 0) > 0))
        draft.set({ id, attempt: (previous?.attempt ?? 0) + 1, busy: false });
      else {
        if (isRefusal(error)) draft.set(null);
        fail(error, UNDO_REFUSED, retry(id));
      }
    } finally {
      const current = draft.read();
      if (current?.id === id && current.busy) draft.set({ ...current, busy: false });
    }
  };
  const recovery = unknown ? resendFeedback({ line: { fact: "not sure that was undone.", reason: UNKNOWN_OUTCOME_REASON }, resend: { ...retry(unknown.id), run: () => { const current = draft.read(); if (current?.id === unknown.id && current.attempt > 0) void undo(unknown.id); } } }) : null;
  const primary = recovery?.verbs?.[0];
  const replay = primary && "commandKey" in primary && primary.commandKey === `undo ${unknown?.id}` ? primary : null;
  const waits = recovery !== null && (replay === null || replay.busy || replay.disabledReason !== undefined);
  const waitReason = replay?.disabledReason ?? admissionReason() ?? recovery?.line.reason;
  return <div role="list" aria-label="Assistant actions">
    {unknown && recovery ? <Hold id={`undo:${unknown.id}`} attempt={unknown.attempt} {...recovery} /> : null}
    {waits ? <span id={waitsId} className="sr-only" aria-live="off">{waitReason}</span> : null}
    {pending ? <span id={otherId} className="sr-only" aria-live="off">another undo isn’t finished.</span> : null}
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
            disabled={busy || (pending !== null && tool.id !== pending.id) || (unknown?.id === tool.id && waits)} aria-busy={busy || (unknown?.id === tool.id && replay?.busy)}
            aria-describedby={pending !== null && tool.id !== pending.id ? otherId : unknown?.id === tool.id && waits ? waitsId : undefined}
            onClick={() => { if (tool.id !== null) void undo(tool.id); }}
            aria-label={`Undo: ${kicker}${target ? ` ${target}` : ""}`}>Undo</Button> : historicalFiling ? <span className={styles.kicker}>older filings can’t be undone.</span> : null}
      </div>;
    })}
  </div>;
}
