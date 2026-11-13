"use client";

import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import Button from "@/components/ui/Button";
import Textarea from "@/components/ui/Textarea";
import { Fact, Failed } from "@/components/feedback/Fact";
import type { ServerValue } from "@/lib/api/serverState";
import { useChatDraft, type Draft } from "@/lib/chat/drafts";
import { pendingReason, refusalOf, type CommandState, type LibrarianCommands } from "@/lib/chat/commands";
import { useChatSelection } from "@/lib/chat/selectionMemory";
import { unavailability, type SelectionEditor } from "@/lib/chat/selection";
import type { Catalog } from "@/lib/chat/wire";
import { createRandomId } from "@/lib/createRandomId";
import { requirePaneRuntime, usePaneIsActive, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { usesMeta } from "@/lib/shortcuts";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useLatestWorkspace } from "@/lib/workspace/store";
import GenerationPicker from "./GenerationPicker";
import { DraftReferenceFigure } from "./ReferenceFigure";
import styles from "./ChatComposer.module.css";

/** Admission, not generation, gates send. Later questions remain editable and
 * append to the same server queue while the librarian is answering. */
export default function ChatComposer({ catalog: catalogRead, command, owner, focusKey, autoSend, selection, reason, recall }: {
  selection: SelectionEditor; reason: string | null;
  recall: string | null;
  catalog: ServerValue<Catalog>; command: CommandState; owner: LibrarianCommands; focusKey: string | null; autoSend: { id: string; draft: Draft } | null;
}) {
  const runtime = requirePaneRuntime(usePaneRuntime(), "ChatComposer");
  const active = usePaneIsActive();
  const workspace = useLatestWorkspace();
  const { platform } = useRenderEnvironment();
  const { draft, setText, setSelection, setQuote, getCaret, setCaret, entry, refusal, refuse } = useChatDraft(runtime.paneId);
  const memory = useChatSelection();
  const catalog = catalogRead.status === "ready" ? catalogRead.data : null;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const mobile = useIsMobileViewport();
  useEffect(() => { if (active && focusKey) textarea.current?.focus({ preventScroll: true }); }, [active, focusKey]);
  useEffect(() => { const caret = getCaret(); if (caret) textarea.current?.setSelectionRange(caret.start, caret.end, caret.direction); }, [getCaret]);
  const canSend = command.kind === "Idle" && catalog !== null && selection.kind === "Selected" && reason === null && draft.text.trim().length > 0;
  const submit = () => {
    if (!canSend || catalog === null || entry.getSnapshot().draft !== draft) return false;
    // Entry can invalidate recall after this render. Check its fence at dispatch.
    const selected = draft.selection.kind === "Uninitialized" ? memory.fresh(catalog) : draft.selection;
    if (selected?.kind !== "Selected" || unavailability(catalog, selected) !== null) return false;
    const submitted = draft;
    refuse(null);
    void owner.execute({ kind: "Send", runId: createRandomId(), viewId: runtime.paneId,
      request: { content: submitted.text, selection: selected.selection, attachments: submitted.quote ? [submitted.quote.reference] : [] } }, receipt => {
      const visit = workspace().state.panes.find(pane => pane.id === runtime.paneId)?.current_visit;
      const currentVisit = visit?.id === runtime.visitId && new URL(visit.href, "https://nexus.invalid").pathname === "/librarian";
      entry.accept(receipt, submitted, currentVisit, runtime.visitId); memory.enter();
    }).then(outcome => { if (outcome.kind === "Failed") refuse(refusalOf(outcome)); }).catch(error => owner.reportDefect(error));
    return true;
  };
  const sentEntry = useRef<string | null>(null);
  useEffect(() => {
    if (!autoSend || sentEntry.current === autoSend.id) return;
    if (entry.getSnapshot().draft !== autoSend.draft) { sentEntry.current = autoSend.id; return; }
    if (submit()) sentEntry.current = autoSend.id;
  });
  return <div className={styles.composer}>
    <div className={styles.rule} aria-hidden="true" />
    {draft.quote ? <DraftReferenceFigure quote={draft.quote} onRemove={() => { setQuote(null); textarea.current?.focus({ preventScroll: true }); }} /> : null}
    <Textarea bare autoGrow={{ minRows: 1, maxRows: 8 }} ref={textarea} className={styles.input} value={draft.text} aria-label="ask the librarian" placeholder={draft.quote ? "ask about this passage" : "ask the librarian"}
      onChange={event => { setText(event.target.value); if (draft.selection.kind === "Uninitialized" && selection.kind === "Selected") setSelection(selection); }}
      onSelect={event => { const field = event.currentTarget; setCaret({ start: field.selectionStart, end: field.selectionEnd, direction: field.selectionDirection }); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "ArrowUp" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && draft.text === "" && recall !== null) {
          event.preventDefault();
          // Commit the recalled value before placing the native caret at its end.
          flushSync(() => setText(recall));
          setCaret({ start: recall.length, end: recall.length, direction: "none" });
          event.currentTarget.setSelectionRange(recall.length, recall.length);
          return;
        }
        if (event.key !== "Enter" || event.shiftKey || event.altKey) return;
        const primary = usesMeta(platform) ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
        const plain = !event.ctrlKey && !event.metaKey;
        if (!primary && (!plain || mobile)) return;
        event.preventDefault();
        if (!event.repeat) submit();
      }} />
    {memory.read.status === "failed" ? <Failed error={memory.read.error} noun="saved model" retry={{ run: memory.read.refetch, busy: memory.read.retrying }} /> : null}
    {refusal ? <Fact line={refusal.line} /> : reason ? <Fact line={{ fact: reason }} /> : null}
    <div className={styles.row}><GenerationPicker catalogRead={catalogRead} value={selection} onChange={setSelection} waiting={selection.kind === "Uninitialized"} unavailable={reason} returnFocus={() => textarea.current?.focus({ preventScroll: true })} />
      <Button tone="accent" className={styles.send} disabled={!canSend} aria-busy={command.kind === "Busy" || undefined} title={pendingReason(command) ?? undefined} onClick={submit}>
        send{!mobile ? <span className={styles.hint} aria-hidden="true">↵</span> : null}
      </Button>
    </div>
  </div>;
}
