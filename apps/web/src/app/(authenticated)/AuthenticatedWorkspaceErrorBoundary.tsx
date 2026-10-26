"use client";

import { Component, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { FeedbackNotice, FeedbackState, type FeedbackActions } from "@/components/feedback/Feedback";
import { useOptionalAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { isStaleBuild, STALE_BUILD_FEEDBACK } from "@/lib/api/client";
import { getWritingRuntime, hasUncommittedWriting, writingStoreStopped } from "@/lib/notes/runtime";
import { useWorkGuard } from "@/lib/unsavedWork";
import { ClipboardWriteUnavailableError, copyText } from "@/lib/ui/copyText";
import styles from "./layout.module.css";

/**
 * The whole authenticated workspace's boundary: bootstrap and live workspace
 * defects, and a stale build's 426 (the update copy and a reload; not a
 * defect). Expected bootstrap transport failures are handled before this
 * boundary. #entry-failure is the notice return-focus target, shared with root
 * containment.
 */
export class AuthenticatedWorkspaceErrorBoundary extends Component<
  /** A boundary above the account provider names the account whose writing it guards. */
  { children: ReactNode; accountId?: string },
  { failed: boolean; stale: boolean }
> {
  state = { failed: false, stale: false };

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, stale: isStaleBuild(error) };
  }

  componentDidCatch(error: unknown): void {
    console.error("Authenticated workspace failed:", error);
  }

  render() {
    return this.state.failed ? <StoppedWorkspace stale={this.state.stale} accountId={this.props.accountId ?? null} /> : this.props.children;
  }
}

const LOSS = "some writing couldn’t be saved on this device and will be lost.\n\nleave anyway?";
const SAVE_FAILURE = { tone: "Danger" as const, title: "couldn’t save on this device", message: "keep this page open. retry saving." };
/** A stopped local store refuses every call; retrying is futile, so copy then restart. */
const STORE_STOPPED = { tone: "Danger" as const, title: "couldn’t save on this device",
  message: "the local notes store stopped. keep this page open and copy unfinished writing before restarting nexus." };
const noRuntime = () => () => {};
// A failed retry republishes its error into the runtime state this surface shows.
const retry = (runtime: { retry(): Promise<void> }) => ({ label: "retry saving", onClick: () => { void runtime.retry().catch(() => {}); } });

/** The account's guard retains visit input above this boundary. The writing runtime
 * separately retains uncommitted note edits; its guard, retry and export remain
 * necessary when AuthoredProvider unmounts. Their text exports may overlap. */
function StoppedWorkspace({ stale, accountId }: { stale: boolean; accountId: string | null }) {
  const guard = useWorkGuard();
  const owner = useOptionalAuthenticatedAccount()?.accountId ?? accountId;
  const runtime = owner === null ? null : getWritingRuntime(owner);
  const saveState = useSyncExternalStore(runtime?.subscribe ?? noRuntime, () => runtime?.snapshot() ?? null, () => null);
  const leaving = useRef(false);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (leaving.current || !hasUncommittedWriting()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    // A loss guard still mounted above may already have kept the document open.
    const exit = (event: Event) => { if (!event.defaultPrevented && hasUncommittedWriting() && !window.confirm(LOSS)) event.preventDefault(); };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("nexus:request-exit", exit);
    return () => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("nexus:request-exit", exit);
    };
  }, []);
  const reload = () => {
    if (hasUncommittedWriting() && !window.confirm(LOSS)) return;
    leaving.current = true;
    window.location.reload();
  };
  // An in-flight save is guarded above but is not yet a failure; only a failed one is shown.
  const failed = saveState !== null && saveState.error !== null;
  const [retained, setRetained] = useState("");
  const [manual, setManual] = useState(false);
  const [manualPending, setManualPending] = useState<string | null>(null);
  const pendingText = guard.readCopyText({scopes: [{kind: "account"}], ownerIds: []});
  const copyPending = () => {
    const text = guard.readCopyText({scopes: [{kind: "account"}], ownerIds: []});
    if (text === null) {setManualPending(null); return;}
    void copyText(text).then(() => setManualPending(null), (error: unknown) => {
      if (error instanceof ClipboardWriteUnavailableError) setManualPending(text); else reportError(error);
    });
  };
  const pendingAction = pendingText !== null ? {label: "copy pending outline text", onClick: copyPending} : null;
  const reloadAction = stale && STALE_BUILD_FEEDBACK.reload ? {label: "reload app", onClick: reload} : null;
  const failureActions: FeedbackActions | undefined = pendingAction && reloadAction ? [pendingAction, reloadAction]
    : pendingAction ? [pendingAction] : reloadAction ? [reloadAction] : undefined;
  useEffect(() => {
    if (!failed || runtime === null) return;
    let live = true;
    void runtime.uncommittedText().then(text => { if (live) setRetained(text); }, reportError);
    return () => { live = false; };
  }, [failed, runtime, saveState]);
  const copyable = failed ? retained : "";
  const stopped = failed && writingStoreStopped(saveState?.error);
  const saveActions = (owner: { retry(): Promise<void> }): FeedbackActions => {
    const copyAction = { label: "copy unsaved note edits", onClick: () => { void copy(); } };
    // the restart passes through the same loss confirmation as any other exit.
    const next = stopped ? { label: "restart nexus", onClick: reload } : retry(owner);
    return copyable === "" ? [next] : stopped ? [copyAction, next] : [next, copyAction];
  };
  const copy = () => copyText(copyable).then(() => setManual(false), (error: unknown) => {
    if (error instanceof ClipboardWriteUnavailableError) setManual(true); else reportError(error);
  });
  return (
    <main
      id="entry-failure"
      ref={(element) => {
        if (element && (document.activeElement === null || document.activeElement === document.body)) element.focus({ preventScroll: true });
      }}
      aria-label="workspace stopped"
      tabIndex={-1}
      className={styles.error}
    >
      <div role="alert">
        <FeedbackState
          content={stale ? { tone: STALE_BUILD_FEEDBACK.tone, title: STALE_BUILD_FEEDBACK.title, message: STALE_BUILD_FEEDBACK.message } : {
            tone: "Danger",
            title: "the workspace stopped unexpectedly",
            message: "nexus needs a fix before this can continue.",
          }}
          // The stale build's reload passes through the same loss check as any other exit.
          actions={failureActions}
          announcement="None"
        />
      </div>
      {failed && runtime !== null ? <FeedbackNotice content={stopped ? STORE_STOPPED : SAVE_FAILURE} announcement="Polite" actions={saveActions(runtime)} /> : null}
      {manual && copyable !== "" ? <>
        <p>copying is unavailable here. select the text and copy it.</p>
        <textarea className={styles.retained} readOnly value={copyable} aria-label="unsaved writing" />
      </> : null}
      {manualPending !== null ? <>
        <p>copying is unavailable here. select the text and copy it.</p>
        <textarea className={styles.retained} readOnly value={manualPending} aria-label="pending outline text" />
      </> : null}
    </main>
  );
}
