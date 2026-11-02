"use client";

// Installed entry: committed local state mounts independently of credential
// admission. Later bootstrap may refresh identity/profile, never live navigation.
import { useCallback, useEffect, useRef, useState } from "react";
import { CatalogProvider } from "@/lib/catalog/provider";
import AuthenticatedShell from "@/app/(authenticated)/AuthenticatedShell";
import styles from "@/app/(authenticated)/layout.module.css";
import { AuthenticatedWorkspaceErrorBoundary } from "@/app/(authenticated)/AuthenticatedWorkspaceErrorBoundary";
import { WorkProvider } from "@/lib/unsavedWork";
import { isApiError } from "@/lib/api/client";
import { staleBuild } from "@/lib/api/failure";
import { Fact } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import type { CommandVerb, Line, Verbs } from "@/components/feedback/stage";
import type { RenderEnvironment } from "@/lib/renderEnvironment/types";
import { DeviceWorkspaceContext } from "./workspaceContext";
import type { DeviceStartup, SignInResult } from "./contracts";
import { useRemoteAdmission } from "./admissionHooks";
import { hello, readDeviceStartup, sessionCheck, sessionSignIn, sessionSignOut } from "./client";

type Binding = NonNullable<DeviceStartup["binding"]>;


export default function DeviceWorkspace({ renderEnvironment }: { renderEnvironment: RenderEnvironment }) {
  const [startup, setStartup] = useState<DeviceStartup | null | undefined>(undefined);
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  const [signInResult, setSignInResult] = useState<SignInResult | null>(null);
  const [signInFailure, setSignInFailure] = useState<{ error: unknown } | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [cleanupFailure, setCleanupFailure] = useState<{ error: unknown } | null>(null);
  const admission = useRemoteAdmission();
  const revision = useRef("0");
  const initial = useRef<Binding["workspace"] | null>(null);
  const live = useRef(true);
  const reading = useRef(0);
  const read = useCallback(async () => {
    const request = ++reading.current;
    try {
      const next = await readDeviceStartup();
      if (!live.current || request !== reading.current) return;
      if (next?.binding && initial.current === null) {
        initial.current = next.binding.workspace;
        revision.current = next.binding.workspace_revision;
      }
      if (!next?.binding) { initial.current = null; revision.current = "0"; }
      setStartup(next);
      setFailure(null);
    } catch (error) {
      if (!live.current || request !== reading.current) return;
      if (isApiError(error) && error.code === "E_LOCAL_CLEANUP") {
        initial.current = null;
        revision.current = "0";
        setStartup(null);
      }
      setFailure({ error });
    }
  }, []);
  useEffect(() => {
    live.current = true;
    void read();
    void hello().catch(error => { if (live.current) setFailure({ error }); });
    const check = () => { void sessionCheck().catch(() => undefined); };
    window.addEventListener("online", check);
    const foreground = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", foreground);
    window.addEventListener("nexus:device-settings-refreshed", read);
    return () => {
      live.current = false;
      window.removeEventListener("online", check);
      document.removeEventListener("visibilitychange", foreground);
      window.removeEventListener("nexus:device-settings-refreshed", read);
    };
  }, [read]);
  useEffect(() => { if (admission === "Ready") void read(); }, [admission, read]);
  if (startup?.binding && initial.current !== null) {
    const binding = startup.binding;
    return <DeviceWorkspaceContext value={{ initial: initial.current, revision }}>
      <WorkProvider key={binding.account.account_id}><AuthenticatedWorkspaceErrorBoundary accountId={binding.account.account_id}>
        <CatalogProvider key={binding.account.account_id} accountId={binding.account.account_id}><AuthenticatedShell
          account={{ accountId: binding.account.account_id, calendarTimeZone: binding.account.calendar_time_zone }}
          readerProfile={binding.reader_profile}
          renderEnvironment={renderEnvironment}
          initialState={initial.current}
          seeds={{}}
          entryFailure={null}
          locationLinkFailure={null}
        /></CatalogProvider>
      </AuthenticatedWorkspaceErrorBoundary></WorkProvider>
    </DeviceWorkspaceContext>;
  }
  const signIn = () => {
    if (signingIn) return;
    setSigningIn(true);
    setSignInResult(null);
    setSignInFailure(null);
    void sessionSignIn().then(result => {
      setSignInResult(result);
      if (result === "Restored") void read();
    }, error => { setSignInFailure({ error }); setSignInResult("Failed"); }).finally(() => setSigningIn(false));
  };
  const clearDevice = () => {
    if (signingIn || (cleanupFailure === null && !window.confirm("sign out on this device?\n\nlocal downloads, saved catalog and workspace will be removed. pending reading and listening progress will be lost."))) return;
    setSigningIn(true);
    void sessionSignOut().then(() => {
      setCleanupFailure(null);
      setSignInFailure(null);
      setSignInResult(null);
      void read();
    }, error => setCleanupFailure({ error })).finally(() => setSigningIn(false));
  };
  const wrong = signInResult === "DifferentAccount";
  const catalogRecovery = isApiError(signInFailure?.error) &&
    (signInFailure.error.code === "E_CATALOG_INVALID" || signInFailure.error.code === "E_CATALOG_IO");
  const startupCleanup = isApiError(failure?.error) && failure.error.code === "E_LOCAL_CLEANUP" ? failure.error : null;
  // These are distinct recovery steps, not updates to one published action.
  const stage = startupCleanup !== null ? "startup-cleanup"
    : cleanupFailure !== null ? "signout-cleanup"
    : catalogRecovery ? "catalog-recovery"
    : failure ? "snapshot-failed"
    : admission === "UpdateRequired" ? "update-required"
    : startup === undefined ? "opening"
    : wrong ? "different-account"
    : signInResult === "Failed" ? "sign-in-failed" : "sign-in";
  const signInVerb: CommandVerb = { label: "sign in", commandKey: "DeviceSignIn", busy: signingIn, run: signIn };
  const signOutVerb: CommandVerb = { label: "sign out on this device", commandKey: "DeviceSignOut", busy: signingIn, run: clearDevice };
  const retryRead: CommandVerb = { label: "retry", commandKey: "RetryDeviceStartup", run: () => void read() };
  const unfinished: Line = { fact: "sign out didn’t finish.", reason: "this device still holds account data." };
  const fact = (line: Line, verbs?: Verbs) => <Fact key={stage} line={line} verbs={verbs} speak />;
  return <div style={{ height: "100%", overflowY: "auto" }}><main className={styles.error}>{
    stage === "startup-cleanup" ? fact(unfinished, [retryRead])
    : stage === "signout-cleanup" ? fact(unfinished, [{ label: "retry", commandKey: "RetryDeviceSignOut", busy: signingIn, run: clearDevice }])
    : stage === "catalog-recovery" ? fact({ fact: "couldn’t open saved lists on this device." }, [signOutVerb])
    : stage === "snapshot-failed" ? fact({ fact: "couldn’t open your saved workspace." }, [retryRead])
    : stage === "update-required" ? fact({ fact: staleBuild() })
    : stage === "opening" ? <Ruling />
    : stage === "different-account" ? fact({ fact: "wrong account for this device.", reason: "sign in with the account already open here." }, [signInVerb, signOutVerb])
    : stage === "sign-in-failed" ? fact({ fact: "couldn’t sign in." }, [signInVerb])
    : fact({ fact: "sign in to open your workspace." }, [signInVerb])
  }</main></div>;
}

