"use client";

/**
 * Shell-level surface for a parked Lectern FIFO failure (spec
 * `docs/cutovers/lectern-player-lifecycle-hard-cutover.md` §6: a timeout/network
 * failure "renders provider-owned same-ID Retry ... and visibly blocks later
 * commands"; a failed reconciliation GET must "expose GET-only Retry").
 *
 * Without this surface a failed non-completion mutation (a PlaceItems/SetOrder
 * timeout or a reconciliation-GET failure) parks the one FIFO lane invisibly: if
 * audio then ends, the completion command queues behind the parked attempt and
 * the player freezes in `Completing` with no affordance. This banner exposes the
 * provider-owned Retry so the user can unblock the lane.
 *
 * It renders for ALL parked states EXCEPT a completion attempt the player dock
 * already surfaces as `CompletionFailed` (its own Retry) — determined by matching
 * the parked attempt's `clientMutationId` against the player's active
 * `CompletionAttempt` ids, so the two surfaces never double up.
 */

import Button from "@/components/ui/Button";
import { useLectern } from "@/lib/lectern/LecternProvider";
import { useGlobalPlayer } from "@/lib/player/globalPlayer";
import { mutationMatchesAttempt } from "@/lib/player/playerSession";
import styles from "./LecternMutationNotice.module.css";

export default function LecternMutationNotice() {
  const { mutation } = useLectern();
  const { state } = useGlobalPlayer();

  if (mutation.kind !== "RetryableFailure" && mutation.kind !== "ReconciliationFailed") {
    return null;
  }

  // Suppress when the player dock already owns the retry surface for this exact
  // completion attempt (Completing/CompletionFailed carry the active attempt).
  const completionAttempt =
    state.kind === "Completing" || state.kind === "CompletionFailed" ? state.attempt : undefined;
  if (
    completionAttempt !== undefined &&
    mutationMatchesAttempt(mutation.attempt.clientMutationId, completionAttempt)
  ) {
    return null;
  }

  const isReconciliation = mutation.kind === "ReconciliationFailed";
  const title = isReconciliation ? "Couldn't reload the Lectern." : "Couldn't update the Lectern.";
  const onRetry = isReconciliation ? mutation.retryGet : mutation.retry;

  return (
    <div className={styles.notice} role="alert" aria-live="assertive" aria-atomic="true">
      <span className={styles.title}>{title}</span>
      <Button variant="secondary" size="sm" className={styles.retry} onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
