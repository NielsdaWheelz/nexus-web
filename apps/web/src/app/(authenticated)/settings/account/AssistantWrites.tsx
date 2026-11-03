"use client";

import { UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import { useEffect, useRef, useState } from "react";
import { Hold, useOutcome, useResendVerbs } from "@/components/feedback/Feedback";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import Button from "@/components/ui/Button";
import useCollectionReadFeedback from "@/components/collections/useCollectionReadFeedback";
import PaneSection from "@/components/ui/PaneSection";
import { apiFetch, outcomeUnknown, type ApiPath } from "@/lib/api/client";
import { useServerList, type ListSnapshot } from "@/lib/api/useServerList";
import { usePaneIsActive } from "@/lib/panes/paneRuntime";
import { definePaneVisitDataKey } from "@/lib/workspace/paneReturnMemento";
import type { ApiJson } from "@/lib/api/wire";
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
  const [busyId, setBusyId] = useState<string | null>(null);
  const { fail } = useOutcome();
  const resendVerbs = useResendVerbs();
  // The server's undo is idempotent, so an unknown outcome's retry resends it.
  const [unknown, setUnknown] = useState<{ id: string; attempt: number } | null>(null);
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
    setBusyId(id);
    try {
      await undoAssistantWrite(id);
      setUnknown(null);
      setRevision((current) => current + 1);
    } catch (caught) {
      if (outcomeUnknown(caught)) {
        setUnknown(current => ({ id, attempt: current?.id === id ? current.attempt + 1 : 0 }));
        return;
      }
      setUnknown(null);
      // The row's `undo write` is the retry.
      fail(caught, "couldn’t undo that write.");
    } finally {
      setBusyId(null);
    }
  };

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
      {unknown === null ? null : <Hold id={`assistant-write-undo:${unknown.id}`} attempt={unknown.attempt} line={{ fact: "not sure that saved.", reason: UNKNOWN_OUTCOME_REASON }}
        verbs={resendVerbs({ label: "retry", commandKey: "RetryUndoWrite", busy: busyId === unknown.id, run: () => void undo(unknown.id) })} />}
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
                  aria-busy={busyId === write.id || undefined}
                  disabled={busyId !== null}
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
