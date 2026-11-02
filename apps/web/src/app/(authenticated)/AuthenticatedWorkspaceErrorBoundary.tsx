"use client";

import { Component, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Fact } from "@/components/feedback/Fact";
import type { Verb, Verbs } from "@/components/feedback/stage";
import { useOptionalAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { isStaleBuild } from "@/lib/api/client";
import { staleBuild } from "@/lib/api/failure";
import { subscribeAdmission, updateRemedy } from "@/lib/native/admission";
import { getWritingRuntime, hasUncommittedWriting, writingStoreStopped } from "@/lib/notes/runtime";
import { useWorkGuard } from "@/lib/unsavedWork";
import { ClipboardWriteUnavailableError, copyText } from "@/lib/ui/copyText";
import styles from "./layout.module.css";

/**
 * The whole authenticated workspace's boundary: bootstrap and live workspace
 * defects, and a stale build's 426 (the update line and, where it can work, a
 * reload; not a defect). Expected bootstrap transport failures are handled before
 * this boundary. #entry-failure is the return-focus target, shared with root
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
const noRuntime = () => () => {};
const two = (first: Verb | null, second: Verb | null): Verbs | undefined =>
  first && second ? [first, second] : first ? [first] : second ? [second] : undefined;

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
  // A stale build reloads only where reload can replace it; a defect's reload starts afresh.
  const remedy = useSyncExternalStore(subscribeAdmission, updateRemedy, updateRemedy);
  const reloadVerb: Verb | null = !stale || remedy === "Reload" ? { label: "reload", commandKey: "Reload", run: reload } : null;
  const draftsVerb: Verb | null = pendingText !== null ? { label: "copy drafts", commandKey: "CopyDrafts", run: copyPending } : null;
  useEffect(() => {
    if (!failed || runtime === null) return;
    let live = true;
    void runtime.uncommittedText().then(text => { if (live) setRetained(text); }, reportError);
    return () => { live = false; };
  }, [failed, runtime, saveState]);
  const copyable = failed ? retained : "";
  const stopped = failed && writingStoreStopped(saveState?.error);
  const editsVerb: Verb | null = copyable === "" ? null : { label: "copy note edits", commandKey: "CopyNoteEdits", run: () => { void copy(); } };
  // A stopped store refuses every call, so it copies then restarts, through the same loss
  // confirmation as any other exit. A failed retry republishes its error into the runtime.
  const saveVerbs = (owner: { retry(): Promise<void> }) => stopped
    ? two(editsVerb, { label: "restart nexus", commandKey: "Restart", run: reload })
    : two({ label: "retry", commandKey: "RetrySaving", run: () => { void owner.retry().catch(() => {}); } }, editsVerb);
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
      <Fact line={{ fact: stale ? staleBuild() : "the workspace stopped unexpectedly." }} verbs={two(draftsVerb, reloadVerb)} speak />
      {failed && runtime !== null ? <Fact line={{ fact: stopped ? "local notes stopped." : "some note edits aren’t saved yet." }} verbs={saveVerbs(runtime)} speak /> : null}
      {manual && copyable !== "" ? <>
        <Fact line={{ fact: "copying isn’t available here.", reason: "select the text and copy it." }} />
        <textarea className={styles.retained} readOnly value={copyable} aria-label="unsaved note edits" />
      </> : null}
      {manualPending !== null ? <>
        <Fact line={{ fact: "copying isn’t available here.", reason: "select the text and copy it." }} />
        <textarea className={styles.retained} readOnly value={manualPending} aria-label="drafts" />
      </> : null}
    </main>
  );
}
