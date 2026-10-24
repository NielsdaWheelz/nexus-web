"use client";

// Installed entry: committed local state mounts independently of credential
// admission. Later bootstrap may refresh identity/profile, never live navigation.
import { useCallback, useEffect, useRef, useState } from "react";
import { CatalogProvider } from "@/lib/catalog/provider";
import AuthenticatedShell from "@/app/(authenticated)/AuthenticatedShell";
import styles from "@/app/(authenticated)/layout.module.css";
import { AuthenticatedWorkspaceErrorBoundary } from "@/app/(authenticated)/AuthenticatedWorkspaceErrorBoundary";
import Button from "@/components/ui/Button";
import { isApiError, STALE_BUILD_FEEDBACK } from "@/lib/api/client";
import { FeedbackState } from "@/components/feedback/Feedback";
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
    } catch (error) { if (live.current && request === reading.current) setFailure({ error }); }
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
      <AuthenticatedWorkspaceErrorBoundary>
        <CatalogProvider key={binding.account.account_id} accountId={binding.account.account_id}><AuthenticatedShell
          account={{ accountId: binding.account.account_id, calendarTimeZone: binding.account.calendar_time_zone }}
          readerProfile={binding.reader_profile}
          renderEnvironment={renderEnvironment}
          initialState={initial.current}
          seeds={{}}
          entryFailure={null}
        /></CatalogProvider>
      </AuthenticatedWorkspaceErrorBoundary>
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
  const cleanupError = startupCleanup ?? (isApiError(cleanupFailure?.error) ? cleanupFailure.error : null);
  // These are distinct recovery steps, not updates to one published action.
  const stage = startupCleanup !== null ? "startup-cleanup"
    : cleanupFailure !== null ? "signout-cleanup"
    : catalogRecovery ? "catalog-recovery"
    : failure ? "snapshot-failed"
    : admission === "UpdateRequired" ? "update-required"
    : startup === undefined ? "opening"
    : wrong ? "different-account"
    : signInResult === "Failed" ? "sign-in-failed" : "sign-in";
  return <div style={{ height: "100%", overflowY: "auto" }}><main className={styles.error}><FeedbackState key={stage}
    content={stage === "startup-cleanup" || stage === "signout-cleanup" ? { tone: "Warning", title: "sign out not completed", message: cleanupError?.message ?? "local cleanup did not finish. retry to remove this device’s account data." }
      : stage === "catalog-recovery" ? { tone: "Warning", title: "saved catalog couldn’t be opened", message: "sign out on this device to remove its saved account data, then sign in again." }
      : stage === "snapshot-failed" ? { tone: "Danger", title: "saved workspace couldn’t be opened" }
      : stage === "update-required" ? STALE_BUILD_FEEDBACK
      : stage === "opening" ? { tone: "Neutral", title: "opening your workspace…" }
      : stage === "different-account" ? { tone: "Warning", title: "use the account already open here", message: "sign out first to switch accounts." }
      : stage === "sign-in-failed" ? { tone: "Warning", title: "couldn’t connect", message: "connect to sign in on this device." }
      : { tone: "Neutral", title: "sign in to open your workspace", message: "connect to sign in on this device." }}
    announcement="Polite"
    actions={stage === "startup-cleanup" ? [{ label: "retry cleanup", onClick: () => void read() }]
      : stage === "signout-cleanup" ? [{ label: "retry sign out", busy: signingIn, onClick: clearDevice }]
      : stage === "snapshot-failed" ? [{ label: "retry", onClick: () => void read() }]
      : stage === "update-required" || stage === "opening" || stage === "catalog-recovery" ? undefined
      : stage === "different-account" ? [{ label: "retry", busy: signingIn, onClick: signIn }, { label: "cancel", onClick: () => setSignInResult(null) }]
      : [{ label: "sign in", busy: signingIn, onClick: signIn }]}
  />
    {wrong || catalogRecovery ? <Button tone="danger" aria-busy={signingIn || undefined} onClick={clearDevice}>sign out on this device</Button> : null}
  </main></div>;
}

