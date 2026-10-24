"use client";

import { useEffect, useRef, useState } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import useCollectionReadFeedback from "@/components/collections/useCollectionReadFeedback";
import PaneSection from "@/components/ui/PaneSection";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { apiFetch, type ApiPath } from "@/lib/api/client";
import { useServerList, type ListSnapshot } from "@/lib/api/useServerList";
import { usePaneIsActive } from "@/lib/panes/paneRuntime";
import { definePaneVisitDataKey } from "@/lib/workspace/paneReturnMemento";
import type { ApiJson } from "@/lib/api/wire";
import { undoAssistantWrite, undoFailureMessage } from "@/lib/assistantWrites";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import styles from "./AssistantWrites.module.css";

type Page = ApiJson<"/assistant-writes", "get">;
type Write = Page["data"]["items"][number];
const VISIT = definePaneVisitDataKey<ListSnapshot<Write>>("Settings.AssistantWrites");
const UNIT = { singular: "write", plural: "writes" };

function writeStatus(write: Write): string {
  if (write.error_type !== null) return "Write failed";
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
  const [undoFailure, setUndoFailure] = useState<
    { message: string } | { defect: unknown } | null
  >(null);
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
    setUndoFailure(null);
    try {
      await undoAssistantWrite(id);
      setRevision((current) => current + 1);
    } catch (caught) {
      if (!handleUnauthenticatedApiError(caught)) {
        try {
          setUndoFailure({ message: undoFailureMessage(caught) });
        } catch (defect) {
          setUndoFailure({ defect });
        }
      }
    } finally {
      setBusyId(null);
    }
  };

  if (undoFailure && "defect" in undoFailure) throw undoFailure.defect;
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
      {undoFailure ? (
        <FeedbackNotice content={{ tone: "Warning", title: "undo not confirmed", message: undoFailure.message }} announcement="Assertive" />
      ) : null}
      {list.status === "loading" ? (
        <PaneLoadingState label="Loading writes" announcement="None" />
      ) : list.status === "failed" && list.failure !== null ? (
        <FeedbackNotice
          announcement="Polite"
          content={{
            tone: "Warning",
            title: "Assistant writes are unavailable.",
            message: undoFailureMessage(list.failure.error),
          }}
          actions={[{ label: "Try again", onClick: list.retry, busy: list.running !== null }]}
        />
      ) : list.complete && writes.length === 0 ? (
        <p className={styles.current}>
          {generationId
            ? "Creation history is no longer available."
            : "No assistant writes yet."}
        </p>
      ) : toolCallId && !found && list.complete ? (
        <p className={styles.current}>
          The selected creation record is no longer available.
        </p>
      ) : null}
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
      {list.status === "ready" && list.failure !== null && list.failure.op !== "More" ? (
        <FeedbackNotice
          content={{ tone: "Warning", title: "couldn’t refresh writes", message: undoFailureMessage(list.failure.error), requestId: list.failure.error.requestId }}
          announcement="Polite"
          actions={[{ label: "try again", onClick: list.retry, busy: list.running !== null }]}
          returnFocus={() => landmark.current}
        />
      ) : null}
      {readFeedback.notice}
      {readFeedback.announcement}
    </PaneSection>
  );
}
