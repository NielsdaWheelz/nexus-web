"use client";
/** Account lifetime owns the store. Until it is ready, setup stands where the workspace would:
 * a ruling while it opens, a `Fact` once a failure is a fact. One dropped response is not one:
 * a `Retrying` failure says nothing until it lags, and being offline is no reason until the store
 * has said it is not ready, since a provisioned store opens offline. Every setup failure but a
 * stale build keeps the way out of setup. Once open, the account holds words at risk
 * until they commit and speaks a condition that asks for a person once per onset; its mark and
 * row stay. Mounting another account cannot reuse a retired promise or its subscriptions. */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { AuthoredStore, SyncFailure, SyncStatus } from "@nexus/authored/types";
import { useWorkGuard } from "@/lib/unsavedWork";
import { localCall } from "@/lib/offline/localContent";
import { bindApiAccount, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { staleBuild, TRANSPORT_LINES, transportOf } from "@/lib/api/failure";
import { conditionLine, useCondition, useLagging } from "@/lib/account/condition";
import { bindBrowserAdmission, installedApp, subscribeAdmission, updateRemedy } from "@/lib/native/admission";
import { closeWritingRuntime, discardWritingRuntime, getWritingRuntime, isAuthoredStorageFailure } from "@/lib/notes/runtime";
import { useConnectivity } from "@/lib/renderEnvironment/connectivity";
import { discardFailedAuthoredSetup } from "./signOut";
import { AuthoredSetupError, openAuthoredStore } from "./client";
import { Hold, useOutcome } from "@/components/feedback/Feedback";
import { useTransportVerbs } from "@/components/feedback/stage";
import { Fact } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import type { CommandVerb, Line, Verbs } from "@/components/feedback/stage";
import { ClipboardWriteUnavailableError } from "@/lib/ui/copyText";
import { loginPath, parseReturnTarget } from "@/lib/auth/urls";
import { sessionSignIn } from "@/lib/native/client";
import { useCopyFeedback } from "@/components/ui/useCopyFeedback";
import Dialog from "@/components/ui/Dialog";
import styles from "./provider.module.css";
const SignInContext = createContext<{ signIn: () => void; busy: boolean } | null>(null);
export function useAuthoredSignIn() { const value = useContext(SignInContext); if (!value) throw new Error("authored sign-in owner is missing"); return value; }
const AccountContext = createContext<string | null>(null);
export function useAuthoredAccountId(): string { const accountId = useContext(AccountContext); if (accountId === null) throw new Error("authored account is not open"); return accountId; }
const StoreContext = createContext<AuthoredStore | null>(null);
const DetailContext = createContext<string | null>(null);
export function useAuthoredSyncDetail(): string | null { return useContext(DetailContext); }
const StatusContext = createContext<SyncStatus>("preparing");
export function useAuthoredStore(): AuthoredStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error("authored store is not open");
  return store;
}
export function useAuthoredStatus(): SyncStatus {
  const accountId = useAuthoredAccountId();
  const runtime = useMemo(() => getWritingRuntime(accountId), [accountId]);
  const writing = useSyncExternalStore(runtime.subscribe, runtime.snapshot, runtime.snapshot);
  const status = useContext(StatusContext);
  if (writing.error !== null || status === "local_error") return "local_error";
  if (writing.saving || status === "saving") return "saving";
  return status;
}
/** Whether a local commit has failed: its words are not saved, so nothing may call them safe. */
export function useCommitFailed(): boolean {
  const accountId = useAuthoredAccountId();
  const runtime = useMemo(() => getWritingRuntime(accountId), [accountId]);
  return useSyncExternalStore(runtime.subscribe, () => runtime.snapshot().error !== null, () => false);
}
/** Words a failed commit holds: the one spelling, whichever owner raises it. */
export const WORDS_AT_RISK: Line = { fact: "this note isn’t saved yet." };
const DIFFERENT_ACCOUNT: Line = { fact: "wrong account for this device.", reason: "sign in with the account already open here." };
const SIGN_IN_FAILED: Line = { fact: "couldn’t sign in." };
const NOT_OPENED = "couldn’t open your notes on this device.";
const PREPARING: { status: SyncStatus; detail: string | null; failure: SyncFailure } = { status: "preparing", detail: null, failure: null };
export function AuthoredProvider(props: { accountId: string; children: ReactNode } & (
  | { host: "share"; openWorkspace: () => void }
  | { host?: "workspace" | "shelf"; openWorkspace?: never }
)) {
  const { accountId, children, host = "workspace" } = props;
  const [store, setStore] = useState<AuthoredStore | null>(null);
  const [sync, setSync] = useState(PREPARING);
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<unknown | null>(null);
  const [opening, setOpening] = useState(true);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const fail = useCallback((error: unknown) => {
    setOpening(false);
    if (error instanceof AuthoredSetupError || isAuthoredStorageFailure(error) || isApiError(error) && !isSameSystemApiDefect(error)) setFailure(error); else setDefect({ error });
  }, []);
  const [attempt, retry] = useState(0);
  const guard = useWorkGuard();
  const { say } = useOutcome();
  const transportVerbs = useTransportVerbs();
  const online = useConnectivity() === "Online";
  const lagging = useLagging(sync.failure);
  useSyncExternalStore(subscribeAdmission, updateRemedy, updateRemedy);
  const [signingIn, setSigningIn] = useState(false);
  const signInRunning = useRef(false);
  const [signInResult, setSignInResult] = useState<Line | null>(null);
  useEffect(() => {
    if (!["sign_in_required", "saving", "local_error", "preparing"].includes(sync.status)) setSignInResult(null);
  }, [sync.status]);
  const signIn = () => {
    if (signInRunning.current || !ready && opening) return;
    if (host === "shelf") { void localCall("open_hosted", { path: "/downloads" }).catch(reportError); return; }
    if (props.host === "share") { props.openWorkspace(); return; }
    if (!installedApp) { window.location.assign(ready ? loginPath(parseReturnTarget(`${window.location.pathname}${window.location.search}`)) : "/login?switch_account=1"); return; }
    signInRunning.current = true; setSigningIn(true); setSignInResult(null);
    const refused = (line: Line) => { if (ready) say(line, [signInVerb]); else setSignInResult(line); };
    void sessionSignIn().then(result => {
      if (!ready && result === "Restored") { setOpening(true); retry(value => value + 1); }
      if (result === "DifferentAccount") refused(DIFFERENT_ACCOUNT);
      else if (result === "Failed") refused(SIGN_IN_FAILED);
    }, error => { reportError(error); refused(SIGN_IN_FAILED); })
      .finally(() => { signInRunning.current = false; setSigningIn(false); });
  };
  const latestSignIn = useRef(signIn);
  useLayoutEffect(() => { latestSignIn.current = signIn; });
  // One value per host, so a slip's verb outlives the renders that raised it.
  const signInVerb = useMemo<CommandVerb>(() => ({ label: host === "workspace" ? "sign in" : "open workspace", commandKey: "AuthoredSignIn", run: () => latestSignIn.current() }), [host]);
  useLayoutEffect(() => {
    if (!ready) return;
    const runtime = getWritingRuntime(accountId);
    return guard.register({
      id: `authored-writing:${accountId}`, scope: { kind: "account" }, subscribe: runtime.subscribe,
      read: () => { const writing = runtime.snapshot(); return { changed: writing.saving || writing.error !== null, unconfirmed: false, stopsBrowserWork: false }; },
    });
  }, [accountId, guard, ready]);
  useEffect(() => {
    const releaseAccount = bindApiAccount(accountId);
    const releaseAdmission = installedApp || host !== "workspace" ? () => {} : bindBrowserAdmission();
    let explicitlyRetired = false;
    const retired = () => { explicitlyRetired = true; releaseAccount(); releaseAdmission(); };
    window.addEventListener("nexus:authored-retired", retired);
    let live = true;
    let publishedReady = false;
    let opened: AuthoredStore | null = null;
    let unsubscribe: (() => void) | null = null;
    setStore(null); setReady(false); setOpening(true); setSync(PREPARING);
    void openAuthoredStore(accountId).then(value => {
      opened = value;
      if (!live) { void value.close(); return; }
      unsubscribe = value.sync_status((status, detail, failure) => {
        if (!live) return;
        setSync({ status, detail, failure });
        if (publishedReady || status === "preparing" && detail === null) return;
        void value.readReplica().then(replica => {
          if (!live || publishedReady) return;
          publishedReady = replica.provisioning_complete; setReady(publishedReady);
          if (publishedReady || detail !== null) { setFailure(null); setOpening(false); }
        }, error => { if (live && !publishedReady) fail(error); });
      });
      setStore(value);
    }, error => { if (live) fail(error); });
    return () => { window.removeEventListener("nexus:authored-retired", retired); releaseAccount(); releaseAdmission(); live = false; unsubscribe?.(); if (opened) void (explicitlyRetired ? discardWritingRuntime(accountId) : closeWritingRuntime(accountId)).then(() => opened?.close()).catch(reportError); };
  }, [accountId, attempt, host, fail]);
  if (defect) throw defect.error;
  if (failure === null && store && ready) return <SignInContext value={{ signIn, busy: signingIn }}><AccountContext value={accountId}><StoreContext value={store}><StatusContext value={sync.status}><DetailContext value={sync.detail}>
    <AccountSlips accountId={accountId} signIn={signInVerb} />{children}
  </DetailContext></StatusContext></StoreContext></AccountContext></SignInContext>;
  const retrySetup = () => { if (opening) return; setOpening(true); retry(value => value + 1); };
  const retryVerb: CommandVerb = { label: "retry", commandKey: "RetrySetup", run: retrySetup, busy: opening };
  const leaveVerb: CommandVerb = { label: host === "workspace" ? "sign out on this device" : "open workspace", commandKey: "LeaveSetup", run: () => {
    if (host === "shelf") void localCall("open_hosted", { path: "/downloads" }).catch(fail);
    else if (props.host === "share") props.openWorkspace();
    else void discardFailedAuthoredSetup(accountId).catch(fail);
  } };
  const recover: Verbs = [retryVerb, leaveVerb];
  const signInVerbs: Verbs = host === "workspace" ? [{ ...signInVerb, busy: signingIn || opening }, leaveVerb] : [signInVerb];
  const updateVerbs = transportVerbs("Update") ?? undefined;
  const transport = failure !== null && isApiError(failure) ? transportOf(failure) : null;
  const fact = (line: Line, verbs?: Verbs) => <Fact line={line} verbs={verbs} speak />;
  return <section className={styles.setup}>{
    failure instanceof AuthoredSetupError && failure.reason === "PendingUpgrade" ? fact({ fact: NOT_OPENED, reason: "sync all writing with the previous version on this device, then retry." }, [retryVerb])
    : transport !== null ? fact(TRANSPORT_LINES[transport].read("your notes"), transport === "Update" ? updateVerbs : transport === "SignIn" ? signInVerbs : recover)
    : failure !== null ? fact(failure instanceof AuthoredSetupError ? { fact: NOT_OPENED, reason: failure.reason === "Persistence" ? "this browser hasn’t allowed persistent storage." : "this browser has no shared workers." } : { fact: NOT_OPENED }, recover)
    : signInResult !== null ? fact(signInResult, signInVerbs)
    : sync.status === "sign_in_required" ? fact({ fact: "sign in to see your notes." }, signInVerbs)
    : sync.status === "update_required" ? fact({ fact: staleBuild() }, updateVerbs)
    : sync.status === "local_error" ? fact({ fact: NOT_OPENED }, recover)
    // `opening` ends when the store says it is not ready; until then offline is no reason.
    : !online && !opening ? <Fact line={TRANSPORT_LINES.Offline.read("your notes")} />
    : sync.failure?.kind === "Refused" ? fact({ fact: "couldn’t load your notes." }, recover)
    : lagging ? fact(TRANSPORT_LINES.Unavailable.read("your notes"), recover)
    : <Ruling />
  }</section>;
}

