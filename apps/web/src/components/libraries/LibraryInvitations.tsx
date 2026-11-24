"use client";

/** One libraries visit retains its exact invitation answer until acknowledgement or a
 * terminal invitation fence. A still-pending list never settles a sent answer. */
import { useId, useLayoutEffect, useRef, useState } from "react";
import { Hold, useOutcome, useResendFeedback } from "@/components/feedback/Feedback";
import { Failed } from "@/components/feedback/Fact";
import Button from "@/components/ui/Button";
import { personLabel } from "@/components/users/PeopleSearch";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { useChangeStamp } from "@/lib/api/changes";
import { isApiError, outcomeUnknown } from "@/lib/api/client";
import { UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import { respondToInvitation, viewerInvitationsIndex, type ViewerInvitation } from "@/lib/libraries/api";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { refuseLibrary } from "@/lib/libraries/errors";
import { installedApp, remoteAdmission, remoteAttemptAllowed } from "@/lib/native/admission";
import { useRemoteAdmission } from "@/lib/native/admissionHooks";
import { requirePaneRuntime, usePaneIsActive, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { useConnectivity } from "@/lib/renderEnvironment/connectivity";
import { definePaneVisitDataKey } from "@/lib/workspace/paneReturnMemento";
import PeopleIndex from "./PeopleIndex";
import styles from "./LibraryInvitations.module.css";

const recipientKey = (row: ViewerInvitation) => row.id;
const VISIT = definePaneVisitDataKey<Visit<Awaited<ReturnType<typeof viewerInvitationsIndex>>>>("Libraries.Invitations");
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
  const active = usePaneIsActive();
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
  const list = useServerValue({
    key: "/libraries/invites", stale: `${useChangeStamp("Libraries")}:${answered}`,
    enabled: active, visit: VISIT, load: viewerInvitationsIndex,
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
  const opening = active && list.status === "loading" && connectivity === "Online" && remoteAttemptAllowed();
  return { list, admission, opening, held, busy: pending?.running ? pending.command.invitation.id : null,
    blocked: pending !== null || admission === "Checking" || !remoteAttemptAllowed() || connectivity === "Offline",
    answer: (invitation: ViewerInvitation, accept: boolean) => send({ invitation, accept }, null) };
}

export default function LibraryInvitations({ state }: { state: ReturnType<typeof useLibraryInvitations> }) {
  const headingId = useId();
  const [declining, setDeclining] = useState<string | null>(null);
  const { list, admission, busy, blocked, answer } = state;
  if (installedApp && admission !== "Ready") return null;
  const rows = list.status === "ready" && list.error?.status !== 403 && list.error?.status !== 404 ? list.data.items : [];
  const shown = rows.length > 0;
  return <>
    {shown ?<section className={styles.inbox} aria-labelledby={headingId}>
      <div className={styles.heading}>
        <h2 id={headingId}>invitations · {rows.length}</h2>
        <p>accepting adds the library here.</p>
      </div>
      <PeopleIndex rows={rows} id={recipientKey} pinned={declining ?? busy} label="invitations" scope="libraries:invitations" render={invitation => (
          <div className={styles.row} key={invitation.id}>
            <span>
              {invitation.library_name} · {invitation.role === "admin" ? "admin" : "member"} · from{" "}
              {personLabel({
                display_name: invitation.inviter_display_name,
                email: invitation.inviter_email,
              })}
            </span>
            <span className={styles.actions}>
              {declining === invitation.id ? (
                <>
                  <span>decline this invitation?</span>
                  <Button
                    emphasis="strong" tone="danger"
                    aria-label={`decline invitation to ${invitation.library_name}`}
                    disabled={blocked}
                    onClick={() => void answer(invitation, false).then(saved => { if (saved) setDeclining(null); })}
                    aria-busy={busy === invitation.id}
                  >
                    decline
                  </Button>
                  <Button
                    disabled={busy !== null}
                    onClick={() => setDeclining(null)}
                  >
                    keep
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    emphasis="strong"
                    aria-label={`accept invitation to ${invitation.library_name}`}
                    disabled={blocked}
                    onClick={() => void answer(invitation, true)}
                    aria-busy={busy === invitation.id}
                  >
                    accept
                  </Button>
                  <Button
                    aria-label={`decline invitation to ${invitation.library_name}`}
                    disabled={blocked}
                    onClick={() => setDeclining(invitation.id)}
                  >
                    decline
                  </Button>
                </>
              )}
            </span>
          </div>
      )}/>
    </section> : null}
    {list.status !== "loading" && list.error !== null ? <Failed error={list.error} noun="invitations"
      retry={{ run: list.refetch, busy: list.status === "ready" ? list.refreshing : list.retrying }} /> : null}
  </>;
}
