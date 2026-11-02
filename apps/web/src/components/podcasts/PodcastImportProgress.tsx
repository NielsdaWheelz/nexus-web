"use client";

/** Counts describe committed additions, never scanned observations or totals. A press
 * goes to the account's command owner, which holds an unanswered one and says a refusal. */
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
    case "pending": case "running": status = "adding episodes"; break;
    case "failed": status = "addition stopped"; break;
    case "cancelled": status = "addition cancelled"; break;
    case "complete": status = "addition complete"; break;
    default: return assertNever(operation.state);
  }
  const destination = operation.library_is_default ? "all" : operation.library_name;
  const library = operation.library_is_default ? null : operation.library_name;
  return <div className={styles.progress}>
    <p>addition to {destination}</p>
    <p>{status} · {operation.added_count} added · {operation.already_present_count} already present</p>
    {operation.state === "failed" ? <p className={styles.note}>some episodes couldn’t load. retry keeps what was added.</p> : null}
    {operation.subscription_id !== null ? <p className={styles.note}>initial history for this podcast subscription. unsubscribe to stop it.</p>
      : operation.can_cancel ? <p className={styles.note}>cancel keeps added episodes. subscriptions stay unchanged.</p> : null}
    <div className={styles.actions}>
      {operation.can_cancel ? <Button aria-label={`cancel addition of ${title} to ${destination}`} disabled={pending !== null} aria-busy={pending?.phase === "Sending" || undefined} onClick={() => void ctx.podcasts.submit({ subject, title, library, command: { kind: "Import", libraryId: operation.library_id, importId: operation.id, action: "cancel", body: { expected_attempt_version: operation.attempt_version } } })}>cancel addition</Button> : null}
      {operation.can_retry ? <Button aria-label={`retry addition of ${title} to ${destination}`} disabled={pending !== null} aria-busy={pending?.phase === "Sending" || undefined} onClick={() => void ctx.podcasts.submit({ subject, title, library, command: { kind: "Import", libraryId: operation.library_id, importId: operation.id, action: "retry", body: { expected_attempt_version: operation.attempt_version, expected_order_revision: operation.order_revision } } })}>retry addition</Button> : null}
    </div>
  </div>;
}
