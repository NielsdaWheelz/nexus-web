"use client";
/** Account lifetime owns the store. Provisioning failure remains at this surface;
 * mounting another account cannot reuse a retired promise or its subscriptions. */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useMemo, useSyncExternalStore } from "react";
import type { AuthoredStore, SyncStatus } from "@nexus/authored/types";
import { useWorkGuard } from "@/lib/unsavedWork";
import { localCall } from "@/lib/offline/localContent";
import { apiTransportFeedback, bindApiAccount, isApiError } from "@/lib/api/client";
import { bindBrowserAdmission, installedApp } from "@/lib/native/admission";
import { closeWritingRuntime, discardWritingRuntime, getWritingRuntime, isAuthoredStorageFailure, writingStoreStopped } from "@/lib/notes/runtime";
import { discardFailedAuthoredSetup } from "./signOut";
import { SIGN_IN_SYNC_DETAIL, UPDATE_SYNC_DETAIL } from "./status";
import { AuthoredSetupError, openAuthoredStore } from "./client";
import { FeedbackBusy, FeedbackFailure, FeedbackRecoveryControl, FeedbackState, useFeedbackOccurrence, type FeedbackContent, type FeedbackActions } from "@/components/feedback/Feedback";
import { ClipboardWriteUnavailableError } from "@/lib/ui/copyText";
import { loginPath, parseReturnTarget } from "@/lib/auth/urls";
import { sessionSignIn } from "@/lib/native/client";
import { useCopyFeedback } from "@/components/ui/useCopyFeedback";
import Dialog from "@/components/ui/Dialog";
import FeedbackSurface from "@/components/feedback/FeedbackSurface";
import { Scope } from "@/components/feedback/scope";
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
export function AuthoredProvider({ accountId, children, host = "workspace" }: { accountId: string; children: React.ReactNode; host?: "workspace" | "shelf" | "share" }) {
  const [store, setStore] = useState<AuthoredStore | null>(null);
  const [status, setStatus] = useState<SyncStatus>("preparing");
  const [ready, setReady] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [failure, setFailure] = useState<FeedbackContent | null>(null);
  const [opening, setOpening] = useState(true);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const fail = useCallback((error: unknown) => {
    setOpening(false);
    const title = "couldn’t open your notes on this device";
    const content = error instanceof AuthoredSetupError ? { tone: "Warning" as const, title,
      message: error.reason === "Persistence" ? "allow persistent storage for nexus, then retry." : "open nexus in a browser with shared worker support." }
      : isAuthoredStorageFailure(error) ? { tone: "Warning" as const, title, message: "check available storage and retry." }
      : isApiError(error) ? apiTransportFeedback(error, title) : null;
    if (content === null) setDefect({ error }); else setFailure(content);
  }, []);
  const [attempt, retry] = useState(0);
  const guard = useWorkGuard();
  const [signingIn, setSigningIn] = useState(false);
  const signInRunning = useRef(false);
  const [signInResult, setSignInResult] = useState<{ content: FeedbackContent; occurrence: object } | null>(null);
  useEffect(() => {
    if (!["sign_in_required", "saving", "local_error", "preparing"].includes(status)) setSignInResult(null);
  }, [status]);
  const signIn = () => {
    if (signInRunning.current || !ready && opening) return;
    if (host === "shelf") { void localCall("open_hosted", { path: "/downloads" }).catch(reportError); return; }
    if (host === "share") { window.location.assign("nexus-share://open?path=%2Fdownloads"); return; }
    if (!installedApp) { window.location.assign(ready ? loginPath(parseReturnTarget(`${window.location.pathname}${window.location.search}`)) : "/login?switch_account=1"); return; }
    signInRunning.current = true; setSigningIn(true); setSignInResult(null);
    void sessionSignIn().then(result => {
      if (!ready && result === "Restored") { setOpening(true); retry(value => value + 1); }
      if (result === "DifferentAccount") setSignInResult({ content: { tone: "Warning", title: "use the account already open here", message: SIGN_IN_SYNC_DETAIL }, occurrence: {} });
      else if (result === "Failed") setSignInResult({ content: { tone: "Warning", title: "couldn’t sign in", message: "connect and try signing in again." }, occurrence: {} });
    }, error => { reportError(error); setSignInResult({ content: { tone: "Warning", title: "couldn’t sign in", message: "try signing in again." }, occurrence: {} }); })
      .finally(() => { signInRunning.current = false; setSigningIn(false); });
  };
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
    let currentDetail: string | null = null;
    let opened: AuthoredStore | null = null;
    let unsubscribe: (() => void) | null = null;
    setStore(null); setReady(false); setOpening(true); setStatus("preparing");
    void openAuthoredStore(accountId).then(value => {
      opened = value;
      if (!live) { void value.close(); return; }
      unsubscribe = value.sync_status((next, cause) => {
        if (!live) return;
        currentDetail = cause;
        setStatus(next);
        if (publishedReady) { setDetail(cause); return; }
        if (cause !== null) setDetail(cause);
        if (next === "preparing" && cause === null) return;
        void value.readReplica().then(replica => {
          if (!live || publishedReady) return;
          publishedReady = replica.provisioning_complete; setReady(publishedReady);
          if (publishedReady) setDetail(currentDetail);
          if (publishedReady || currentDetail !== null) { setFailure(null); setOpening(false); }
        }, error => { if (live && !publishedReady) fail(error); });
      });
      setStore(value);
    }, error => { if (live) fail(error); });
    return () => { window.removeEventListener("nexus:authored-retired", retired); releaseAccount(); releaseAdmission(); live = false; unsubscribe?.(); if (opened) void (explicitlyRetired ? discardWritingRuntime(accountId) : closeWritingRuntime(accountId)).then(() => opened?.close()).catch(reportError); };
  }, [accountId, attempt, host, fail]);
  const retrySetup = () => { if (opening) return; setOpening(true); retry(value => value + 1); };
  if (defect) throw defect.error;
  if (failure) {
    const leave = () => {
      if (host === "shelf") void localCall("open_hosted", { path: "/downloads" }).catch(error => fail(error));
      else if (host === "share") window.location.assign("nexus-share://open?path=%2Fdownloads");
      else void discardFailedAuthoredSetup(accountId).catch(error => fail(error));
    };
    return <SetupFeedback content={failure} subject={accountId} waiting={false} announcement="Polite" actions={[{ label: "retry", onClick: retrySetup, busy: opening }, { label: host === "workspace" ? "sign out on this device" : "open workspace", onClick: leave }]} />;
  }
  if (!store || !ready) {
    const actions: FeedbackActions | undefined = detail === null ? undefined
      : detail === SIGN_IN_SYNC_DETAIL ? [{ label: host !== "workspace" ? "open workspace to sign in" : "sign in", onClick: signIn, busy: signingIn || opening }]
      : detail === UPDATE_SYNC_DETAIL ? installedApp || host !== "workspace" ? undefined : [{ label: "reload", onClick: () => window.location.reload() }]
      : [{ label: "retry", onClick: retrySetup, busy: opening }];
    return <SetupFeedback subject={accountId} waiting={opening && detail === null}
      content={detail === SIGN_IN_SYNC_DETAIL && signInResult !== null ? signInResult.content : { tone: detail === null ? "Neutral" : "Warning", title: detail === null ? "your notes on this device"
        : detail === SIGN_IN_SYNC_DETAIL ? "sign in to open your notes" : detail === UPDATE_SYNC_DETAIL ? "update nexus to open your notes" : "couldn’t prepare your notes on this device",
        message: detail === SIGN_IN_SYNC_DETAIL || detail === UPDATE_SYNC_DETAIL ? detail : detail === null ? undefined : "retry preparing your notes." }}
      announcement={detail === null ? "None" : "Polite"} actions={host === "workspace" ? [...(actions ?? []), { label: "sign out on this device", onClick: () => { void discardFailedAuthoredSetup(accountId).catch(error => fail(error)); } }] : actions} />;
  }
  return <SignInContext value={{ signIn, busy: signingIn }}><AccountContext value={accountId}><StoreContext value={store}><StatusContext value={status}><DetailContext value={detail}><AccountFailure accountId={accountId} status={status} detail={detail} signIn={signIn} signingIn={signingIn} signInResult={signInResult} host={host} />{children}</DetailContext></StatusContext></StoreContext></AccountContext></SignInContext>;
}

