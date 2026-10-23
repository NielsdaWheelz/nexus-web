"use client";

import Button from "@/components/ui/Button";

// One session composer captures its destination. Focusing the blank line creates
// nothing; prose or a chosen reference admits the existing write contract.
import { useRef } from "react";
import NoteEditor from "./NoteEditor";
import { sameBody, type NoteBody } from "@/lib/notes/noteBody";
import { editText } from "@/lib/notes/texts";
import type { ReferenceConsumption } from "@/lib/notes/journal";
import type {
  DailyPublication,
  OutlineDestination,
  OutlineSession,
} from "@/lib/notes/useOutlineSession";
import styles from "./OutlineEditor.module.css";

export default function OutlineInsertionLine({
  session,
  destination,
  publication,
}: {
  session: OutlineSession;
  destination: OutlineDestination;
  publication?: DailyPublication;
}) {
  const admitting = useRef(false);
  const composer = session.composer;
  const current =
    composer !== null &&
    composer.destination.occurrencePrefix === destination.occurrencePrefix &&
    composer.destination.path.join("/") === destination.path.join("/") &&
    composer.destination.position?.after === destination.position?.after;

  function admit(body: NoteBody, consumed_reference?: ReferenceConsumption | null) {
    if (admitting.current || composer === null || session.readComposer()?.serial !== composer.serial) return;
    admitting.current = true;
    void session.insertNote({
      destination: composer.destination,
      body,
      consumed_reference,
      publication: composer.publication,
    }).then(
      (result) => {
        admitting.current = false;
        const latest = session.readComposer();
        if (latest?.serial !== composer.serial) return;
        if (!result) {
          session.composerProblem("item was not inserted; your draft is kept at its original position");
          return;
        }
        const changed = !sameBody(latest.body, body);
        if (changed) editText(result.noteRef, latest.body);
        session.closeComposer();
        if (changed && session.isActiveEditor(`insertion:${session.scope}`))
          session.focusRow(result.key, latest.selection);
      },
      (error: unknown) => {
        admitting.current = false;
        if (session.readComposer()?.serial === composer.serial)
          session.composerProblem("couldn’t insert item; your draft is kept at its original position");
        throw error;
      },
    );
  }

  if (!current || composer === null)
    return (
      <div className={styles.insertion}>
        <button
          type="button"
          className={styles.insert}
          aria-label="insert item"
          disabled={session.activeReference !== null}
          onClick={() => session.openComposer(destination, publication)}
        >
          <span aria-hidden="true">&nbsp;</span>
        </button>
      </div>
    );

  return (
    <div className={styles.insertion}>
      <NoteEditor
        editorKey={`insertion:${session.scope}`}
        occurrenceKey={`insertion:${session.scope}`}
        containingNoteRef={null}
        body={composer.body}
        revision={0}
        editable
        label="insert item"
        placeholder="write or @ to link"
        compact
        focus={session.focus?.key === `insertion:${session.scope}`
          ? session.focus
          : { selection: composer.selection, serial: composer.serial }}
        outlineSession={session}
        history={null}
        keys={{ split: (left) => admit(left) }}
        reference={{
          source: composer.destination.source,
          label: "insert item",
          position: composer.destination.position,
          onSelected: (target, targetItem, authored) => {
            if (session.readComposer()?.serial !== composer.serial) return;
            // Admission transfers the exact target and destination to ChildAction;
            // its acknowledgement must never own this or a later composer.
            void session.insertReference({
              destination: composer.destination,
              target,
              targetItem,
              authored,
              publication: composer.publication,
            });
            session.closeComposer();
          },
          onActiveChange: (active) => session.setReferenceActive(`insertion:${session.scope}`, active),
        }}
        onEdit={(edit) => {
          if (session.readComposer()?.serial !== composer.serial) return;
          session.editComposer(edit.after, edit.selectionAfter);
          admit(edit.after, edit.editBase?.consumed_reference);
        }}
      />
      {composer.problem ? <p role="alert">{composer.problem}</p> : null}
      <Button
        className={styles.discard}
        disabled={session.activeReference !== null}
        onClick={() => {
          if (session.readComposer()?.serial === composer.serial) session.closeComposer();
        }}
      >
        discard insertion
      </Button>
    </div>
  );
}
