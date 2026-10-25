"use client";

import { Component, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { FeedbackNotice, FeedbackState } from "@/components/feedback/Feedback";
import { useOptionalAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { isStaleBuild, STALE_BUILD_FEEDBACK } from "@/lib/api/client";
import { getWritingRuntime, hasUncommittedWriting } from "@/lib/notes/runtime";
import styles from "./layout.module.css";

/**
 * The whole authenticated workspace's boundary: bootstrap and live workspace
 * defects, and a stale build's 426 (the update copy and a reload; not a
 * defect). Expected bootstrap transport failures are handled before this
 * boundary. #entry-failure is the notice return-focus target, shared with root
 * containment.
 */
export class AuthenticatedWorkspaceErrorBoundary extends Component<
  { children: ReactNode },
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
    return this.state.failed ? <StoppedWorkspace stale={this.state.stale} /> : this.props.children;
  }
}

const LOSS = "some writing couldn’t be saved on this device and will be lost.\n\nleave anyway?";
const SAVE_FAILURE = { tone: "Danger" as const, title: "couldn’t save on this device", message: "keep this page open. retry saving." };
const noRuntime = () => () => {};

/** Stopping the workspace unmounts its editors and possibly their loss guard; the
 * writing runtime still holds any uncommitted words. This surface keeps guarding exit
 * and reload while they remain, and retries through the runtime when this account
 * owns them. It adds no recovery of its own. */
function StoppedWorkspace({ stale }: { stale: boolean }) {
  const account = useOptionalAuthenticatedAccount();
  const runtime = account === null ? null : getWritingRuntime(account.accountId);
  const saveState = useSyncExternalStore(runtime?.subscribe ?? noRuntime, () => runtime?.snapshot() ?? null, () => null);
  const leaving = useRef(false);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (leaving.current || !hasUncommittedWriting()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const exit = (event: Event) => { if (hasUncommittedWriting() && !window.confirm(LOSS)) event.preventDefault(); };
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
          actions={stale && STALE_BUILD_FEEDBACK.reload ? [{ label: "reload app", onClick: reload }] : undefined}
          announcement="None"
        />
      </div>
      {failed && runtime !== null ? <FeedbackNotice content={SAVE_FAILURE} announcement="Polite"
        // A failed retry republishes its error into the runtime state shown here.
        actions={[{ label: "retry saving", onClick: () => { void runtime.retry().catch(() => {}); } }]} /> : null}
    </main>
  );
}
