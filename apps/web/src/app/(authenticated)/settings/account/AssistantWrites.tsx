"use client";

import { admissionReason, UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import { useEffect, useId, useRef, useState } from "react";
import { Hold, useOutcome, useResendFeedback } from "@/components/feedback/Feedback";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import Button from "@/components/ui/Button";
import useCollectionReadFeedback from "@/components/collections/useCollectionReadFeedback";
import PaneSection from "@/components/ui/PaneSection";
import { apiFetch, isRefusal, outcomeUnknown, type ApiPath } from "@/lib/api/client";
import { useServerList, type ListSnapshot } from "@/lib/api/useServerList";
import { usePaneIsActive } from "@/lib/panes/paneRuntime";
import { definePaneVisitDataKey } from "@/lib/workspace/paneReturnMemento";
import type { ApiJson } from "@/lib/api/wire";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { undoAssistantWrite } from "@/lib/assistantWrites";
import styles from "./AssistantWrites.module.css";

type Page = ApiJson<"/assistant-writes", "get">;
type Write = Page["data"]["items"][number];
const VISIT = definePaneVisitDataKey<ListSnapshot<Write>>("Settings.AssistantWrites");
const UNIT = { singular: "write", plural: "writes" };

function writeStatus(write: Write): string {
  if (write.error_type !== null) return "couldn’t complete";
  if (write.created_refs.length === 0) return "No new item created";
  return write.reverted_at ? "Undone" : "Assistant-created";
}

/** Every finished assistant write of the account, newest first; a deep link focuses one. */
export default function AssistantWrites({
  generationId,
  toolCallId,
}: {
  generationId: string | null;
  toolCallId: string | null;
}) {
  const [revision, setRevision] = useState(0);
  const draft = useResourceDraft<{ id: string; attempt: number; busy: boolean } | null>("Settings.AssistantUndo", () => null,
    value => ({ changed: false, unconfirmed: value !== null, stopsBrowserWork: false }));
  const { set: setPending } = draft;
  const pending = draft.value;
  const busyId = pending?.busy ? pending.id : null;
  const unknown = pending !== null && pending.attempt > 0 ? pending : null;
  const waitsId = useId();
  const otherId = useId();
  const { fail } = useOutcome();
  const resendFeedback = useResendFeedback();
  // The server's undo is idempotent, so an unknown outcome's retry resends it.
  const focused = useRef<HTMLLIElement | null>(null);
  const didFocus = useRef(false);
  const landmark = useRef<HTMLElement>(null);
  const filter = generationId
    ? `generation_id=${encodeURIComponent(generationId)}`
    : "";
  const list = useServerList<Write>({
    key: `/assistant-writes?${filter}`,
    stale: String(revision),
    // The endpoint always returns 30; it accepts before, never limit.
    pageSize: 30,
    active: usePaneIsActive(),
    visit: VISIT,
    id: (write) => write.id,
    fetchPage: async (cursor, _limit, signal) => {
      const query = new URLSearchParams(filter);
      if (cursor !== null) query.set("before", cursor);
      const path: ApiPath = `/api/assistant-writes?${query}`;
      return (await apiFetch<Page>(path, { cache: "no-store", signal })).data;
    },
  });
  const writes = list.items;
  useEffect(() => {
    if (pending && writes.some(write => write.id === pending.id && write.reverted_at !== null)) setPending(null);
  }, [pending, writes, setPending]);
  const readFeedback = useCollectionReadFeedback({
    list, unit: UNIT, waiting: false, outcome: null, returnFocus: () => landmark.current,
  });
  const found = list.current && writes.some((write) => write.id === toolCallId);
  useEffect(() => {
    if (!found || !list.active || didFocus.current) return;
    didFocus.current = true;
    focused.current?.scrollIntoView({ block: "nearest" });
    focused.current?.focus({ preventScroll: true });
  }, [found, list.active]);

  const undo = async (id: string) => {
    const previous = draft.read();
    if (previous !== null && (previous.busy || previous.id !== id)) return;
    draft.set({ id, attempt: previous?.attempt ?? 0, busy: true });
    try {
      await undoAssistantWrite(id);
      if (draft.read()?.id !== id) return;
      draft.set(null);
      setRevision((current) => current + 1);
    } catch (caught) {
      if (draft.read()?.id !== id) return;
      if (outcomeUnknown(caught) || (isRefusal(caught) && (previous?.attempt ?? 0) > 0))
        draft.set({ id, attempt: (previous?.attempt ?? 0) + 1, busy: false });
      else {
        if (isRefusal(caught)) draft.set(null);
        fail(caught, "couldn’t undo that write.");
      }
    } finally {
      const current = draft.read();
      if (current?.id === id && current.busy) draft.set({ ...current, busy: false });
    }
  };
  const retryKey = unknown ? `undo write ${unknown.id}` : "";
  const recovery = unknown ? resendFeedback({ line: { fact: "not sure that saved.", reason: UNKNOWN_OUTCOME_REASON },
    resend: { label: "retry", commandKey: retryKey, busy: busyId === unknown.id, run: () => { const current = draft.read(); if (current?.id === unknown.id && current.attempt > 0) void undo(unknown.id); } } }) : null;
  const primary = recovery?.verbs?.[0];
  const replay = primary && "commandKey" in primary && primary.commandKey === retryKey ? primary : null;
  const waits = recovery !== null && (replay === null || replay.busy || replay.disabledReason !== undefined);
  const waitReason = replay?.disabledReason ?? admissionReason() ?? recovery?.line.reason;

  return (
    <PaneSection
      id="assistant-writes"
      ref={landmark}
      tabIndex={-1}
      title="Assistant writes"
      description={
        generationId
          ? "Writes from the generation that created this link."
          : "finished assistant writes. undo of a filing removes only that named placement; content stays in nexus."
      }
      actions={
        <Button
          onClick={() => setRevision((current) => current + 1)}
          disabled={busyId !== null}
        >
          Refresh
        </Button>
      }
    >
      {unknown && recovery ? <Hold id={`assistant-write-undo:${unknown.id}`} attempt={unknown.attempt} {...recovery} /> : null}
      {waits ? <span id={waitsId} className="sr-only">{waitReason}</span> : null}
      {pending ? <span id={otherId} className="sr-only">another undo isn’t finished.</span> : null}
      {list.status === "loading" ? <Ruling />
        : list.status === "failed" && list.failure !== null ? <Failed error={list.failure.error} noun="assistant writes" retry={{ run: list.retry, busy: list.running !== null }} />
        : list.complete && writes.length === 0 ? <Fact line={{ fact: generationId ? "no writes from this generation." : "no assistant writes yet." }} />
        : toolCallId && !found && list.complete ? <Fact line={{ fact: "that write isn’t in this list." }} />
        : null}
      {writes.length ? (
        <ol className={styles.effectsList}>
          {writes.map((write) => (
            <li
              key={write.id}
              className={styles.effect}
              ref={write.id === toolCallId ? focused : undefined}
              tabIndex={write.id === toolCallId ? -1 : undefined}
              aria-current={write.id === toolCallId ? "true" : undefined}
            >
              <div className={styles.effectHeading}>
                <strong>
                  {write.tool_id.replace(/^nexus\./, "").replaceAll(".", " ")}
                </strong>
                <time dateTime={write.created_at}>
                  {new Date(write.created_at).toLocaleString()}
                </time>
              </div>
              <p className={styles.effectStatus}>{writeStatus(write)}</p>
              {write.created_refs.length ? (
                <ul className={styles.effectRefs}>
                  {write.created_refs.map((ref) => (
                    <li key={ref.id}>
                      {ref.kind}: {ref.label.trim() || ref.id}
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className={styles.effectProvenance}>
                Generation {write.generation_id}
              </p>
              {write.created_refs.some(ref => ref.kind === "entry" && ref.order_revision === null) && !write.reverted_at
                ? <p className={styles.effectStatus}>undo unavailable for this older filing</p> : null}
              {write.undo_allowed ? (
                <Button
                  aria-busy={busyId === write.id || (unknown?.id === write.id && replay?.busy) || undefined}
                  disabled={busyId !== null || (pending !== null && pending.id !== write.id) || (unknown?.id === write.id && waits)}
                  aria-describedby={pending !== null && pending.id !== write.id ? otherId : unknown?.id === write.id && waits ? waitsId : undefined}
                  onClick={() => void undo(write.id)}
                >
                  Undo write
                </Button>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {readFeedback.notice}
      {readFeedback.announcement}
    </PaneSection>
  );
}
