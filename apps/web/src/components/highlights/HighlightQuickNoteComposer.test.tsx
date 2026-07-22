import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { paragraphFromText } from "@/lib/notes/prosemirror/schema";
import HighlightQuickNoteComposer, {
  type QuickNoteSession,
} from "./HighlightQuickNoteComposer";
import styles from "./HighlightQuickNoteComposer.module.css";

type ComposerProps = Parameters<typeof HighlightQuickNoteComposer>[0];

const ANCHOR_RECT = new DOMRect(120, 160, 80, 18);

function Harness({
  initialSession,
  onSaveNote,
  onDeleteNote = vi.fn(async () => undefined),
}: {
  initialSession: QuickNoteSession | null;
  onSaveNote: ComposerProps["onSaveNote"];
  onDeleteNote?: ComposerProps["onDeleteNote"];
}) {
  const [session, setSession] = useState(initialSession);
  return (
    <FeedbackProvider>
      <HighlightQuickNoteComposer
        session={session}
        onClose={() => setSession(null)}
        onSaveNote={onSaveNote}
        onDeleteNote={onDeleteNote}
        onOpenLink={() => {}}
      />
    </FeedbackProvider>
  );
}

function saveNoteMock() {
  return vi.fn(
    async (
      _highlightId: string,
      noteBlockId: string | null,
      createBlockId: string,
      bodyPmJson: Record<string, unknown>,
      _clientMutationId: string
    ) => ({
      note_block_id: noteBlockId ?? createBlockId,
      body_pm_json: bodyPmJson,
      body_text: "",
    })
  );
}

