"use client";
/** Saved browsing metadata and listening reads retain failures at downloads,
 * their local-data surface. Remote authored admission belongs to account sync. */
import { useState } from "react";
import { FeedbackFailure, useFeedbackOccurrence } from "@/components/feedback/Feedback";
import { useCatalogState } from "@/lib/catalog/provider";
import { retryListeningRead, useListening } from "@/lib/consumption/listening";
import { useRemoteAdmission } from "./admissionHooks";
export function DeviceCatalogStatus() {
  const catalog = useCatalogState();
  const admission = useRemoteAdmission();
  const failed = catalog.error !== null || catalog.status?.last_error != null;
  const occurrence = useFeedbackOccurrence(failed || catalog.accepting || catalog.status?.refreshing === true);
  if (!failed) return null;
  return <FeedbackFailure scope="Local" occurrence={occurrence} announcement="Polite" content={{ tone: "Warning", title: "couldn’t update the saved catalog", message: catalog.data === null ? "connect to save your lists for offline browsing." : "the earlier saved catalog remains available on this device." }} actions={[{ label: "retry", busy: catalog.accepting || catalog.status?.refreshing === true, disabledReason: admission === "Ready" ? undefined : "connect before retrying", onClick: () => { if (admission === "Ready") void catalog.refresh(); } }]} />;
}
export function DeviceListeningStatus() {
  const listening = useListening();
  const [busy, setBusy] = useState(false);
  const occurrence = useFeedbackOccurrence(listening.error !== null || busy);
  if (listening.error === null) return null;
  return <FeedbackFailure scope="Local" occurrence={occurrence} announcement="Polite" content={{ tone: "Warning", title: "listening progress couldn’t be read", message: listening.facts !== null ? "earlier listening progress remains visible. lists may be out of date." : "retry reading listening progress on this device." }} actions={[{ label: "retry", busy, onClick: () => { setBusy(true); void retryListeningRead().finally(() => setBusy(false)); } }]} />;
}
