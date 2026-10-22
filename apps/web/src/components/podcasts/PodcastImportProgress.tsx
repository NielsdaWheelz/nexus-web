"use client";

/** Counts describe committed additions, never scanned observations or totals. */
import Button from "@/components/ui/Button";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import type { PodcastImport } from "@/lib/podcasts/api";
import styles from "./PodcastCommands.module.css";

export default function PodcastImportProgress({ operation, title, following }: {
  readonly operation: PodcastImport;
  readonly title: string;
  readonly following: boolean;
}) {
  const { ctx } = useActionRuntime();
  const subject = `import:${operation.id}`;
  const pending = ctx.podcasts.pending(subject);
  const failed = operation.state === "failed";
  const active = operation.state === "pending" || operation.state === "running";
  const destination = operation.library_is_default ? "all" : operation.library_name;
  return <div className={styles.progress}>
    <p>import to {destination}</p>
    <p>{failed ? "episode import paused" : active ? "importing available episode history…" : operation.state === "cancelled" ? "import cancelled" : "episode import complete"} · {operation.added_count} added · {operation.already_present_count} already present</p>
    {failed ? <p className={styles.note}>some available history could not be loaded. retry keeps committed results and may observe newer source content.</p> : null}
    {operation.can_cancel ? <p className={styles.note}>cancel keeps arrived episodes.{following ? " new episodes will still arrive automatically." : ""}</p> : null}
    <div className={styles.actions}>
      {operation.can_cancel ? <Button aria-label={`cancel import of ${title} to ${destination}`} disabled={pending !== null} aria-busy={pending?.phase === "Sending" || undefined} onClick={() => void ctx.podcasts.submit({ subject, title, command: { kind: "Import", libraryId: operation.library_id, importId: operation.id, action: "cancel", body: { expected_attempt_version: operation.attempt_version } } })}>cancel import</Button> : null}
      {operation.can_retry ? <Button aria-label={`retry import of ${title} to ${destination}`} disabled={pending !== null} aria-busy={pending?.phase === "Sending" || undefined} onClick={() => void ctx.podcasts.submit({ subject, title, command: { kind: "Import", libraryId: operation.library_id, importId: operation.id, action: "retry", body: { expected_attempt_version: operation.attempt_version, expected_order_revision: operation.order_revision } } })}>retry import</Button> : null}
    </div>
  </div>;
}