/** Words at risk hold, assertively, until they commit; a stopped store does not throw, so this
 * stays mounted above every pane. A condition that asks for a person speaks once per onset at
 * the workspace, and retracts when it resolves. */
function AccountSlips({ accountId, signIn }: { accountId: string; signIn: CommandVerb }) {
  const guard = useWorkGuard();
  const { say } = useOutcome();
  const runtime = useMemo(() => getWritingRuntime(accountId), [accountId]);
  const writing = useSyncExternalStore(runtime.subscribe, runtime.snapshot, runtime.snapshot);
  const condition = useCondition();
  const updateVerb = useTransportVerbs()("Update")?.[0] ?? null;
  // `Update`'s line and verb follow the remedy; under any other condition a remedy change is no onset.
  const updateRemedyKey = useSyncExternalStore(subscribeAdmission, () => condition === "Update" ? updateRemedy() : null, () => null);
  const [incident, setIncident] = useState<{ occurrence: object | null; serial: number; attempt: number }>({ occurrence: null, serial: 0, attempt: 0 });
  if (incident.occurrence !== writing.error_occurrence) setIncident({ occurrence: writing.error_occurrence, serial: incident.serial + 1, attempt: 0 });
  const [retrying, setRetrying] = useState(false);
  const [manualCopy, setManualCopy] = useState<string | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const copied = useCopyFeedback(writing.error_occurrence);
  const commitFailed = useRef(false);
  const conditionSlip = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    commitFailed.current = writing.error !== null;
    if (commitFailed.current && condition === "Refused") conditionSlip.current?.();
  }, [writing.error, condition]);
  const restart = useMemo<CommandVerb>(() => ({ label: "restart nexus", commandKey: "RestartNexus", run: () => { if (guard.confirmDocumentExit()) window.location.reload(); } }), [guard]);
  useEffect(() => {
    if (condition !== "SyncLocal" && condition !== "Update" && condition !== "SignIn" && condition !== "Refused") return;
    const verbs = condition === "SyncLocal" ? [restart] as const : condition === "Update" ? updateVerb === null ? null : [updateVerb] as const : condition === "SignIn" ? [signIn] as const : null;
    const retract = say(conditionLine(condition, commitFailed.current), verbs ?? undefined);
    conditionSlip.current = retract;
    return () => { retract(); if (conditionSlip.current === retract) conditionSlip.current = null; };
  }, [say, restart, signIn, condition, updateRemedyKey, updateVerb]);
  if (defect) throw defect.error;
  if (writing.error === null) return null;
  const stopped = condition === "Stopped";
  const copyText: CommandVerb = { label: "copy text", commandKey: "CopyUncommittedText", copied: copied.occurrence ?? undefined, run: () => {
    void runtime.uncommittedText().then(async text => {
      try { await copied.copy(text); }
      catch (error) { if (error instanceof ClipboardWriteUnavailableError) setManualCopy(text); else setDefect({ error }); }
    }, error => setDefect({ error }));
  } };
  const first: CommandVerb = stopped ? restart : { label: "retry", commandKey: "RetryCommit", busy: retrying, run: () => {
    if (retrying) return;
    setRetrying(true);
    void runtime.retry().catch(() => setIncident(current => ({ ...current, attempt: current.attempt + 1 }))).finally(() => setRetrying(false));
  } };
  return <>
    <Hold id={`authored-writing:${incident.serial}:${stopped ? "stopped" : "failed"}`} attempt={incident.attempt} risk
      line={stopped ? conditionLine("Stopped", true) : WORDS_AT_RISK} verbs={runtime.hasUncommittedText() ? [first, copyText] : [first]} />
    {manualCopy !== null ? <Dialog open title="copy text" onClose={() => setManualCopy(null)}>
      <p>select the text and copy it before leaving.</p><textarea aria-label="unsaved writing" readOnly value={manualCopy} />
    </Dialog> : null}
  </>;
}
