"use client";

/** One libraries visit retains its exact invitation answer until acknowledgement or a
 * terminal invitation fence. A still-pending list never settles a sent answer. */
import { useId, useLayoutEffect, useRef, useState } from "react";
import { Hold, useOutcome, useResendFeedback } from "@/components/feedback/Feedback";
import useCollectionReadFeedback from "@/components/collections/useCollectionReadFeedback";
import Button from "@/components/ui/Button";
import { personLabel } from "@/components/users/PeopleSearch";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { useChangeStamp } from "@/lib/api/changes";
import { isApiError, outcomeUnknown } from "@/lib/api/client";
import { UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import { useServerList, type ListSnapshot } from "@/lib/api/useServerList";
import { respondToInvitation, viewerInvitationsPage, type ViewerInvitation } from "@/lib/libraries/api";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { refuseLibrary } from "@/lib/libraries/errors";
import { installedApp, remoteAdmission, remoteAttemptAllowed } from "@/lib/native/admission";
import { useRemoteAdmission } from "@/lib/native/admissionHooks";
import { requirePaneRuntime, usePaneIsActive, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { useConnectivity } from "@/lib/renderEnvironment/connectivity";
import { definePaneVisitDataKey } from "@/lib/workspace/paneReturnMemento";
import styles from "./LibraryInvitations.module.css";

const VISIT = definePaneVisitDataKey<ListSnapshot<ViewerInvitation>>("Libraries.Invitations");
type Answer = { readonly invitation: ViewerInvitation; readonly accept: boolean };
type Pending = { readonly command: Answer; readonly running: boolean; readonly unknown: number };

export function useLibraryInvitations() {
  const pane = requirePaneRuntime(usePaneRuntime(), "library invitations");
  const { ctx } = useActionRuntime();
  const account = ctx.sessionSignal();
  const outcome = useOutcome();
  const resendFeedback = useResendFeedback();
  const admission = useRemoteAdmission();
  const connectivity = useConnectivity();
  const owner = useResourceDraft<Pending | null>("Libraries.Answer", () => null, value => ({
    changed: false, unconfirmed: value !== null, stopsBrowserWork: false,
  }));
  const { read, set } = owner;
  const mounted = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const owns = () => !account.aborted && ctx.workspace().state.panes.some(current =>
    current.id === pane.paneId && current.current_visit.id === pane.visitId &&
    resolvePaneRouteModel(current.current_visit.href).id === "libraries");
  const [answered, setAnswered] = useState(0);
  const list = useServerList<ViewerInvitation>({
    key: "invitations", stale: `${useChangeStamp("Libraries")}:${answered}`, pageSize: 100,
    active: usePaneIsActive(), visit: VISIT, id: invitation => invitation.id, fetchPage: viewerInvitationsPage,
  });
  const readFeedback = useCollectionReadFeedback({
    list, unit: { singular: "invitation", plural: "invitations" }, waiting: false, outcome: null, returnFocus: () => null,
  });
  async function send(command: Answer, previous: Pending | null): Promise<boolean> {
    if (!mounted.current || !owns() || read() !== previous || previous?.running ||
      remoteAdmission() === "Checking" || !remoteAttemptAllowed() || !navigator.onLine) return false;
    set({ command, running: true, unknown: previous?.unknown ?? 0 });
    const current = () => owns() && read()?.command === command;
    try {
      await respondToInvitation(command.invitation.id, command.accept);
      if (!current()) return false;
      set(null);
      return true;
    } catch (error) {
      if (!current()) return false;
      handleUnauthenticatedApiError(error);
      // These statuses cannot become pending again; serializable answering cannot
      // commit an older pending snapshot after the terminal answer or deletion.
      const fenced = isApiError(error) && (error.code === "E_INVITE_NOT_PENDING" || error.code === "E_INVITE_NOT_FOUND");
      if (!fenced && (outcomeUnknown(error) || (previous?.unknown ?? 0) > 0))
        set({ command, running: true, unknown: (previous?.unknown ?? 0) + 1 });
      else set(null);
      if (!outcomeUnknown(error)) refuseLibrary(outcome, error, previous?.unknown
        ? "couldn’t retry that change."
        : `couldn’t ${command.accept ? "accept" : "decline"} the invitation to “${command.invitation.library_name}”.`);
      return false;
    } finally {
      set(value => value?.command !== command ? value : owns() ? { ...value, running: false } : null);
      if (mounted.current && owns()) setAnswered(n => n + 1);
    }
  }
  const pending = owner.value;
  const held = pending === null || pending.unknown === 0 ? null : <Hold
    id={`${owner.owner}:${pending.command.invitation.id}`} attempt={pending.unknown}
    {...resendFeedback({ line: { fact: "not sure that saved.", reason: UNKNOWN_OUTCOME_REASON },
      resend: { label: "retry", commandKey: `${owner.owner}:${pending.command.invitation.id}:${pending.command.accept}:retry`, busy: pending.running,
        run: () => { void send(pending.command, pending); } } })} />;
  return { list, admission, readFeedback, held, busy: pending?.running ? pending.command.invitation.id : null,
    blocked: pending !== null || admission === "Checking" || !remoteAttemptAllowed() || connectivity === "Offline",
    answer: (invitation: ViewerInvitation, accept: boolean) => send({ invitation, accept }, null) };
}

export default function LibraryInvitations({ state }: { state: ReturnType<typeof useLibraryInvitations> }) {
  const headingId = useId();
  const [declining, setDeclining] = useState<string | null>(null);
  const { list, admission, readFeedback, busy, blocked, answer } = state;
  if (installedApp && admission !== "Ready") return null;
  const shown = list.items.length > 0;
  return <>
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
                    disabled={blocked}
                    onClick={() => void answer(invitation, false).then(saved => { if (saved) setDeclining(null); })}
                    aria-busy={busy === invitation.id}
                  >
                    Decline
                  </Button>
                  <Button
                    disabled={blocked}
                    onClick={() => setDeclining(null)}
                  >
                    Keep
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    emphasis="strong"
                    disabled={blocked}
                    onClick={() => void answer(invitation, true)}
                    aria-busy={busy === invitation.id}
                  >
                    Accept
                  </Button>
                  <Button
                    disabled={blocked}
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
