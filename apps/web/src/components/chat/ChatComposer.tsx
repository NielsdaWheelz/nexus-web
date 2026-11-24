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
import type { ResolvedSelection } from "@/lib/chat/selection";
import type { Catalog, Selection } from "@/lib/chat/wire";
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
export default function ChatComposer({ catalog: catalogRead, command, owner, focusKey, autoSend, choice, refused, currentSelection, recall }: {
  choice: ResolvedSelection; refused(value: Selection): boolean; currentSelection(): Selection | null;
  recall: string | null;
  catalog: ServerValue<Catalog>; command: CommandState; owner: LibrarianCommands; focusKey: string | null; autoSend: { id: string; draft: Draft } | null;
}) {
  const runtime = requirePaneRuntime(usePaneRuntime(), "ChatComposer");
  const active = usePaneIsActive();
  const workspace = useLatestWorkspace();
  const { platform } = useRenderEnvironment();
  const { draft, setText, setSelection, setQuote, getCaret, setCaret, entry, refusal, refuse } = useChatDraft(runtime.paneId);
  const memory = useChatSelection();
  const { value: selection, reason } = choice;
  const recallError = memory.read.status === "loading" ? null : memory.read.error;
  const recallPending = memory.read.status === "loading" || (memory.read.status === "failed" ? memory.read.retrying : memory.read.refreshing);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const mobile = useIsMobileViewport();
  useEffect(() => { if (active && focusKey) textarea.current?.focus({ preventScroll: true }); }, [active, focusKey]);
  useEffect(() => { const caret = getCaret(); if (caret) textarea.current?.setSelectionRange(caret.start, caret.end, caret.direction); }, [getCaret]);
  const canSend = command.kind === "Idle" && catalogRead.status === "ready" && selection.kind === "Selected" && reason === null && draft.text.trim().length > 0;
  const submit = () => {
    if (!canSend || !owner.canExecute()) return false;
    const selected = currentSelection();
    if (!selected) return false;
    const submitted = draft;
    refuse(null);
    void owner.execute({ kind: "Send", runId: createRandomId(), viewId: runtime.paneId,
      request: { content: submitted.text, selection: selected, attachments: submitted.quote ? [submitted.quote.attachment] : [] } }, receipt => {
      const visit = workspace().state.panes.find(pane => pane.id === runtime.paneId)?.current_visit;
      const currentVisit = visit?.id === runtime.visitId && new URL(visit.href, "https://nexus.invalid").pathname === "/librarian";
      entry.accept(receipt, submitted, currentVisit, runtime.visitId);
    }).then(outcome => { if (outcome.kind === "Failed") refuse(refusalOf(outcome)); }).catch(error => owner.reportDefect(error));
    return true;
  };
  const sentEntry = useRef<string | null>(null);
  useEffect(() => {
    if (!autoSend || sentEntry.current === autoSend.id) return;
    if (reason !== null || catalogRead.status === "failed" || catalogRead.status === "ready" && catalogRead.error
      || selection.kind === "Uninitialized" && recallError || entry.getSnapshot().draft !== autoSend.draft) { sentEntry.current = autoSend.id; return; }
    if (submit()) sentEntry.current = autoSend.id;
  });
  return <div className={styles.composer}>
    <div className={styles.rule} aria-hidden="true" />
    {draft.quote ? <DraftReferenceFigure quote={draft.quote} onRemove={() => { setQuote(null); textarea.current?.focus({ preventScroll: true }); }} /> : null}
    <Textarea bare autoGrow={{ minRows: 1, maxRows: 8 }} ref={textarea} className={styles.input} value={draft.text} aria-label="ask the librarian" placeholder={draft.quote ? "ask about this passage" : "ask the librarian"}
      onChange={event => {
        setText(event.target.value);
        if (entry.getSnapshot().draft.selection.kind === "Uninitialized") {
          const fresh = memory.fresh(catalogRead.status === "ready" ? catalogRead.data : null);
          if (fresh?.kind === "Selected") setSelection(fresh);
        }
      }}
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
    {recallError ? <Failed error={recallError} noun="saved model" retry={{ run: memory.read.refetch, busy: recallPending }} /> : null}
    {refusal ? <Fact line={refusal.line} /> : null}
    {reason && refusal?.line.reason !== reason ? <Fact line={{ fact: reason }} /> : null}
    <div className={styles.row}><GenerationPicker catalogRead={catalogRead} choice={choice} refused={refused} recallPending={recallPending} onChange={setSelection} returnFocus={() => textarea.current?.focus({ preventScroll: true })} />
      <Button tone="accent" className={styles.send} disabled={!canSend} aria-busy={command.kind === "Busy" || undefined} title={pendingReason(command) ?? undefined} onClick={submit}>
        send{!mobile ? <span className={styles.hint} aria-hidden="true">↵</span> : null}
      </Button>
    </div>
  </div>;
}
