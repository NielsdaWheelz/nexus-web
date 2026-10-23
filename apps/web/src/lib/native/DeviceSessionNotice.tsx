"use client";
import { useEffect, useState } from "react";
import { useWorkspaceCondition } from "@/components/feedback/Feedback";
import { useRemoteAdmission } from "./admissionHooks";
import type { SignInResult } from "./contracts";
import { sessionCheck, sessionSignIn } from "./client";
/** One shared condition describes admission; pane bodies do not each invent a
 * session lifecycle. Required account/build recovery is an Action; checking and
 * connectivity are Status. The custom tab leaves every mounted work owner in place. */
export function DeviceSessionNotice() {
  const admission = useRemoteAdmission();
  const [result, setResult] = useState<SignInResult | null>(null);
  const [busy, setBusy] = useState(false);
  const signIn = () => {
    if (busy) return;
    setBusy(true);
    setResult(null);
    void sessionSignIn().then(setResult, () => setResult("Failed")).finally(() => setBusy(false));
  };
  useEffect(() => { if (admission === "Ready") setResult(null); }, [admission]);
  const wrong = result === "DifferentAccount";
  const content = wrong ? { tone: "Warning" as const, title: "use the account already open here", message: "sign out first to switch accounts." }
    : admission === "Checking" ? { tone: "Neutral" as const, title: "connecting…" }
    : admission === "SignInRequired" ? { tone: "Warning" as const, title: "sign in to reconnect", message: "your open work stays here while you sign in." }
    : admission === "UpdateRequired" ? { tone: "Warning" as const, title: "update nexus to reconnect", message: "install the current nexus apk, then reopen the app." }
    : admission === "Unavailable" || result === "Failed" ? { tone: "Warning" as const, title: "couldn’t connect", message: "your workspace is still open." } : null;
  useWorkspaceCondition("device-session", content ? {
    priority: wrong || admission === "SignInRequired" || admission === "UpdateRequired" ? "Action" : "Status",
    content, announcement: "Polite",
    actions: wrong ? [{ label: "retry", busy, onClick: signIn }, { label: "cancel", onClick: () => setResult(null) }]
      : admission === "SignInRequired" ? [{ label: "sign in", busy, onClick: signIn }]
      : admission === "Unavailable" || result === "Failed" ? [{ label: "try again", onClick: () => { setResult(null); void sessionCheck().catch(() => setResult("Failed")); } }] : undefined,
  } : null);
  return null;
}
