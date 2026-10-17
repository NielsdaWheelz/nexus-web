"use client";

// Invitations waiting for the viewer, above the libraries index: each names the
// library, the role and who sent it; Accept, or Decline after a confirm. Every
// page is read (no cap); an answer rereads the list.

import { useId, useState } from "react";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { personLabel } from "@/components/users/PeopleSearch";
import { useChangeStamp } from "@/lib/api/changes";
import { useThrowLater } from "@/lib/api/serverState";
import { useServerList, type ListSnapshot } from "@/lib/api/useServerList";
import {
  respondToInvitation,
  viewerInvitationsPage,
  type ViewerInvitation,
} from "@/lib/libraries/api";
import { libraryErrorFeedback, throwDefect } from "@/lib/libraries/errors";
import { usePaneIsActive } from "@/lib/panes/paneRuntime";
import { definePaneVisitDataKey } from "@/lib/workspace/paneReturnMemento";
import styles from "./LibraryInvitations.module.css";

const VISIT = definePaneVisitDataKey<ListSnapshot<ViewerInvitation>>("Libraries.Invitations");

export default function LibraryInvitations() {
  const headingId = useId();
  const fail = useThrowLater();
  const [answered, setAnswered] = useState(0);
  const list = useServerList<ViewerInvitation>({
    key: "invitations",
    stale: `${useChangeStamp("Libraries")}:${answered}`,
    pageSize: 100,
    drain: true,
    active: usePaneIsActive(),
    visit: VISIT,
    id: (invitation) => invitation.id,
    fetchPage: viewerInvitationsPage,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [declining, setDeclining] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);

  const answer = async (id: string, accept: boolean) => {
    setBusy(id);
    try {
      await respondToInvitation(id, accept);
      setFeedback(null);
      setDeclining(null);
    } catch (error) {
      const title = accept ? "Invitation couldn’t be accepted" : "Invitation couldn’t be declined";
      setFeedback(libraryErrorFeedback(error, title, fail));
    } finally {
      setAnswered((n) => n + 1);
      setBusy(null);
    }
  };

  const failure =
    list.failure &&
    (libraryErrorFeedback(list.failure.error, "Library invitations couldn’t be loaded", throwDefect) ?? {
      tone: "Danger",
      title: "Library invitations couldn’t be loaded",
    });
  if (list.items.length === 0 && feedback === null && !failure) return null;
  return (
    <section className={styles.inbox} aria-labelledby={headingId}>
      <div>
        <h2 id={headingId}>Library invitations</h2>
        <p>Accept to add the library here, or decline the invitation.</p>
      </div>
      {failure ? (
        <FeedbackNotice
          content={failure}
          announcement="Assertive"
          actions={[{ label: "Retry invitations", onClick: list.retry, busy: list.running !== null }]}
        />
      ) : null}
      {feedback ? <FeedbackNotice content={feedback} announcement="Assertive" /> : null}
      <div className={styles.rows}>
        {list.items.map((invitation) => (
          <div className={styles.row} key={invitation.id}>
            <span>
              {invitation.library_name} · {invitation.role === "admin" ? "Admin" : "Member"} · from{" "}
              {personLabel({
                display_name: invitation.inviter_display_name,
                email: invitation.inviter_email,
              })}
            </span>
            <span className={styles.actions}>
              {declining === invitation.id ? (
                <>
                  <span>Decline this invitation?</span>
                  <Button
                    variant="danger"
                    size="sm"
                    loading={busy === invitation.id}
                    disabled={busy !== null}
                    onClick={() => void answer(invitation.id, false)}
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
                </>
              ) : (
                <>
                  <Button
                    variant="primary"
                    size="sm"
                    loading={busy === invitation.id}
                    disabled={busy !== null}
                    onClick={() => void answer(invitation.id, true)}
                  >
                    Accept
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => setDeclining(invitation.id)}
                  >
                    Decline
                  </Button>
                </>
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