/** Entry setup uses its existing standalone host, or owns the workspace entry surface. */
function SetupFeedback({ content, actions, announcement, waiting, subject }: {
  content: FeedbackContent; actions?: FeedbackActions; announcement: "None" | "Polite"; waiting: boolean; subject: string;
}) {
  const scope = useContext(Scope);
  const [bounds, setBounds] = useState<HTMLElement | null>(null);
  const feedback = <><FeedbackBusy pending={waiting} subject={subject} /><FeedbackState content={content} actions={actions} announcement={announcement} /></>;
  if (scope !== null) return feedback;
  return <section ref={setBounds} tabIndex={-1} className={styles.setup}>
    <FeedbackSurface bounds={bounds} interaction={null} modal={null} active protectedTargets={() => []} returnFocus={() => bounds}>
      <FeedbackRecoveryControl className={styles.recovery} />
      {feedback}
    </FeedbackSurface>
  </section>;
}

/** The account's only failure projection. The command/store remains the recovery owner. */
function AccountFailure({ accountId, status, detail, signIn, signingIn, signInResult, host }: {
  accountId: string; status: SyncStatus; detail: string | null; signIn: () => void; signingIn: boolean;
  signInResult: { content: FeedbackContent; occurrence: object } | null; host: "workspace" | "shelf" | "share";
}) {
  const guard = useWorkGuard();
  const runtime = useMemo(() => getWritingRuntime(accountId), [accountId]);
  const writing = useSyncExternalStore(runtime.subscribe, runtime.snapshot, runtime.snapshot);
  const [retrying, setRetrying] = useState(false);
  const [outcome, setOutcome] = useState<{ incident: object; occurrence: object } | null>(null);
  const [manualCopy, setManualCopy] = useState<string | null>(null);
  const [copyUnavailable, setCopyUnavailable] = useState<object | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const remote = ["sign_in_required", "update_required", "sync_error"].includes(status);
  const [condition, setCondition] = useState<{ status: SyncStatus; detail: string | null; occurrence: object } | null>(null);
  let sync = condition;
  if (remote && (condition?.status !== status || condition.detail !== detail)) {
    sync = { status, detail, occurrence: condition?.status === status ? condition.occurrence : {} };
    setCondition(sync);
  } else if (!remote && !["saving", "local_error", "preparing"].includes(status) && condition !== null) { sync = null; setCondition(null); }
  const storeStopped = status === "local_error" && !writing.saving;
  const stoppedOccurrence = useFeedbackOccurrence(storeStopped);
  const syncStatus = sync?.status ?? status;
  const syncDetail = sync?.detail ?? detail;
  if (defect) throw defect.error;
  const stopped = writing.error !== null && writingStoreStopped(writing.error);
  const incident = writing.error_occurrence ?? (storeStopped ? stoppedOccurrence : sync?.occurrence ?? null);
  const copied = useCopyFeedback(incident);
  const copyAvailable = writing.error !== null && runtime.hasUncommittedText();
  const copy = () => { void runtime.uncommittedText().then(async text => {
    try { await copied.copy(text); }
    catch (error) { if (error instanceof ClipboardWriteUnavailableError) setCopyUnavailable(incident); else setDefect({ error }); }
  }, error => setDefect({ error })); };
  const retrySaving = () => {
    if (retrying || incident === null) return;
    setRetrying(true);
    void runtime.retry().catch(() => setOutcome({ incident, occurrence: {} })).finally(() => setRetrying(false));
  };
  const showWriting = () => { void runtime.uncommittedText().then(setManualCopy, error => setDefect({ error })); };
  const local = writing.error !== null;
  const content: FeedbackContent = local ? { tone: "Warning", title: stopped ? "local notes stopped" : "couldn’t confirm saving on this device",
    message: copyUnavailable === incident ? "copying isn’t available here. show the writing to copy it." : stopped ? copyAvailable ? "copy your writing before restarting nexus." : undefined : "keep nexus open. retry saving." }
    : storeStopped ? { tone: "Warning", title: "local notes stopped" }
    : signInResult !== null && syncStatus === "sign_in_required" ? signInResult.content
    : { tone: "Warning", title: syncStatus === "sign_in_required" ? "sign in to sync" : syncStatus === "update_required" ? "update nexus to sync" : "couldn’t sync",
      message: [!writing.saving && writing.error === null && !["saving", "preparing", "local_error"].includes(status) ? "changes are saved on this device." : null, syncDetail].filter(Boolean).join(" ") || undefined };
  const restart = () => { if (guard.confirmDocumentExit()) window.location.reload(); };
  const copyAction = copyUnavailable === incident ? { label: "show unsaved writing", onClick: showWriting } : { label: "copy unsaved writing", onClick: copy, copiedOccurrence: copied.occurrence ?? undefined };
  const primary = local ? { label: stopped ? "restart nexus" : "retry saving", onClick: stopped ? restart : retrySaving, busy: retrying }
    : syncStatus === "sign_in_required" ? { label: host === "workspace" ? "sign in" : "open workspace to sign in", onClick: signIn, busy: signingIn }
    : storeStopped || syncStatus === "update_required" && host === "workspace" && !installedApp ? { label: "restart nexus", onClick: restart } : null;
  const actions: FeedbackActions | undefined = primary ? copyAvailable ? stopped ? [copyAction, primary] : [primary, copyAction] : [primary] : undefined;
  return <>
    {incident ? <FeedbackFailure scope="Account" occurrence={incident}
      announcementOccurrence={local && outcome?.incident === incident ? outcome.occurrence : syncStatus === "sign_in_required" ? signInResult?.occurrence : undefined}
      content={content} actions={actions} announcement={local ? "Assertive" : "Polite"} /> : null}
    {manualCopy !== null ? <Dialog open title="copy unsaved writing" onClose={() => setManualCopy(null)}>
      <p>select the text and copy it before leaving.</p><textarea aria-label="unsaved writing" readOnly value={manualCopy} />
    </Dialog> : null}
  </>;
}
