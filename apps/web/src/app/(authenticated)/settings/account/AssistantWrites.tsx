"use client";

import { useEffect, useRef, useState } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import PaneSection from "@/components/ui/PaneSection";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { apiFetch, type ApiPath } from "@/lib/api/client";
import { usePagePrefix } from "@/lib/api/pagePrefix";
import type { ApiJson } from "@/lib/api/wire";
import { undoAssistantWrite, undoFailureMessage } from "@/lib/assistantWrites";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import styles from "./page.module.css";

type Page = ApiJson<"/assistant-writes", "get">;
type Write = Page["data"]["items"][number];

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
  const filter = generationId
    ? `generation_id=${encodeURIComponent(generationId)}`
    : "";
  const { prefix, short, loadMore } = usePagePrefix(
    `assistant-writes?${filter}`, // never empty: an empty key never refetches
    String(revision),
    async (cursor, signal) => {
      const query = [filter, cursor ? `before=${cursor}` : ""].filter(Boolean);
      const path = `/api/assistant-writes?${query.join("&")}` as ApiPath;
      return (await apiFetch<Page>(path, { cache: "no-store", signal })).data;
    },
  );
  const writes =
    prefix.status === "ready"
      ? prefix.data.pages.flatMap((page) => page.items)
      : [];
  const more = prefix.status === "ready" && prefix.data.more;
  const found = writes.some((write) => write.id === toolCallId);

  useEffect(() => {
    if (toolCallId && !found && more && !short) loadMore();
  }, [toolCallId, found, more, short, loadMore]);
  useEffect(() => {
    if (!found) return;
    focused.current?.scrollIntoView({ block: "nearest" });
    focused.current?.focus({ preventScroll: true });
  }, [found]);

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
      title="Assistant writes"
      description={
        generationId
          ? "Writes from the generation that created this link."
          : "Finished assistant write attempts. Undo removes the items created by a successful write."
      }
      actions={
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setRevision((current) => current + 1)}
          disabled={busyId !== null}
        >
          Refresh
        </Button>
      }
    >
      {undoFailure ? (
        <p className={styles.effectsError} role="alert">
          {undoFailure.message}
        </p>
      ) : null}
      {prefix.status === "loading" ? (
        <PaneLoadingState label="Loading writes" announcement="None" />
      ) : prefix.status === "failed" ? (
        <FeedbackNotice
          announcement="Polite"
          content={{
            tone: "Warning",
            title: "Assistant writes are unavailable.",
            message: undoFailureMessage(prefix.error),
          }}
          actions={[{ label: "Try again", onClick: prefix.refetch }]}
        />
      ) : writes.length === 0 ? (
        <p className={styles.current}>
          {generationId
            ? "Creation history is no longer available."
            : "No assistant writes yet."}
        </p>
      ) : toolCallId && !found && !more ? (
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
              {write.undo_allowed ? (
                <Button
                  variant="ghost"
                  size="sm"
                  loading={busyId === write.id}
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
      <LoadMoreFooter
        hasMore={
          more && !(short && prefix.status === "ready" && prefix.error !== null)
        }
        loading={short && prefix.status === "ready" && prefix.error === null}
        onLoadMore={loadMore}
        label="Load older writes"
      />
    </PaneSection>
  );
}
