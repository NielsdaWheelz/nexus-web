"use client";

import { UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
// Invitations waiting for the viewer, above the libraries index: each names the
// library, the role and who sent it; Accept, or Decline after a confirm. Every
// page is read (no cap); an answer rereads the list. This is auxiliary to the
// index: its own read failure and a missing connection show nothing here. A refused
// answer speaks once, an unsent one included; an unknown one holds until the reread lands.

import { useEffect, useId, useState } from "react";
import { Hold, useOutcome } from "@/components/feedback/Feedback";
import useCollectionReadFeedback from "@/components/collections/useCollectionReadFeedback";
import Button from "@/components/ui/Button";
import { personLabel } from "@/components/users/PeopleSearch";
import { useChangeStamp } from "@/lib/api/changes";
import { useServerList, type ListSnapshot } from "@/lib/api/useServerList";
import {
  respondToInvitation,
  viewerInvitationsPage,
  type ViewerInvitation,
} from "@/lib/libraries/api";
import { outcomeUnknown } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { refuseLibrary } from "@/lib/libraries/errors";
import { installedApp } from "@/lib/native/admission";
import { useRemoteAdmission } from "@/lib/native/admissionHooks";
import { usePaneIsActive } from "@/lib/panes/paneRuntime";
import { definePaneVisitDataKey } from "@/lib/workspace/paneReturnMemento";
import styles from "./LibraryInvitations.module.css";

const VISIT = definePaneVisitDataKey<ListSnapshot<ViewerInvitation>>("Libraries.Invitations");

export default function LibraryInvitations() {
  const headingId = useId();
  const admission = useRemoteAdmission();
  const outcome = useOutcome();
  const [answered, setAnswered] = useState(0);
  const list = useServerList<ViewerInvitation>({
    key: "invitations",
    stale: `${useChangeStamp("Libraries")}:${answered}`,
    pageSize: 100,
    active: usePaneIsActive(),
    visit: VISIT,
    id: (invitation) => invitation.id,
    fetchPage: viewerInvitationsPage,
  });
  const readFeedback = useCollectionReadFeedback({
    list, unit: { singular: "invitation", plural: "invitations" }, waiting: false, outcome: null, returnFocus: () => null,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [declining, setDeclining] = useState<string | null>(null);
  /** An answer whose outcome is unknown, until the reread it started lands. */
  const [unknown, setUnknown] = useState<{ libraryId: string; attempt: number } | null>(null);
  useEffect(() => { if (unknown !== null && list.fresh) setUnknown(null); }, [unknown, list.fresh]);

  const answer = async (invitation: ViewerInvitation, accept: boolean) => {
    const fact = `couldn’t ${accept ? "accept" : "decline"} the invitation to “${invitation.library_name}”.`;
    setBusy(invitation.id);
    try {
      await respondToInvitation(invitation.id, accept);
      setDeclining(null);
    } catch (error) {
      handleUnauthenticatedApiError(error);
      if (outcomeUnknown(error)) setUnknown(current => ({ libraryId: invitation.library_id, attempt: current?.libraryId === invitation.library_id ? current.attempt + 1 : 0 }));
      else refuseLibrary(outcome, error, fact);
    } finally {
      setAnswered((n) => n + 1);
      setBusy(null);
    }
  };

  // The hold stands whatever admission does: unmounting it would say the answer resolved.
  const hold = unknown === null ? null
    : <Hold id={`library-invitation-answer:${unknown.libraryId}`} attempt={unknown.attempt} line={{ fact: "not sure that saved.", reason: UNKNOWN_OUTCOME_REASON }} />;
  if (installedApp && admission !== "Ready") return hold;
  const shown = list.items.length > 0;
  return <>
    {hold}
    {shown ?<section className={styles.inbox} aria-labelledby={headingId}>
      <div>
        <h2 id={headingId}>Library invitations</h2>
        <p>Accept to add the library here, or decline the invitation.</p>
      </div>
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
                    emphasis="strong" tone="danger"
                    aria-label={`Decline invitation to ${invitation.library_name}`}
                    disabled={busy !== null}
                    onClick={() => void answer(invitation, false)}
                    aria-busy={busy === invitation.id}
                  >
                    Decline
                  </Button>
                  <Button
                    disabled={busy !== null}
                    onClick={() => setDeclining(null)}
                  >
                    Keep
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    emphasis="strong"
                    disabled={busy !== null}
                    onClick={() => void answer(invitation, true)}
                    aria-busy={busy === invitation.id}
                  >
                    Accept
                  </Button>
                  <Button
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
    </section> : null}
    {readFeedback.notice}
    {readFeedback.announcement}
  </>;
}
