"use client";

import { useRef } from "react";
import HighlightNoteEditor from "@/components/notes/HighlightNoteEditor";
import FloatingActionSurface from "@/components/ui/FloatingActionSurface";
import MobileSheet from "@/components/ui/MobileSheet";
import type { HighlightLinkedNoteBlock } from "@/lib/highlights/api";
import { useInitialFocus } from "@/lib/ui/useInitialFocus";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import styles from "./HighlightQuickNoteComposer.module.css";

export type QuickNoteSession =
  | {
      kind: "pending-create";
      sessionId: string; // stable opaque editor key for the session's whole life
      quote: string; // selection text at verb time
      anchorRect: DOMRect; // selection rect snapshot
      creation: Promise<{ id: string } | null>; // the in-flight highlight create
    }
  | {
      kind: "existing";
      highlightId: string;
      note: HighlightLinkedNoteBlock | null; // first linked note, or null
      quote: string; // highlight.exact
      anchorRect: DOMRect;
    };

/**
 * The post-create annotation surface (docs/cutovers/highlight-quick-note-
 * composer-hard-cutover.md): hosts the existing {@link HighlightNoteEditor} as
 * a selection-anchored popover on desktop and a quote-headed {@link MobileSheet}
 * on mobile. Owns skin choice, focus into the editor on open, and the
 * pending-create → real-id save bridging; persistence semantics (debounced
 * autosave, drafts, flush on blur/unmount) stay in the editor and the
 * onSaveNote/onDeleteNote handlers, so dismissal saves and never discards.
 *
 * The editor's `highlightId` prop is an opaque key: for pending-create
 * sessions it stays the sessionId even after the create resolves (re-keying
 * mid-session would cancel in-flight saves and orphan the draft); the wrapped
 * onSave substitutes the real highlight id.
 */
export default function HighlightQuickNoteComposer({
  session,
  onClose,
  onSaveNote,
  onDeleteNote,
  onOpenLink,
}: {
  session: QuickNoteSession | null; // null = closed (component stays mounted)
  onClose: () => void;
  onSaveNote: (
    highlightId: string,
    noteBlockId: string | null,
    createBlockId: string,
    bodyPmJson: Record<string, unknown>
  ) => Promise<HighlightLinkedNoteBlock>;
  onDeleteNote: (noteBlockId: string, shouldApply: () => boolean) => Promise<void>;
  onOpenLink: (href: string, options: { newPane: boolean }) => void;
}) {
  const isMobile = useIsMobileViewport();
  const desktopPanelRef = useRef<HTMLDivElement>(null);
  const editorId = session === null ? null : editorHighlightId(session);

  // Desktop focus-on-open (next-frame, after FloatingActionSurface positions
  // itself); the mobile skin focuses via the sheet's initialFocus.
  useInitialFocus(desktopPanelRef, editorId !== null && !isMobile, {
    select: selectEditorTextbox,
    key: editorId,
  });

  const editor =
    session === null ? null : (
      <HighlightNoteEditor
        key={editorHighlightId(session)}
        highlightId={editorHighlightId(session)}
        note={session.kind === "existing" ? session.note : null}
        editable
        onSave={
          session.kind === "pending-create"
            ? async (_sessionId, noteBlockId, createBlockId, bodyPmJson) => {
                const resolved = await session.creation; // memoizes its own resolution
                if (!resolved) throw new Error("Highlight was not created");
                return onSaveNote(resolved.id, noteBlockId, createBlockId, bodyPmJson);
              }
            : onSaveNote
        }
        onDelete={onDeleteNote}
        onOpenLink={onOpenLink}
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
          scrollBehavior="dismiss"
          role="dialog"
          label="Add note to highlight"
          onDismiss={onClose}
        >
          <div ref={desktopPanelRef} className={styles.panel}>
            {editor}
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
            <div className={styles.quote}>{session.quote}</div>
            {editor}
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
