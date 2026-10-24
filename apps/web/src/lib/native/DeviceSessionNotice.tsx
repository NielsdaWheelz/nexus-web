"use client";
import { useEffect, useState } from "react";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { useCatalogState } from "@/lib/catalog/provider";
import { formatDisplayDate } from "@/lib/display/format";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { useWorkspaceCondition } from "@/components/feedback/Feedback";
import { useRemoteAdmission } from "./admissionHooks";
import type { SignInResult } from "./contracts";
import { sessionCheck, sessionSignIn } from "./client";
/** One shared condition describes admission; pane bodies do not each invent a
 * session lifecycle. Required account/build recovery is an Action; checking and
 * connectivity are Status. Connection and catalog episodes remain attention
 * through their own retries until clean settlement. The custom tab keeps work owners. */
export function DeviceSessionNotice() {
  const admission = useRemoteAdmission();
  const catalog = useCatalogState();
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
    : catalogFailure ? { tone: "Warning" as const, title: "couldn’t update catalog", message: saved ?? "connect to save your lists for offline browsing." }
    : catalog.loading ? { tone: "Neutral" as const, title: "opening saved catalog…" }
    : admission !== "Ready" ? { tone: "Neutral" as const, title: saved === null ? "catalog not ready on this device" : `offline · ${saved}`, message: saved === null ? "connect to save your lists for offline browsing." : undefined }
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
  const content = needsRecovery && sessionContent !== null
    ? { ...sessionContent, message: ["message" in sessionContent ? sessionContent.message : null, saved].filter(Boolean).join(" ") }
    : catalogContent ?? sessionContent;
  useWorkspaceCondition("device-session", content ? {
    needsAttention: connectionAttention || catalogAttention,
    priority: wrong || admission === "SignInRequired" || admission === "UpdateRequired" ? "Action" : "Status",
    content, announcement: "Polite",
    actions: wrong ? [{ label: "retry", busy, onClick: signIn }, { label: "cancel", onClick: () => setResult(null) }]
      : admission === "SignInRequired" ? [{ label: "sign in", busy, onClick: signIn }]
      : admission === "Unavailable" || result === "Failed" || connectionChecking ? [{ label: "try again", busy: busy || connectionChecking, onClick: () => {
        if (busy || connectionChecking) return;
        setBusy(true); setConnectionEpisode(true); setResult(null);
        void sessionCheck().catch(() => setResult("Failed")).finally(() => setBusy(false));
      } }]
      : catalogAttention && admission === "Ready" ? [{ label: "retry", busy: catalogRefreshing || catalog.loading,
        onClick: () => { if (!catalogRefreshing && !catalog.loading) void catalog.refresh(); } }] : undefined,
  } : null);
  return null;
}
