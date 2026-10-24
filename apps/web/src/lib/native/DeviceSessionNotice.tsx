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
/** Admission, catalog and listening conditions own independent recovery controls.
 * Account/build and listening recovery are Actions; connectivity/catalog are Status.
 * Each episode remains attention through its own retry until clean settlement,
 * including overlapping session checks. The custom tab keeps work owners. */
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
  const catalogRefreshing = catalog.accepting || catalog.status?.refreshing === true;
  const [catalogEpisode, setCatalogEpisode] = useState(false);
  const catalogAttention = catalogFailure || catalogEpisode && (catalogRefreshing || catalog.loading || catalog.status === null);
  if (catalogEpisode !== catalogAttention) setCatalogEpisode(catalogAttention);
  const catalogContent = catalogRefreshing
    ? { tone: "Neutral" as const, title: saved === null ? "saving your catalog…" : "updating catalog…", message: saved ?? undefined }
    : catalogAttention ? { tone: "Warning" as const, title: "couldn’t update catalog", message: saved ?? "connect to save your lists for offline browsing." }
    : catalog.loading ? { tone: "Neutral" as const, title: "opening saved catalog…" }
    : null;
  const [result, setResult] = useState<SignInResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [connectionEpisode, setConnectionEpisode] = useState(false);
  const signIn = () => {
    if (busy) return;
    setBusy(true);
    setConnectionEpisode(true);
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
  const connectionFailure = needsRecovery || admission === "Unavailable" || result === "Failed";
  const connectionAttention = connectionFailure || connectionEpisode && (admission === "Checking" || busy);
  const connectionChecking = connectionAttention && admission === "Checking";
  // Publish episode continuity before layout registration can observe a retry.
  if (connectionEpisode !== connectionAttention) setConnectionEpisode(connectionAttention);
  const content = sessionContent !== null
    ? { ...sessionContent, message: ["message" in sessionContent ? sessionContent.message : null, saved].filter(Boolean).join(" ") }
    : null;
  useWorkspaceCondition("device-session", content ? {
    needsAttention: connectionAttention,
    priority: wrong || admission === "SignInRequired" || admission === "UpdateRequired" ? "Action" : "Status",
    content, announcement: "Polite",
    actions: wrong ? [{ label: "retry", busy, onClick: signIn }, { label: "cancel", onClick: () => setResult(null) }]
      : admission === "SignInRequired" ? [{ label: "sign in", busy, onClick: signIn }]
      : admission === "Unavailable" || result === "Failed" || connectionChecking ? [{ label: "try again", busy: busy || connectionChecking, onClick: () => {
        if (busy || connectionChecking) return;
        setBusy(true); setConnectionEpisode(true); setResult(null);
        void sessionCheck().catch(() => setResult("Failed")).finally(() => setBusy(false));
      } }] : undefined,
  } : null);
  useWorkspaceCondition("device-catalog", catalogContent ? {
    needsAttention: catalogAttention,
    priority: "Status",
    content: catalogContent, announcement: "Polite",
    actions: catalogAttention ? [{ label: "retry", busy: catalogRefreshing || catalog.loading,
      disabledReason: admission === "Ready" ? undefined : "connect before retrying",
      onClick: () => { if (admission === "Ready" && !catalogRefreshing && !catalog.loading) void catalog.refresh(); } }] : undefined,
  } : null);
  useWorkspaceCondition("device-listening", listening.error === null ? null : {
    needsAttention: true,
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
