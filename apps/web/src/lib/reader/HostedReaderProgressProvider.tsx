"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import FeatureErrorBoundary from "@/components/feedback/FeatureErrorBoundary";
import Button from "@/components/ui/Button";
import { useWorkspaceStore } from "@/lib/workspace/store";
import { HostedReaderProgressRuntime, type ReaderRecoveryNotice } from "./hostedReaderProgress";
import styles from "./HostedReaderProgressProvider.module.css";

const RuntimeContext = createContext<HostedReaderProgressRuntime | null>(null);

function RecoveryNotice({ notice, runtime }: {
  notice: ReaderRecoveryNotice; runtime: HostedReaderProgressRuntime;
}) {
  const workspace = useWorkspaceStore();
  const [busy, setBusy] = useState(false);
  const [defect, setDefect] = useState<unknown>(null);
  if (defect !== null) throw defect;
  if (notice?.kind === "Defect") throw notice.error;
  if (notice === null) return null;
  if (notice.kind === "Pending") return <FeedbackNotice
    announcement="Polite"
    content={{ tone: "Warning", title: "A reading position is saved on this device; sync is pending." }}
    actions={[{ label: "Retry syncing", onClick: () => runtime.recover() }]}
  />;
  const { row, view } = notice;
  const conflict = view.kind === "Conflict";
  const resolve = (choice: "Canonical" | "Device") => {
    if (busy) return;
    setBusy(true);
    const operation = view.kind === "Conflict"
      ? runtime.resolve(row, view.canonical, choice)
      : runtime.discardUnavailable(row);
    void operation.catch(setDefect).finally(() => setBusy(false));
  };
  return <FeedbackNotice announcement="Polite" content={{
    tone: "Warning",
    title: conflict ? "Two reading views saved different positions."
      : view.kind === "SourceUnavailable" ? "An item with a saved reading position is unavailable."
        : "A saved reading position belongs to different or unknown content.",
    message: busy ? "Updating the saved position…" : "This saved position remains on your device until you choose.",
  }} actions={conflict ? [
    { label: "Use synced position", onClick: () => resolve("Canonical") },
    { label: "Keep this saved position", onClick: () => resolve("Device") },
  ] : [{ label: "Discard this saved position", onClick: () => resolve("Canonical") }]}>
    <Button onClick={() => workspace.activateWorkspaceTarget({
      originPaneId: workspace.state.activePrimaryPaneId,
      target: { href: `/media/${row.mediaId}` },
      disposition: { kind: "Follow" }, modality: "Pointer",
    })}>Open this item</Button>
  </FeedbackNotice>;
}

export function HostedReaderProgressProvider({ accountId, children }: {
  accountId: string; children: ReactNode;
}) {
  const [session, setSession] = useState<{ accountId: string; runtime: HostedReaderProgressRuntime } | null>(null);
  const [notice, setNotice] = useState<ReaderRecoveryNotice>(null);
  useEffect(() => {
    let active = true;
    const runtime = new HostedReaderProgressRuntime(accountId, (next) => { if (active) setNotice(next); });
    setNotice(null);
    setSession({ accountId, runtime });
    runtime.recover();
    const recover = () => runtime.recover();
    window.addEventListener("online", recover);
    window.addEventListener("pageshow", recover);
    return () => {
      active = false;
      runtime.close();
      window.removeEventListener("online", recover);
      window.removeEventListener("pageshow", recover);
    };
  }, [accountId]);
  const runtime = session?.accountId === accountId ? session.runtime : null;
  const retry = useCallback(() => { setNotice(null); runtime?.recover(); }, [runtime]);
  return <RuntimeContext.Provider value={runtime}>
    {runtime !== null && <div className={styles.recovery}>
      <FeatureErrorBoundary scope="ReaderProgress" onRetry={retry} fallback={(retryRecovery) => <FeedbackNotice
        announcement="Polite"
        content={{ tone: "Warning", title: "Reading position recovery couldn’t continue.", message: "Stored positions remain pending. Your other panes are available." }}
        actions={[{ label: "Retry recovery", onClick: retryRecovery }]}
      />}>
        <RecoveryNotice key={notice?.kind === "Review" ? `${notice.row.writerId}:${notice.row.desired.sequence}` : notice?.kind ?? "none"} notice={notice} runtime={runtime} />
      </FeatureErrorBoundary>
    </div>}
    {children}
  </RuntimeContext.Provider>;
}

export function useHostedReaderProgressRuntime(): HostedReaderProgressRuntime | null {
  return useContext(RuntimeContext);
}
