"use client";

// Invitations waiting for the viewer, above the libraries index: Accept, or
// Decline after a confirm. Moved from the index pane unchanged in behaviour; the
// membership slice rewrites it on plain ids.

import { useState } from "react";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { useChangeStamp } from "@/lib/api/changes";
import { useThrowLater, usePaneFreeServerValue } from "@/lib/api/serverState";
import type { ViewerLibraryInvitation } from "@/lib/libraries/contract";
import { libraryErrorFeedback, throwDefect } from "@/lib/libraries/errors";
import {
  acceptLibraryInvite,
  declineLibraryInvite,
  fetchViewerLibraryInvites,
} from "@/lib/libraries/governance";
import styles from "./LibraryInvitations.module.css";

export default function LibraryInvitations() {
  const fail = useThrowLater();
  const [answered, setAnswered] = useState(0);
  const invites = usePaneFreeServerValue<ViewerLibraryInvitation[]>({
    key: "library-invitations",
    stale: `${useChangeStamp("Libraries")} ${answered}`,
    load: fetchViewerLibraryInvites,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [declining, setDeclining] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);

  const answer = async (handle: string, accept: boolean) => {
    if (busy !== null) return;
    setBusy(handle);
    try {
      await (accept ? acceptLibraryInvite(handle) : declineLibraryInvite(handle));
      setFeedback(null);
      setDeclining(null);
    } catch (error) {
      const title = accept
        ? "Invitation couldn’t be accepted"
        : "Invitation couldn’t be declined";
      setFeedback(libraryErrorFeedback(error, title, fail));
    } finally {
      setAnswered((n) => n + 1);
      setBusy(null);
    }
  };

  const loadFailure =
    invites.status === "failed"
      ? libraryErrorFeedback(
          invites.error,
          "Library invitations couldn’t be loaded",
          throwDefect,
        )
      : null;
  if (loadFailure !== null) {
    return (
      <div className={styles.inbox}>
        <FeedbackNotice
          content={loadFailure}
          announcement="Assertive"
          actions={[{ label: "Retry invitations", onClick: invites.refetch }]}
        />
      </div>
    );
  }
  const rows = invites.status === "ready" ? invites.data : [];
  if (rows.length === 0 && feedback === null) return null;
  return (
    <section className={styles.inbox} aria-labelledby="library-invitations-heading">
      <div>
        <h2 id="library-invitations-heading">Library invitations</h2>
        <p>Accept to add the library here, or decline the invitation.</p>
      </div>
      {feedback ? <FeedbackNotice content={feedback} announcement="Assertive" /> : null}
      <div className={styles.rows}>
        {rows.map((invite) => {
          const handle = invite.invitation_handle;
          return (
            <div className={styles.row} key={handle}>
              <span>
                {invite.library_name} · {invite.role === "admin" ? "Admin" : "Member"}
              </span>
              {declining === handle ? (
                <span className={styles.actions}>
                  <span>Decline this invitation?</span>
                  <Button
                    variant="danger"
                    size="sm"
                    loading={busy === handle}
                    onClick={() => void answer(handle, false)}
                  >
                    Decline
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => setDeclining(null)}
                  >
                    Keep
                  </Button>
                </span>
              ) : (
                <span className={styles.actions}>
                  <Button
                    variant="primary"
                    size="sm"
                    loading={busy === handle}
                    disabled={busy !== null}
                    onClick={() => void answer(handle, true)}
                  >
                    Accept
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => setDeclining(handle)}
                  >
                    Decline
                  </Button>
                </span>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
