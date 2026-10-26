"use client";
/** Account lifetime owns the store. Provisioning failure remains at this surface;
 * mounting another account cannot reuse a retired promise or its subscriptions. */
import { createContext, useContext, useEffect, useLayoutEffect, useState, useMemo, useSyncExternalStore } from "react";
import type { AuthoredStore, SyncStatus } from "@nexus/authored/types";
import { useWorkGuard } from "@/lib/unsavedWork";
import { localCall } from "@/lib/offline/localContent";
import { bindApiAccount } from "@/lib/api/client";
import { bindBrowserAdmission, installedApp } from "@/lib/native/admission";
import { closeWritingRuntime, discardWritingRuntime, getWritingRuntime } from "@/lib/notes/runtime";
import { discardFailedAuthoredSetup } from "./signOut";
import { SIGN_IN_SYNC_DETAIL, UPDATE_SYNC_DETAIL } from "./status";
import { openAuthoredStore } from "./client";
import { FeedbackState, type FeedbackActions } from "@/components/feedback/Feedback";
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
  const [failure, setFailure] = useState<Error | null>(null);
  const [attempt, retry] = useState(0);
  const guard = useWorkGuard();
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
    setStore(null); setReady(false); setDetail(null); setFailure(null); setStatus("preparing");
    void openAuthoredStore(accountId).then(value => {
      opened = value;
      if (!live) { void value.close(); return; }
      unsubscribe = value.sync_status((next, cause) => {
        if (!live) return;
        setStatus(next); setDetail(cause);
        if (publishedReady || next === "preparing") return;
        void value.readReplica().then(replica => {
          if (!live || publishedReady) return;
          publishedReady = replica.provisioning_complete; setReady(publishedReady);
        }, error => { if (live && !publishedReady) setFailure(error); });
      });
      setStore(value);
    }, error => { if (live) setFailure(error instanceof Error ? error : new Error("couldn’t open your notes on this device")); });
    return () => { window.removeEventListener("nexus:authored-retired", retired); releaseAccount(); releaseAdmission(); live = false; unsubscribe?.(); if (opened) void (explicitlyRetired ? discardWritingRuntime(accountId) : closeWritingRuntime(accountId)).then(() => opened?.close()).catch(reportError); };
  }, [accountId, attempt, host]);
  if (failure) {
    const leave = () => {
      if (host === "shelf") void localCall("open_hosted", { path: "/downloads" }).catch(error => setFailure(error));
      else if (host === "share") window.location.assign("nexus-share://open?path=%2Fdownloads");
      else void discardFailedAuthoredSetup(accountId).catch(error => setFailure(error));
    };
    return <FeedbackState content={{ tone: "Danger", title: "couldn’t open your notes on this device", message: failure.message }} announcement="Polite" actions={[{ label: "retry", onClick: () => retry(value => value + 1) }, { label: host === "workspace" ? "sign out on this device" : "open workspace", onClick: leave }]} />;
  }
  if (!store || !ready) {
    const signIn = () => {
      if (host === "shelf") {
        void localCall("open_hosted", { path: "/downloads" }).catch(error => setFailure(error));
      } else if (host === "share") {
        window.location.assign("nexus-share://open?path=%2Fdownloads");
      } else if (installedApp) {
        void import("@/lib/native/client").then(client => client.sessionSignIn()).then(() => retry(value => value + 1)).catch(error => setFailure(error));
      } else window.location.assign("/login?switch_account=1");
    };
    const actions: FeedbackActions | undefined = detail === null ? undefined
      : detail === SIGN_IN_SYNC_DETAIL ? [{ label: host !== "workspace" ? "open workspace to sign in" : "sign in", onClick: signIn }]
      : detail === UPDATE_SYNC_DETAIL ? installedApp || host !== "workspace" ? undefined : [{ label: "reload", onClick: () => window.location.reload() }]
      : [{ label: "retry", onClick: () => retry(value => value + 1) }];
    return <FeedbackState content={{ tone: "Neutral", title: "preparing your notes", message: detail ?? undefined }} announcement={detail === null ? "None" : "Polite"} actions={host === "workspace" ? [...(actions ?? []), { label: "sign out on this device", onClick: () => { void discardFailedAuthoredSetup(accountId).catch(error => setFailure(error)); } }] : actions} />;
  }
  return <AccountContext value={accountId}><StoreContext value={store}><StatusContext value={status}><DetailContext value={detail}>{children}</DetailContext></StatusContext></StoreContext></AccountContext>;
}
