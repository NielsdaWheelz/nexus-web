"use client";

// Every title editor uses canonical page text; history remains with its surface.
import { useLayoutEffect, useRef, type RefObject } from "react";
import Textarea from "@/components/ui/Textarea";
import { NoteConflict } from "./NoteNotices";
import { adoptText, flushText, useText } from "@/lib/notes/texts";
import type { Schema } from "@/lib/api/wire";
import type {
  BodyOccurrence,
  OutlineDestination,
  OutlineEditorCommands,
  OutlineSession,
} from "@/lib/notes/useOutlineSession";
import styles from "./OutlineEditor.module.css";

type TitleSelection = {
  anchor: number;
  head: number;
  direction: "forward" | "backward" | "none";
};
const selection = (input: HTMLTextAreaElement): TitleSelection => ({
  anchor: input.selectionStart,
  head: input.selectionEnd,
  direction: input.selectionDirection,
});

export default function PageTitleEditor({
  session,
  occurrence,
  content,
  editable,
  continuation = null,
  label,
  inputRef,
  carry = false,
  rootEnter,
}: {
  session: OutlineSession;
  occurrence: BodyOccurrence;
  content: Schema<"PageContentOut">;
  editable: boolean;
  continuation?: OutlineDestination | null;
  label: string;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  carry?: boolean;
  rootEnter?: { label: string; execute(): void };
}) {
  const ownRef = useRef<HTMLTextAreaElement | null>(null);
  const ref = inputRef ?? ownRef;
  const text = useText(occurrence.noteRef);
  const value = typeof text?.value === "string" ? text.value : content.title;
  const beforeSelection = useRef<TitleSelection>({ anchor: 0, head: 0, direction: "none" });
  const composing = useRef(false);
  const appliedFocus = useRef<number | null>(null);
  const canEdit = editable && !text?.gone && session.activeReference === null;

  useLayoutEffect(() => {
    adoptText(occurrence.noteRef, content.title, content.title_version);
  }, [content.title, content.title_version, occurrence.noteRef]);
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    const beforeInput = (event: InputEvent) => {
      if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
        event.preventDefault();
        session.executeCommand(event.inputType === "historyUndo" ? "undo" : "redo");
      } else beforeSelection.current = selection(input);
    };
    input.addEventListener("beforeinput", beforeInput);
    return () => input.removeEventListener("beforeinput", beforeInput);
  }, [ref, session]);

  const commands: OutlineEditorCommands = {
    key: occurrence.key,
    insertLabel: rootEnter?.label ?? "insert item after page",
    commandState(command) {
      if (!canEdit || composing.current)
        return { enabled: false, reason: "finish editing the title first" };
      if (command === "insert") {
        const enabled = rootEnter !== undefined || continuation !== null;
        return { enabled, reason: enabled ? null : "the insertion position is unavailable" };
      }
      if (command === "undo" || command === "redo") return session.historyState(command);
      return session.occurrenceCommandState(occurrence.key, command);
    },
    executeCommand(command) {
      if (!commands.commandState(command).enabled) return;
      if (command === "insert") {
        flushText(occurrence.noteRef);
        if (rootEnter) rootEnter.execute();
        else if (continuation) session.openComposer(continuation);
      } else if (command === "undo") session.undo();
      else if (command === "redo") session.redo();
      else session.executeOccurrenceCommand(occurrence.key, command);
    },
  };
  const latest = useRef({ commands, session });
  latest.current = { commands, session };
  const binding = useRef<OutlineEditorCommands>({
    key: occurrence.key,
    get insertLabel() { return latest.current.commands.insertLabel; },
    commandState: (command) => latest.current.commands.commandState(command),
    executeCommand: (command) => latest.current.commands.executeCommand(command),
  });
  const editorBinding = binding.current;
  useLayoutEffect(() => () => latest.current.session.releaseEditor(editorBinding), [editorBinding]);
  useLayoutEffect(() => {
    const request = session.focus;
    if (
      !canEdit || composing.current || request?.key !== occurrence.key ||
      request.target !== "text" || appliedFocus.current === request.serial
    ) return;
    const input = ref.current;
    if (!input) return;
    appliedFocus.current = request.serial;
    input.focus();
    if (request.selection === "end") input.setSelectionRange(value.length, value.length);
    else input.setSelectionRange(request.selection.anchor, request.selection.head, request.selection.direction);
  }, [session.focus, canEdit, occurrence.key, ref, value.length]);

  return (
    <>
      <Textarea
        bare
        autoGrow={{ minRows: 1, maxRows: Infinity }}
        ref={ref}
        className={occurrence.key === "" ? styles.title : styles.inlineTitle}
        aria-label={label}
        value={value}
        readOnly={!canEdit}
        onFocus={(event) => {
          session.bindEditor(binding.current);
          session.setTextSelection(occurrence.key, selection(event.currentTarget));
        }}
        onBlur={() => flushText(occurrence.noteRef)}
        onSelect={(event) => {
          beforeSelection.current = selection(event.currentTarget);
          session.setTextSelection(occurrence.key, beforeSelection.current);
        }}
        onCompositionStart={() => {
          composing.current = true;
          session.boundary();
          session.refreshCommands();
        }}
        onCompositionEnd={() => {
          composing.current = false;
          session.boundary();
          session.refreshCommands();
        }}
        onChange={(event) => session.editTitle({
          occurrence,
          before: value,
          after: event.currentTarget.value,
          selectionBefore: beforeSelection.current,
          selectionAfter: selection(event.currentTarget),
          carry,
        })}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || composing.current || event.repeat) return;
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
            event.preventDefault();
            session.executeCommand(event.shiftKey ? "redo" : "undo");
          } else if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
            event.preventDefault();
            session.executeCommand("insert");
          } else if (event.key === "Escape") {
            event.preventDefault();
            if (occurrence.key === "") session.revokeCommands();
            else session.selectOccurrence(occurrence.key);
          }
        }}
      />
      <NoteConflict textRef={occurrence.noteRef} />
    </>
  );
}
