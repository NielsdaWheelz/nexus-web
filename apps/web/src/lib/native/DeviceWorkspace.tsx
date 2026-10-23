"use client";

// Installed entry: committed local state mounts independently of credential
// admission. Later bootstrap may refresh identity/profile, never live navigation.
import { useCallback, useEffect, useRef, useState } from "react";
import AuthenticatedShell from "@/app/(authenticated)/AuthenticatedShell";
import { AuthenticatedWorkspaceErrorBoundary } from "@/app/(authenticated)/AuthenticatedWorkspaceErrorBoundary";
import { FeedbackState } from "@/components/feedback/Feedback";
import type { RenderEnvironment } from "@/lib/renderEnvironment/types";
import { DeviceWorkspaceContext } from "./workspaceContext";
import type { DeviceStartup, SignInResult } from "./contracts";
import { useRemoteAdmission } from "./admissionHooks";
import { hello, readDeviceStartup, sessionCheck, sessionSignIn, sessionSignOut } from "./client";

type Binding = NonNullable<DeviceStartup["binding"]>;


export default function DeviceWorkspace({ renderEnvironment }: { renderEnvironment: RenderEnvironment }) {
  const [startup, setStartup] = useState<DeviceStartup | null | undefined>(undefined);
  const [failure, setFailure] = useState(false);
  const [signInResult, setSignInResult] = useState<SignInResult | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [cleanupFailed, setCleanupFailed] = useState(false);
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
      setFailure(false);
    } catch { if (live.current && request === reading.current) setFailure(true); }
  }, []);
  useEffect(() => {
    live.current = true;
    void read();
    void hello().catch(() => setFailure(true));
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
        <AuthenticatedShell
          account={{ accountId: binding.account.account_id, calendarTimeZone: binding.account.calendar_time_zone }}
          readerProfile={binding.reader_profile}
          renderEnvironment={renderEnvironment}
          initialState={initial.current}
          seeds={{}}
          entryFailure={null}
        />
      </AuthenticatedWorkspaceErrorBoundary>
    </DeviceWorkspaceContext>;
  }
  const signIn = () => {
    if (signingIn) return;
    setSigningIn(true);
    setSignInResult(null);
    void sessionSignIn().then(result => {
      setSignInResult(result);
      if (result === "Restored") void read();
    }, () => setSignInResult("Failed")).finally(() => setSigningIn(false));
  };
  const clearDevice = () => {
    if (signingIn || (!cleanupFailed && !window.confirm("sign out on this device?\n\nlocal downloads and the saved workspace will be removed. pending reading and listening progress will be lost."))) return;
    setSigningIn(true);
    void sessionSignOut().then(() => {
      setCleanupFailed(false);
      setSignInResult(null);
      void read();
    }, () => setCleanupFailed(true)).finally(() => setSigningIn(false));
  };
  const wrong = signInResult === "DifferentAccount";
  return <main><FeedbackState
    content={cleanupFailed ? { tone: "Warning", title: "sign out not completed", message: "local cleanup did not finish. retry to remove this device’s account data." }
      : failure ? { tone: "Danger", title: "saved workspace couldn’t be opened" }
      : startup === undefined ? { tone: "Neutral", title: "opening your workspace…" }
      : wrong ? { tone: "Warning", title: "use the account already open here", message: "sign out first to switch accounts." }
      : signInResult === "Failed" ? { tone: "Warning", title: "couldn’t connect", message: "connect to sign in on this device." }
      : { tone: "Neutral", title: "sign in to open your workspace", message: "connect to sign in on this device." }}
    announcement="Polite"
    actions={cleanupFailed ? [{ label: "retry sign out", busy: signingIn, onClick: clearDevice }]
      : failure ? [{ label: "retry", onClick: () => void read() }]
      : startup === undefined ? []
      : wrong ? [{ label: "retry", busy: signingIn, onClick: signIn }, { label: "cancel", onClick: () => setSignInResult(null) }, { label: "sign out on this device", busy: signingIn, onClick: clearDevice }]
      : [{ label: "sign in", busy: signingIn, onClick: signIn }]}
  /></main>;
}

