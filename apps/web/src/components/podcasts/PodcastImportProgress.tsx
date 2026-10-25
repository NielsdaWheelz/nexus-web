"use client";

/** Counts describe committed additions, never scanned observations or totals. */
import Button from "@/components/ui/Button";
import { assertNever } from "@/lib/assertNever";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import type { PodcastImport } from "@/lib/podcasts/api";
import styles from "./PodcastCommands.module.css";

export default function PodcastImportProgress({ operation, title }: {
  readonly operation: PodcastImport;
  readonly title: string;
}) {
  const { ctx } = useActionRuntime();
  const subject = `import:${operation.id}`;
  const pending = ctx.podcasts.pending(subject);
  let status: string;
  switch (operation.state) {
    case "pending": case "running": status = "adding available episode history…"; break;
    case "failed": status = "episode addition paused"; break;
    case "cancelled": status = "episode addition cancelled"; break;
    case "complete": status = "episode addition complete"; break;
    default: return assertNever(operation.state);
  }
  const destination = operation.library_is_default ? "all" : operation.library_name;
  return <div className={styles.progress}>
    <p>addition to {destination}</p>
    <p>{status} · {operation.added_count} added · {operation.already_present_count} already present</p>
    {operation.state === "failed" ? <p className={styles.note}>some available history could not be loaded. retry keeps committed results and may observe newer source content.</p> : null}
    {operation.subscription_id !== null ? <p className={styles.note}>initial history for this podcast subscription. unsubscribe to stop it.</p>
      : operation.can_cancel ? <p className={styles.note}>cancel keeps added episodes. subscriptions stay unchanged.</p> : null}
    <div className={styles.actions}>
      {operation.can_cancel ? <Button aria-label={`cancel addition of ${title} to ${destination}`} disabled={pending !== null} aria-busy={pending?.phase === "Sending" || undefined} onClick={() => void ctx.podcasts.submit({ subject, title: `${title} · ${destination}`, command: { kind: "Import", libraryId: operation.library_id, importId: operation.id, action: "cancel", body: { expected_attempt_version: operation.attempt_version } } })}>cancel addition</Button> : null}
      {operation.can_retry ? <Button aria-label={`retry addition of ${title} to ${destination}`} disabled={pending !== null} aria-busy={pending?.phase === "Sending" || undefined} onClick={() => void ctx.podcasts.submit({ subject, title: `${title} · ${destination}`, command: { kind: "Import", libraryId: operation.library_id, importId: operation.id, action: "retry", body: { expected_attempt_version: operation.attempt_version, expected_order_revision: operation.order_revision } } })}>retry addition</Button> : null}
    </div>
  </div>;
}
