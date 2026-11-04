"use client";

/** One host's stage and mounted command outcomes. Domain owners retain commands; this provider
 * owns presentation only. Its explicit shell supplies the host's actual sign-in operation. */
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { admissionTransport, staleBuild, TRANSPORT_LINES, transportOf } from "@/lib/api/failure";
import { useThrowLater } from "@/lib/api/serverState";
import { isAbortError } from "@/lib/errors";
import { remoteAdmission, remoteAttemptAllowed, subscribeAdmission } from "@/lib/native/admission";
import { useConnectivity } from "@/lib/renderEnvironment/connectivity";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { OverlayContext } from "@/lib/ui/overlay";
import Slips from "./Slips";
import { createStage, ShellContext, StageContext, useShell, useTransportVerbs, verbsForTransport, useStage, type Address, type CommandVerb, type Line, type Owner, type Retract, type Shell, type Verb, type Verbs } from "./stage";

/** One account's presentation, above every owner that speaks. The geometry provider is above
 * this. `shell` is the host's: the workspace signs in, shelf and capture open the workspace. Its
 * sign-in command stays one value across renders; its separate busy state updates in-flow verbs. */
export function FeedbackProvider({ shell, children }: { shell: Shell; children: ReactNode }) {
  const [stage] = useState(createStage);
  useEffect(() => stage.connect(), [stage]);
  return <StageContext value={stage}><ShellContext value={shell}>
    {children}
    <Slips />
  </ShellContext></StageContext>;
}


function useAddress(): Address {
  const paneId = usePaneRuntime()?.paneId ?? null;
  return useMemo(() => paneId === null ? { kind: "Workspace" } : { kind: "Pane", paneId }, [paneId]);
}

export interface Outcome {
  say(line: Line, verbs?: Verbs): Retract;
  /** `title` is the command's fact; its reason and verb come from the transport. `verb` is the
   * owner's retry, shown only where the transport offers one, so a stale build gets reload alone.
   * An abort is no outcome and shows nothing. A defect rethrows through the owner's boundary. */
  fail(error: unknown, title: string, verb?: Verb): Retract;
}

/** Any owner, above or below panes: the address follows the pane the owner renders in. */
export function useOutcome(): Outcome {
  const stage = useStage();
  const address = useAddress();
  const { signIn } = useShell();
  const throwLater = useThrowLater();
  const say = useCallback<Outcome["say"]>((line, verbs) => stage.say({ address, line, verbs: verbs ?? null }), [stage, address]);
  // Admission is read as `fail` is called, so no owner renders again as it moves.
  const fail = useCallback<Outcome["fail"]>((error, title, verb) => {
    if (isAbortError(error)) return () => {};
    if (!isApiError(error) || isSameSystemApiDefect(error)) {
      throwLater({ error });
      return () => {};
    }
    const transport = transportOf(error);
    return stage.say({ address, line: TRANSPORT_LINES[transport].command(title), verbs: verbsForTransport(transport, { retry: verb, signIn }) });
  }, [stage, address, signIn, throwLater]);
  return useMemo(() => ({ say, fail }), [say, fail]);
}

/** A held remote write's presentation at its owner's render. An update preserves the owned
 * fact and offers its current remedy alone; sign-in comes from the shell. Otherwise the exact
 * resend stays busy while checking, or disabled with the reason its send would remain local.
 * A null resend leaves only the owner's secondary action. The function changes whenever its
 * admission or shell remedy changes, so a memo may retain it. */
export function useResendFeedback(): (input: { line: Line; resend: CommandVerb | null; sends?: () => boolean; secondary?: Verb }) => { line: Line; verbs: Verbs | null } {
  const verbsFor = useTransportVerbs();
  const admission = useSyncExternalStore(subscribeAdmission, remoteAdmission, remoteAdmission);
  const connectivity = useConnectivity();
  return useCallback(({ line, resend, sends = remoteAttemptAllowed, secondary }) => {
    const transport = admissionTransport(admission);
    if (transport === "Update") return { line: { ...line, reason: staleBuild() }, verbs: verbsFor(transport) };
    const signIn = transport === "SignIn" ? verbsFor(transport)?.[0] ?? null : null;
    const offline = connectivity === "Offline";
    const unsent = transport !== null && (transport === "Offline" || !sends());
    const primary = signIn ?? (resend === null ? null : { ...resend, busy: resend.busy || admission === "Checking",
      disabledReason: offline ? TRANSPORT_LINES.Offline.command("").reason
        : unsent ? TRANSPORT_LINES[transport].command("").reason : resend.disabledReason });
    const verbs: Verbs | null = primary === null ? secondary ? [secondary] : null
      : secondary ? [primary, secondary] : [primary];
    return { line, verbs };
  }, [verbsFor, admission, connectivity]);
}

/** A fact that stands while its owner holds it: mounted is present, unmounted is resolved. `id`
 * keys the row, so an owner that moves between parents keeps its row, its tuck and its speech,
 * and stands it where it now renders; two owners of one id share one row, standing where the
 * earlier renders; an owner whose id changes lets the old row go at once. `attempt` keys speech,
 * so a failed retry speaks again. */
export function Hold({ id, attempt = 0, line, verbs, risk = false }: { id: string; attempt?: number; line: Line; verbs?: Verbs | null; risk?: boolean }) {
  const stage = useStage();
  const address = useAddress();
  const frame = useContext(OverlayContext);
  const owner = useRef<Owner>({ address });
  useLayoutEffect(() => {
    owner.current.address = address;
    stage.hold({ key: id, owner: owner.current, frame, risk, line, verbs: verbs ?? null, attempt });
  });
  useLayoutEffect(() => stage.own(id, owner.current), [stage, id]);
  return null;
}
