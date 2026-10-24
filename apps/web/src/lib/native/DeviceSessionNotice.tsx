"use client";
import { useEffect, useState } from "react";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { useCatalogState } from "@/lib/catalog/provider";
import { retryListeningRead, useListening } from "@/lib/consumption/listening";
import { formatDisplayDate } from "@/lib/display/format";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { useWorkspaceCondition } from "@/components/feedback/Feedback";
import { useRemoteAdmission } from "./admissionHooks";
import type { SignInResult } from "./contracts";
import { sessionCheck, sessionSignIn } from "./client";
/** One shared condition describes admission; pane bodies do not each invent a
 * session lifecycle. Required account/build recovery is an Action; checking and
 * connectivity are Status. The custom tab leaves every mounted work owner in place. */
export function DeviceSessionNotice() {
  const admission = useRemoteAdmission();
  const catalog = useCatalogState();
  const listening = useListening();
  const [readingListening, setReadingListening] = useState(false);
  const { calendarTimeZone } = useAuthenticatedAccount();
  const environment = useRenderEnvironment();
  const snapshot = catalog.status?.snapshot ?? (catalog.data === null ? null : catalog.data.value);
  const savedAt = snapshot === null ? null : formatDisplayDate(snapshot.captured_at,
    { displayLocale: environment.displayLocale, displayTimeZone: calendarTimeZone }, { dateStyle: "medium", timeStyle: "short" });
  const saved = savedAt === null ? null : `catalog saved ${savedAt}`;
  const catalogFailure = catalog.error !== null || catalog.status?.last_error != null;
  const catalogContent = catalog.accepting || catalog.status?.refreshing
    ? { tone: "Neutral" as const, title: saved === null ? "saving your catalog…" : "updating catalog…", message: saved ?? undefined }
    : catalogFailure ? { tone: "Warning" as const, title: "couldn’t update catalog", message: saved ?? "connect to save your lists for offline browsing." }
    : catalog.loading ? { tone: "Neutral" as const, title: "opening saved catalog…" }
    : admission !== "Ready" ? { tone: "Neutral" as const, title: saved === null ? "catalog not ready on this device" : `offline · ${saved}`, message: saved === null ? "connect to save your lists for offline browsing." : undefined }
    : null;
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
  const sessionContent = wrong ? { tone: "Warning" as const, title: "use the account already open here", message: "sign out first to switch accounts." }
    : admission === "Checking" ? { tone: "Neutral" as const, title: "connecting…" }
    : admission === "SignInRequired" ? { tone: "Warning" as const, title: "sign in to reconnect", message: "your open work stays here while you sign in." }
    : admission === "UpdateRequired" ? { tone: "Warning" as const, title: "update nexus to reconnect", message: "install the current nexus apk, then reopen the app." }
    : admission === "Unavailable" || result === "Failed" ? { tone: "Warning" as const, title: "couldn’t connect", message: "your workspace is still open." } : null;
  const needsRecovery = wrong || admission === "SignInRequired" || admission === "UpdateRequired";
  const content = needsRecovery && sessionContent !== null
    ? { ...sessionContent, message: ["message" in sessionContent ? sessionContent.message : null, saved].filter(Boolean).join(" ") }
    : catalogContent ?? sessionContent;
  useWorkspaceCondition("device-session", content ? {
    priority: wrong || admission === "SignInRequired" || admission === "UpdateRequired" ? "Action" : "Status",
    content, announcement: "Polite",
    actions: wrong ? [{ label: "retry", busy, onClick: signIn }, { label: "cancel", onClick: () => setResult(null) }]
      : admission === "SignInRequired" ? [{ label: "sign in", busy, onClick: signIn }]
      : admission === "Unavailable" || result === "Failed" ? [{ label: "try again", onClick: () => { setResult(null); void sessionCheck().catch(() => setResult("Failed")); } }]
      : catalogFailure && admission === "Ready" ? [{ label: "retry", onClick: () => void catalog.refresh(), busy: catalog.accepting || catalog.status?.refreshing }] : undefined,
  } : null);
  useWorkspaceCondition("device-listening", listening.error === null ? null : {
    priority: "Action",
    content: { tone: "Warning", title: "listening progress couldn’t be read",
      message: "saved progress has been kept. lists may be out of date." },
    announcement: "Polite",
    actions: [{ label: "retry", busy: readingListening, onClick: () => {
      setReadingListening(true);
      void retryListeningRead().finally(() => setReadingListening(false));
    } }],
  });
  return null;
}
