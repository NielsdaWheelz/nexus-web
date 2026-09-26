"use client";

import { useRef } from "react";
import HighlightNoteEditor from "@/components/notes/HighlightNoteEditor";
import Button from "@/components/ui/Button";
import FloatingActionSurface from "@/components/ui/FloatingActionSurface";
import MobileSheet from "@/components/ui/MobileSheet";
import type { HighlightLinkedNoteBlock } from "@/lib/highlights/highlightContract";
import type { MountedEditorMutationLease } from "@/lib/actions/mountedActionHandoff";
import type { WorkspaceTargetDisposition } from "@/lib/workspace/targetActivation";
import { useInitialFocus } from "@/lib/ui/useInitialFocus";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useHistoryDismiss } from "@/lib/ui/useHistoryDismiss";
import { useContainingModalLayer, useIsModalLayerTopmost } from "@/lib/ui/useModalLayer";
import styles from "./HighlightQuickNoteComposer.module.css";

export type QuickNoteSession =
  | {
      kind: "pending-create";
      sessionId: string; // stable opaque editor key for the session's whole life
      ownerKey: string; // full selection anchor, stable across dismiss/reopen
      quote: string; // selection text at verb time
      anchorRect: DOMRect; // selection rect snapshot
      creation: Promise<{ id: string } | null>; // the in-flight highlight create
    }
  | {
      kind: "existing";
      highlightId: string;
      recoveryOwnerKey?: string; // exact anchor of a uniquely matched pending creation
      note: HighlightLinkedNoteBlock | null; // first linked note, or null
      quote: string; // highlight.exact
      anchorRect: DOMRect;
    };

/**
 * The post-create annotation surface (docs/cutovers/highlight-quick-note-
 * composer-hard-cutover.md): hosts the existing {@link HighlightNoteEditor} as
 * a selection-anchored popover on desktop and a quote-headed {@link MobileSheet}
 * on mobile. Owns skin choice, focus into the editor on open, and the
 * pending-create → real-id handoff. the editor's shared writing session owns
 * the body and save queue even after this popover unmounts.
 */
export default function HighlightQuickNoteComposer({
  session,
  onClose,
  onSavedNote,
  onDetachedNote,
  onOpenLink,
  onEditAccepted,
  onMutationStarted,
}: {
  session: QuickNoteSession | null; // null = closed (component stays mounted)
  onClose: () => void;
  onSavedNote: (highlightId: string, note: HighlightLinkedNoteBlock) => void;
  onDetachedNote: (highlightId: string, noteBlockId: string) => void;
  onOpenLink: (href: string, disposition: WorkspaceTargetDisposition) => void;
  onEditAccepted?: (noteRef: string, hasPending: () => boolean) => void;
  onMutationStarted?: (noteRef: string) => MountedEditorMutationLease | null;
}) {
  const isMobile = useIsMobileViewport();
  const desktopPanelRef = useRef<HTMLDivElement>(null);
  const editorId = session === null ? null : editorHighlightId(session);
  const modalLayer = useContainingModalLayer();
  const modalIsTopmost = useIsModalLayerTopmost(modalLayer);

  // Keep the selection popup's history entry through the editor handoff.
  // Popping it here would let browser traversal reset the new editor's focus.
  useHistoryDismiss(editorId !== null && !isMobile, onClose, {
    isTopmost: modalIsTopmost,
  });

  // Desktop focus-on-open (next-frame, after FloatingActionSurface positions
  // itself); the mobile skin focuses via the sheet's initialFocus.
  useInitialFocus(desktopPanelRef, editorId !== null && !isMobile, {
    enabled: modalIsTopmost,
    select: selectEditorTextbox,
    key: editorId,
  });

  const editor =
    session === null ? null : (
      <HighlightNoteEditor
        key={editorHighlightId(session)}
        target={session.kind === "pending-create"
          ? { kind: "highlight", id: null, ownerKey: session.ownerKey, creation: session.creation }
          : { kind: "highlight", id: session.highlightId, ownerKey: `highlight:${session.highlightId}`, recoveryOwnerKey: session.recoveryOwnerKey }}
        note={session.kind === "existing" ? session.note : null}
        editable
        onSaved={onSavedNote}
        onDetached={onDetachedNote}
        onOpenLink={onOpenLink}
        onEditAccepted={onEditAccepted}
        onMutationStarted={onMutationStarted}
      />
    );

  return (
    <>
      {session !== null && !isMobile && (
        <FloatingActionSurface
          open
          anchor={session.anchorRect}
          placement="below"
          flip
          scrollBehavior="reposition"
          role="dialog"
          label="Add note to highlight"
          onDismiss={onClose}
        >
          <div ref={desktopPanelRef} className={styles.panel}>
            {session.quote ? <div className={styles.quote}>{session.quote}</div> : null}
            {editor}
            <div className={styles.actions}>
              <Button size="sm" variant="ghost" onClick={onClose}>Done</Button>
            </div>
          </div>
        </FloatingActionSurface>
      )}
      {/* Mount contract: always rendered, driven by `active`. */}
      <MobileSheet
        active={session !== null && isMobile}
        onDismiss={onClose}
        ariaLabel="Add note to highlight"
        layer="modal"
        scrim="soft"
        initialFocus={selectEditorTextbox}
        focusKey={editorId}
      >
        {session === null ? null : (
          <div className={styles.sheetContent}>
            {session.quote ? <div className={styles.quote}>{session.quote}</div> : null}
            {editor}
            <div className={styles.actions}>
              <Button size="sm" variant="ghost" onClick={onClose}>Done</Button>
            </div>
          </div>
        )}
      </MobileSheet>
    </>
  );
}

function editorHighlightId(session: QuickNoteSession): string {
  return session.kind === "pending-create" ? session.sessionId : session.highlightId;
}

function selectEditorTextbox(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[role="textbox"]');
}
