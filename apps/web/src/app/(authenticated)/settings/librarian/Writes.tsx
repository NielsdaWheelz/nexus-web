"use client";

import { admissionReason } from "@/lib/api/failure";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Hold, useOutcome, useResendFeedback } from "@/components/feedback/Feedback";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import Button from "@/components/ui/Button";
import MachineText from "@/components/ui/MachineText";
import useCollectionReadFeedback from "@/components/collections/useCollectionReadFeedback";
import PaneSection from "@/components/ui/PaneSection";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { apiFetch, isApiError, isRefusal, isSameSystemApiDefect, outcomeUnknown, type ApiPath } from "@/lib/api/client";
import { useChangeStamp } from "@/lib/api/changes";
import { useServerList, type ListSnapshot } from "@/lib/api/useServerList";
import { formatDisplayDate } from "@/lib/display/format";
import { isAbortError } from "@/lib/errors";
import { formatLocalDateInTimeZone, shiftLocalDate } from "@/lib/localDate";
import { useAccountToday } from "@/lib/notes/accountDay";
import { usePaneChrome, type PaneRefreshExecute } from "@/lib/panes/paneChrome";
import { usePaneIsActive } from "@/lib/panes/paneRuntime";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { definePaneVisitDataKey } from "@/lib/workspace/paneReturnMemento";
import type { ApiJson } from "@/lib/api/wire";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { undoAssistantWrite, writeKicker, UNDO_LABEL, UNDONE, UNDO_TOO_OLD, UNDO_UNAVAILABLE, UNDO_REFUSED, UNDO_UNKNOWN } from "@/lib/assistantWrites";
import styles from "./page.module.css";

type Page = ApiJson<"/assistant-writes", "get">;
type Write = Page["data"]["items"][number];
const VISIT = definePaneVisitDataKey<ListSnapshot<Write>>("Settings.AssistantWrites");
const UNIT = { singular: "write", plural: "writes" };