function deferredCreation(): {
  promise: Promise<{ id: string } | null>;
  resolve: (value: { id: string } | null) => void;
} {
  let resolve: (value: { id: string } | null) => void = () => undefined;
  const promise = new Promise<{ id: string } | null>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function pendingSession(creation: Promise<{ id: string } | null>): QuickNoteSession {
  return {
    kind: "pending-create",
    sessionId: "session-1",
    quote: "Quoted highlight text",
    anchorRect: ANCHOR_RECT,
    creation,
  };
}

function existingSession(
  note: { note_block_id: string; body_pm_json: Record<string, unknown>; body_text: string } | null
): QuickNoteSession {
  return {
    kind: "existing",
    highlightId: "highlight-9",
    note,
    quote: "Quoted highlight text",
    anchorRect: ANCHOR_RECT,
  };
}

const composerDialog = () => screen.findByRole("dialog", { name: "Add note to highlight" });
const noteEditor = () => screen.findByRole("textbox", { name: "Highlight note" });

function noteBlockIdFromEditor(editor: HTMLElement): string {
  // Compact highlight notes hide the "Open note block" handle (display:none),
  // which drops its accessible name, so read the id from the block list item.
  const blockId = within(editor).getByRole("listitem").getAttribute("data-note-block-id");
  if (!blockId) {
    throw new Error("Expected the editor to render a note block id");
  }
  return blockId;
}

describe("HighlightQuickNoteComposer", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    document.body.style.overflow = "";
  });

  describe("desktop popover", () => {
    beforeEach(() => {
      vi.stubGlobal("innerWidth", 1280); // desktop viewport drives useIsMobileViewport=false
    });

    it("bridges a pending-create save to the real highlight id without remounting the editor", async () => {
      const user = userEvent.setup();
      const creation = deferredCreation();
      const onSaveNote = saveNoteMock();
      render(<Harness initialSession={pendingSession(creation.promise)} onSaveNote={onSaveNote} />);

      await composerDialog();
      const editor = await noteEditor();
      await waitFor(() => expect(editor).toHaveFocus());
      const draftBlockId = noteBlockIdFromEditor(editor);

      await user.keyboard("hello");
      expect(onSaveNote).not.toHaveBeenCalled();

      creation.resolve({ id: "highlight-real" });
      await waitFor(() => expect(onSaveNote).toHaveBeenCalledTimes(1), { timeout: 3000 });
      expect(onSaveNote).toHaveBeenCalledWith(
        "highlight-real",
        null,
        draftBlockId,
        paragraphFromText("hello").toJSON(),
        expect.any(String)
      );

      // The editor key is the opaque session id and must never change mid-session.
      expect(screen.getByRole("textbox", { name: "Highlight note" })).toBe(editor);
    });

    it("shows 'Save failed' and stays open with the typed draft when highlight creation fails", async () => {
      const user = userEvent.setup();
      const creation = deferredCreation();
      const onSaveNote = saveNoteMock();
      render(<Harness initialSession={pendingSession(creation.promise)} onSaveNote={onSaveNote} />);

      const editor = await noteEditor();
      await waitFor(() => expect(editor).toHaveFocus());
      await user.keyboard("still here");

      creation.resolve(null);
      await screen.findByText("Save failed", undefined, { timeout: 3000 });

      expect(onSaveNote).not.toHaveBeenCalled();
      expect(editor).toHaveTextContent("still here");
      expect(
        screen.getByRole("dialog", { name: "Add note to highlight" })
      ).toBeInTheDocument();
    });

    it("preloads the existing note and saves through its note_block_id", async () => {
      const user = userEvent.setup();
      const onSaveNote = saveNoteMock();
      render(
        <Harness
          initialSession={existingSession({
            note_block_id: "note-1",
            body_pm_json: paragraphFromText("existing").toJSON() as Record<string, unknown>,
            body_text: "existing",
          })}
          onSaveNote={onSaveNote}
        />
      );

      const editor = await noteEditor();
      expect(editor).toHaveTextContent("existing");

      await user.click(editor);
      await user.keyboard("more");

      await waitFor(() => expect(onSaveNote).toHaveBeenCalledTimes(1), { timeout: 3000 });
      expect(onSaveNote).toHaveBeenCalledWith(
        "highlight-9",
        "note-1",
        "note-1",
        expect.anything(),
        expect.any(String)
      );
    });

    it("Escape closes the composer and the pending edit still saves", async () => {
      const user = userEvent.setup();
      const onSaveNote = saveNoteMock();
      render(<Harness initialSession={existingSession(null)} onSaveNote={onSaveNote} />);

      const editor = await noteEditor();
      await waitFor(() => expect(editor).toHaveFocus());
      const draftBlockId = noteBlockIdFromEditor(editor);
      await user.keyboard("bye");

      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

      // Unmounting the editor flushes the debounced save — dismissal never discards.
      await waitFor(() => expect(onSaveNote).toHaveBeenCalledTimes(1), { timeout: 3000 });
      expect(onSaveNote).toHaveBeenCalledWith(
        "highlight-9",
        null,
        draftBlockId,
        paragraphFromText("bye").toJSON(),
        expect.any(String)
      );
    });

    it("outside pointerdown closes the composer", async () => {
      const onSaveNote = saveNoteMock();
      render(<Harness initialSession={existingSession(null)} onSaveNote={onSaveNote} />);

      await composerDialog();
      fireEvent.pointerDown(document.body);

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("renders nothing when session is null", () => {
      render(<Harness initialSession={null} onSaveNote={saveNoteMock()} />);

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    });
  });

  describe("mobile sheet", () => {
    beforeEach(() => {
      vi.stubGlobal("innerWidth", 390); // mobile viewport drives useIsMobileViewport=true
      // Keep the sheet's back-button wiring off the real test-runner history stack.
      vi.spyOn(history, "pushState").mockImplementation(() => {});
      vi.spyOn(history, "back").mockImplementation(() => {});
    });

    it("presents as a labeled sheet with a clamped quote header and focused editor", async () => {
      const creation = deferredCreation();
      render(<Harness initialSession={pendingSession(creation.promise)} onSaveNote={saveNoteMock()} />);

      const sheet = await composerDialog();
      expect(sheet).toHaveAttribute("aria-modal", "true");

      const quote = screen.getByText("Quoted highlight text");
      expect(quote).toHaveClass(styles.quote!);

      const editor = await noteEditor();
      await waitFor(() => expect(editor).toHaveFocus()); // initialFocus targets the contenteditable
    });

    it("keeps the sheet mounted but inactive when session is null", () => {
      render(<Harness initialSession={null} onSaveNote={saveNoteMock()} />);

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});