/** Successful writes in server order. Undo changes a row's state, never its place. */
export default function Writes({ generationId, toolCallId }: {
  generationId: string | null;
  toolCallId: string | null;
}) {
  const stale = useChangeStamp("AssistantWrites");
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
  const focused = useRef<HTMLLIElement>(null);
  const [focusId, setFocusId] = useState(toolCallId);
  const { calendarTimeZone } = useAuthenticatedAccount();
  const { displayLocale } = useRenderEnvironment();
  const display = { displayLocale, displayTimeZone: calendarTimeZone };
  const today = useAccountToday();
  const yesterday = today === null ? null : shiftLocalDate(today, -1);
  const filter = generationId ? `generation_id=${encodeURIComponent(generationId)}` : "";
  const list = useServerList<Write>({
    key: `/assistant-writes?${filter}`,
    stale,
    pageSize: 30,
    active: usePaneIsActive(),
    visit: VISIT,
    id: write => write.id,
    fetchPage: async (cursor, _limit, signal) => {
      const query = new URLSearchParams(filter);
      if (cursor !== null) query.set("before", cursor);
      const path: ApiPath = `/api/assistant-writes?${query}`;
      return (await apiFetch<Page>(path, { cache: "no-store", signal })).data;
    },
  });
  const writes = list.items;
  const { current, active } = list;
  useEffect(() => {
    if (pending && writes.some(write => write.id === pending.id && write.reverted_at !== null)) {
      setFocusId(pending.id);
      setPending(null);
    }
  }, [pending, writes, setPending]);
  const readFeedback = useCollectionReadFeedback({ list, unit: UNIT, waiting: false, outcome: null });
  const found = list.current && writes.some(write => write.id === toolCallId);
  useEffect(() => {
    if (focusId === null || !current || !active || !writes.some(write => write.id === focusId)) return;
    focused.current?.scrollIntoView({ block: "nearest" });
    focused.current?.focus({ preventScroll: true });
    setFocusId(null);
  }, [focusId, writes, current, active]);
  const { refetch } = list;
  const execute = useCallback<PaneRefreshExecute>(async () => {
    try {
      await refetch();
    } catch (error) {
      if (isAbortError(error) || !isApiError(error) || isSameSystemApiDefect(error)) throw error;
      // justify-ignore-error: the displayed read retains its failure and heals on demand.
    }
    return null;
  }, [refetch]);
  usePaneChrome({ refresh: { kind: "Refreshable", sourceKey: `/assistant-writes?${filter}`, execute } });

  const undo = async (id: string) => {
    const previous = draft.read();
    if (previous !== null && (previous.busy || previous.id !== id)) return;
    draft.set({ id, attempt: previous?.attempt ?? 0, busy: true });
    try {
      await undoAssistantWrite(id);
      if (draft.read()?.id !== id) return;
      setFocusId(id);
      draft.set(null);
    } catch (caught) {
      if (draft.read()?.id !== id) return;
      if (outcomeUnknown(caught) || (isRefusal(caught) && (previous?.attempt ?? 0) > 0))
        draft.set({ id, attempt: (previous?.attempt ?? 0) + 1, busy: false });
      else {
        if (isRefusal(caught)) draft.set(null);
        fail(caught, UNDO_REFUSED);
      }
    } finally {
      const current = draft.read();
      if (current?.id === id && current.busy) draft.set({ ...current, busy: false });
    }
  };
  const retryKey = unknown ? `undo write ${unknown.id}` : "";
  const recovery = unknown ? resendFeedback({ line: UNDO_UNKNOWN,
    resend: { label: "retry", commandKey: retryKey, busy: busyId === unknown.id, run: () => { const current = draft.read(); if (current?.id === unknown.id && current.attempt > 0) void undo(unknown.id); } } }) : null;
  const primary = recovery?.verbs?.[0];
  const replay = primary && "commandKey" in primary && primary.commandKey === retryKey ? primary : null;
  const waits = recovery !== null && (replay === null || replay.busy || replay.disabledReason !== undefined);
  const waitReason = replay?.disabledReason ?? admissionReason() ?? recovery?.line.reason;
  const days = new Map<string | null, Write[]>();
  for (const write of writes) {
    const day = formatLocalDateInTimeZone(new Date(write.created_at), calendarTimeZone);
    const group = days.get(day);
    if (group) group.push(write);
    else days.set(day, [write]);
  }

  return <PaneSection id="writes" title="writes" description={generationId
    ? "writes from the answer that made this link."
    : "what the librarian has filed, highlighted, connected, noted or queued. undoing a filing removes that placement; the work stays in nexus."}>
    <MachineText origin={{ label: "librarian" }}>
      {unknown && recovery ? <Hold id={`assistant-write-undo:${unknown.id}`} attempt={unknown.attempt} {...recovery} /> : null}
      {waits ? <span id={waitsId} className="sr-only">{waitReason}</span> : null}
      {pending ? <span id={otherId} className="sr-only">another undo isn’t finished.</span> : null}
      {list.status === "loading" ? <Ruling />
        : list.status === "failed" && list.failure !== null ? <Failed error={list.failure.error} noun="writes" retry={{ run: list.retry, busy: list.running !== null }} />
        : list.complete && writes.length === 0 ? <Fact line={{ fact: generationId ? "no writes from this answer." : "no writes yet." }} />
        : toolCallId && !found && list.complete ? <Fact line={{ fact: "that write isn’t in this list." }} />
        : null}
      <div className={styles.days}>
        {Array.from(days, ([day, group]) => <div key={day ?? "unavailable"}>
          {day !== null && today !== null ? <h3 className={styles.day}>{day === today || day === yesterday
            ? new Intl.RelativeTimeFormat(displayLocale, { numeric: "auto" }).format(day === today ? 0 : -1, "day")
            : formatDisplayDate(group[0].created_at, display, { weekday: "long", day: "numeric", month: "short", ...(day.slice(0, 4) !== today.slice(0, 4) ? { year: "numeric" } : {}) })?.toLowerCase()}</h3> : null}
          <ol className={styles.writes}>
            {group.map(write => {
              const ref = write.created_refs[0];
              const target = ref.label.trim();
              const reverted = write.reverted_at !== null;
              return <li key={write.id} className={styles.write} ref={write.id === focusId ? focused : undefined}
                tabIndex={-1} aria-current={write.id === toolCallId ? "true" : undefined}>
                <time className={styles.time} dateTime={write.created_at}>{formatDisplayDate(write.created_at, display, { hour: "numeric", minute: "2-digit" })?.toLowerCase()}</time>
                <span className={styles.writeWords}>
                  <span>{writeKicker(ref)}</span>
                  {target ? <span className={styles.target} data-reverted={reverted || undefined}>{target}</span> : null}
                </span>
                {write.undo_allowed ? <Button disabled={busyId !== null || (pending !== null && pending.id !== write.id) || (unknown?.id === write.id && waits)}
                  aria-busy={busyId === write.id || (unknown?.id === write.id && replay?.busy) || undefined}
                  aria-describedby={pending !== null && pending.id !== write.id ? otherId : unknown?.id === write.id && waits ? waitsId : undefined}
                  onClick={() => void undo(write.id)}>{UNDO_LABEL}</Button>
                  : <span className={styles.undoState}>{reverted ? UNDONE : write.created_refs.some(ref => ref.kind === "entry" && ref.order_revision === null) ? UNDO_TOO_OLD : UNDO_UNAVAILABLE}</span>}
              </li>;
            })}
          </ol>
        </div>)}
      </div>
      {readFeedback.notice}
      {readFeedback.announcement}
    </MachineText>
  </PaneSection>;
}
