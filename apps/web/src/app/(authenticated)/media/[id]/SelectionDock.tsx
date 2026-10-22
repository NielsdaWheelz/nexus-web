"use client";

import { useCallback, useEffect, useId, useState, type KeyboardEvent, type MouseEvent } from "react";
import { BookOpenText, Copy, Save, Share2 } from "lucide-react";
import ConversationDestinationOverlay from "@/components/chat/ConversationDestinationOverlay";
import { FeedbackNotice, FeedbackStatus, useFeedback } from "@/components/feedback/Feedback";
import NoteEditor from "@/components/notes/NoteEditor";
import { DraftDecision } from "@/components/notes/NoteNotices";
import ResourceBody from "@/components/resources/ResourceBody";
import Button from "@/components/ui/Button";
import ButtonLink from "@/components/ui/ButtonLink";
import Dialog from "@/components/ui/Dialog";
import FloatingActionSurface from "@/components/ui/FloatingActionSurface";
import { useResourceActions } from "@/lib/actions/useResourceActions";
import type { Schema } from "@/lib/api/wire";
import type { Reader } from "@/lib/documentReader/runtime";
import { useReaderState } from "@/lib/documentReader/DocumentReader";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { prepareActionSelect, projectActionControlState, type ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { copyText } from "@/lib/ui/copyText";
import type { AnnotationStore } from "./annotations";
import type { AnnotationVerbs } from "./useAnnotationVerbs";
import HighlightColourPicker, { Colours } from "./HighlightColourPicker";
import { convertReaderQuestion } from "@/lib/chat/readerQuestion";
import { initialBody, isEmptyParagraph } from "./selectionDrafts";
import styles from "./media.module.css";

const COMPOSER_ACTIONS = new Set(["Chat", "HighlightNote", "EditHighlight"]);

/** One local projection preserves command state, native navigation and unavailable help. */
function SelectionAction({ action, blockedReason = null, help }: {
  readonly action: Exclude<ActionDescriptor, { kind: "custom" }>;
  readonly blockedReason?: string | null;
  readonly help?: string;
}) {
  const reasonId = useId();
  const runtime = usePaneRuntime();
  if (!action.icon) throw new Error(`Selection action ${action.id} has no icon`);
  const control = projectActionControlState(action.label, action.kind === "command" ? action.state : undefined);
  const reason = blockedReason ?? (action.disabled ? action.disabledReason ?? "this action is unavailable." : null);
  const description = help ?? control.menuLabel;
  // A blocked control stops activation before this runs.
  const activate = (event: MouseEvent<HTMLButtonElement | HTMLAnchorElement> | KeyboardEvent<HTMLButtonElement | HTMLAnchorElement>) => {
    if (action.kind === "link") {
      if (action.onActivate) action.onActivate(event);
      else activateTargetLink({ event, runtime, target: { href: action.href } });
      return;
    }
    const detail = prepareActionSelect(event, event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null);
    if (detail) action.onSelect(detail);
  };
  const tone = action.tone === "danger" ? "danger" : undefined;
  const icon = <>
    {action.icon}
    {action.indicator ? <span className={styles.selectionStatusMarker} /> : null}
  </>;
  const tooltip = { text: reason ? `${description}. ${reason}` : description };
  return <>
    {action.kind === "link" ? (
      <ButtonLink href={action.href} aria-disabled={reason !== null || undefined} iconOnly icon={icon} tone={tone}
        className={styles.selectionIcon} tooltip={tooltip} aria-label={action.label}
        aria-describedby={reason ? reasonId : undefined} data-action-id={action.id}
        data-workspace-rich-target="true" onClick={activate} onKeyDown={activate} />
    ) : (
      <Button aria-disabled={reason !== null || undefined} iconOnly icon={icon} tone={tone}
        className={styles.selectionIcon} tooltip={tooltip} aria-label={action.label}
        aria-describedby={reason ? reasonId : undefined} data-action-id={action.id}
        aria-pressed={control.barPressed} aria-expanded={control.barExpanded} aria-controls={control.barControls}
        onClick={activate} onKeyDown={activate} />
    )}
    {reason ? <span id={reasonId} className="sr-only">{reason}</span> : null}
  </>;
}

/** The canonical action model, rendered directly; this surface has no menu to close. */
function HighlightActions({ id, blockedReason }: { readonly id: string; readonly blockedReason: string | null }) {
  const { state, prepare } = useResourceActions(`highlight:${id}`);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    prepare(controller.signal);
    return () => controller.abort();
  }, [prepare, attempt]);
  if (state === null || state.kind === "Loading") return <FeedbackStatus
    content={{ tone: "Neutral", title: "loading actions…" }} announcement="Polite" />;
  if (state.kind === "Failed") return <FeedbackNotice content={state.feedback} announcement="Polite"
    actions={[{ label: "retry", onClick: () => setAttempt((current) => current + 1) }]} />;
  return <>
    {state.options.filter((action) => !COMPOSER_ACTIONS.has(action.id)).map((action) => {
      if (action.kind === "custom") return <div key={action.id}>{action.render({ triggerEl: null, closeMenu: () => {}, closeMenuWithoutFocus: () => {}, presentation: "bar" })}</div>;
      return <SelectionAction key={action.id} action={action} blockedReason={blockedReason}
        help={action.id === "LearnHighlight" ? "create a dossier from this passage" : undefined} />;
    })}
  </>;
}

export default function SelectionDock({ verbs, store, reader, isMobile, canQuote }: {
  readonly verbs: AnnotationVerbs;
  readonly store: AnnotationStore;
  readonly reader: Reader;
  readonly isMobile: boolean;
  readonly canQuote: boolean;
}) {
  const { composer, menu } = verbs;
  const feedback = useFeedback();
  const { draft, opening } = composer;
  const identity = useReaderState(reader, (state) => state.document.status === "ready" ? state.document.doc.identity : null);
  const sourceChanged = draft?.issue?.kind === "Source" || (draft !== null && identity !== null && draft.passage.identity !== identity);
  const anchor = useCallback(() => {
    if (!draft) return null;
    const measured = reader.measurePassage(draft.passage);
    if (measured) return measured;
    const bounds = reader.measureBounds();
    return bounds ? { rect: null, lines: [], bounds } : null;
  }, [draft, reader]);
  const chooserAnchor = useCallback(() => {
    if (!menu?.marks[0]) return null;
    return reader.measurePassage({ identity: menu.identity, anchor: menu.marks[0].anchor });
  }, [menu, reader]);
  const blocked = composer.paused || !draft || draft.handle === null || draft.load !== "Ready" || draft.operation !== null || draft.referenceActive;
  const deleting = draft?.operation?.kind === "Delete";
  const emptyExisting = draft?.base.kind === "Present" && isEmptyParagraph(draft.body);
  const dirty = draft && JSON.stringify(draft.body.body_pm_json) !== JSON.stringify(initialBody(draft.base).body_pm_json);
  const highlight = draft?.highlight ?? (draft?.highlightId ? store.highlight(draft.highlightId) : null);
  const map = store.getState().map;
  const overlapItems = menu && map.status !== "loading" && map.data
    ? map.data.evidence.roots.map((root) => root.content) : [];
  const size = isMobile ? "comfortable" : undefined;
  return <>
    {draft && opening ? <FloatingActionSurface open anchor={anchor} subscribeAnchor={reader.subscribe}
      strategy="text-selection" role="group" label="passage annotation" className={styles.composerSurface}
      onDismiss={composer.dismiss}>
      {(placed, anchorState) => {
        const unavailable = anchorState === "unavailable";
        const blockedReason = composer.paused ? "writing is paused." : draft.handle === null ? "preparing your draft…" : sourceChanged ? "the source changed. your words are kept; select the passage again."
          : draft.issue?.kind === "Conflict" || draft.issue?.kind === "Deleted" ? "review the saved note or choose a new passage before saving."
          : draft.load !== "Ready" ? "load your note before using this action."
          : draft.referenceActive ? "finish linking or press escape to keep this as prose."
          : draft.operation ? "finish or retry the current request first."
          : unavailable && !draft.highlightId ? "this passage is no longer available." : null;
        const highlightReason = blockedReason ?? (highlight?.is_owner === false ? "only your own highlight can be changed." : null);
        const hasMessage = convertReaderQuestion(draft.body).kind !== "Blank";
        const destination = draft.destination;
        const selected = destination.kind === "Selected" ? destination : null;
        const preparing = draft.chatAttempt?.kind === "Preparing" || draft.operation?.kind === "Chat" || draft.operation?.kind === "Ensure" || (selected?.snapshot.kind === "Loading");
        const sending = composer.ownChatCommand && composer.chatState.kind === "Busy";
        const continuationBlocked = (selected !== null && selected.snapshot.kind !== "Ready") || (hasMessage && composer.chat?.target.kind === "Blocked");
        const chatLabel = sending ? "sending…" : preparing ? "loading chat…" : destination.kind === "Resolving" ? "finding a chat…"
          : selected ? `${hasMessage ? "send to" : "open in"} “${selected.title}”` : "choose existing chat…";
        const chatIssue = draft.chatIssue;
        const commandRecovery = composer.ownChatCommand && (composer.chatState.kind === "Unconfirmed" || composer.chatState.kind === "RefreshRequired") ? composer.chatState : null;
        const blockedChat = composer.chat?.target.kind === "Blocked" ? composer.chat.target.reason === "AssistantRunning"
          ? "this chat is still responding" : "this chat can’t accept a reply here"
          : selected?.snapshot.kind === "RefreshRequired" ? "this chat changed"
          : selected?.snapshot.kind === "Failed" ? "couldn’t load chat" : null;
        return (
          <div data-selection-composer="true" className={styles.selectionComposer}>
            <div className={styles.passageCue}>{draft.passage.quote || "selected passage"}</div>
            {unavailable || sourceChanged ? <FeedbackNotice content={{ tone: "Warning", title: sourceChanged
              ? "the source changed. your words are kept; select the passage again."
              : "this passage is no longer available. your draft is kept." }} announcement="Polite"
              actions={[{ label: "select passage again", onClick: composer.reselect }]} /> : null}
            <div className={styles.dock}>
              <HighlightColourPicker key={opening.id} selected={highlight?.color ?? "yellow"} persisted={draft.highlightId !== null}
                disabledReason={highlightReason} onSelect={verbs.highlight} />
              <SelectionAction blockedReason={blocked ? blockedReason : null} action={{ kind: "command", id: "CopyPassage", label: "copy passage", icon: <Copy size={16} aria-hidden="true" />, onSelect: () => {
                void copyText(draft.passage.quote).catch(() => feedback.offer({ key: "reader-copy-passage", announcement: "Polite", content: { tone: "Danger", title: "passage couldn’t be copied" } }));
              } }} />
              <SelectionAction blockedReason={blockedReason} action={{ kind: "command", id: "SavePassageNote", label: draft.base.kind === "Absent" && isEmptyParagraph(draft.body) ? "save highlight" : "save note",
                icon: <Save size={16} aria-hidden="true" />, onSelect: composer.save }} />
              {draft.highlightId ? <HighlightActions id={draft.highlightId} blockedReason={blockedReason} /> : <>
                <SelectionAction blockedReason={blockedReason} help="create a dossier from this passage"
                  action={{ kind: "command", id: "LearnPassage", label: "learn from passage", icon: <BookOpenText size={16} aria-hidden="true" />, onSelect: ({ openIntent }) => verbs.learn(openIntent) }} />
                <SelectionAction blockedReason={blockedReason} action={{ kind: "command", id: "SharePassage", label: "share passage", icon: <Share2 size={16} aria-hidden="true" />,
                  onSelect: ({ triggerEl }) => verbs.share(triggerEl) }} />
              </>}
            </div>
            <div className={styles.selectionInput}>
              {draft.load === "Ready" ? <NoteEditor key={draft.id} editorKey={`reader-draft:${draft.id}`}
                containingNoteRef={draft.base.kind === "Present" ? `note_block:${draft.base.id}` : null}
                body={draft.body} embeddedItem={draft.base.kind === "Present" ? draft.base.embeddedItem : null} revision={draft.revision} label="note or question"
                reference={composer.reference()} placeholder="write a note, or @ link something" compact editable={!deleting && draft.handle !== null && !composer.paused}
                focus={placed && opening.focus ? { selection: draft.selection ?? "end", serial: opening.serial, preventScroll: true } : null}
                onEdit={composer.edit} onSelectionChange={composer.selection}
                history={{ undo: composer.undo, redo: composer.redo, boundary: composer.historyBoundary }}
                onSave={composer.save} onNewChat={canQuote ? () => composer.newChat("default") : undefined}
                onContinueChat={canQuote ? () => composer.continueChat() : undefined} onEmptyBackspace={composer.deleteNote}
                />
                : !draft.issue ? <FeedbackStatus content={{ tone: "Neutral", title: "loading your note…" }} announcement="Polite" /> : null}
            </div>
            {canQuote ? <>
              <div className={styles.chatFooter}>
                <Button disabled={Boolean(blockedReason) || (hasMessage ? composer.chatLocked : composer.readerChatLocked)} onClick={() => composer.newChat("default")}>new chat</Button>
                <Button emphasis="strong" className={styles.destinationAction} tooltip={{ text: selected ? `${chatLabel}${composer.branchCue ? ` · ${composer.branchCue}` : ""}` : chatLabel }}
                  disabled={Boolean(blockedReason) || (hasMessage ? composer.chatLocked : composer.readerChatLocked) || preparing || destination.kind === "Resolving" || Boolean(continuationBlocked)}
                  onClick={() => composer.continueChat()}><span className={styles.destinationLabel}>{chatLabel}</span></Button>
                <Button aria-expanded={composer.pickerOpen} disabled={Boolean(blockedReason) || composer.chatLocked} onClick={composer.chooseChat}>choose existing chat</Button>
              </div>
              {composer.branchCue ? <div className={styles.composerHint}>{composer.branchCue}</div> : null}
              {commandRecovery ? <FeedbackNotice content={{ tone: "Warning", title: commandRecovery.kind === "Unconfirmed" ? "send not confirmed" : "this chat changed", message: "your question is kept" }} announcement="Polite"
                actions={commandRecovery.kind === "Unconfirmed" ? [{ label: "retry same send", onClick: composer.retryChat }]
                  : [{ label: "refresh chat", onClick: composer.refreshChat }]} />
                : chatIssue ? <FeedbackNotice content={{ tone: "Warning", title: chatIssue.message, message: "your note draft is kept" }} announcement="Polite"
                  actions={chatIssue.kind === "Catalog" ? [
                    { label: "retry", onClick: composer.retryCatalog },
                    { label: "choose a model in chat", onClick: composer.recoverModel },
                  ] : chatIssue.kind === "Model" ? [{ label: "choose a model in chat", onClick: composer.recoverModel }]
                    : chatIssue.kind === "Missing" ? [{ label: "choose existing chat…", onClick: composer.chooseChat }]
                    : chatIssue.kind === "Changed" ? [{ label: "refresh chat", onClick: composer.refreshChat }, { label: "open chat", onClick: composer.openChat }] : undefined} />
                  : composer.chatLocked && !composer.ownChatCommand ? <FeedbackNotice content={{ tone: "Neutral", title: "another chat change is still in progress" }} announcement="Polite"
                    actions={selected ? [{ label: "open chat", onClick: composer.openChat }] : undefined} />
                    : blockedChat ? <FeedbackNotice content={{ tone: "Neutral", title: blockedChat }} announcement="Polite"
                      actions={[{ label: "refresh chat", onClick: composer.refreshChat }, { label: "open chat", onClick: composer.openChat }]} />
                      : destination.kind === "Absent" ? <FeedbackStatus content={{ tone: "Neutral", title: "no chat for this source yet" }} announcement="Polite" />
                        : destination.kind === "LookupFailed" ? <FeedbackNotice content={{ tone: "Warning", title: "couldn’t find a recent chat" }} announcement="Polite"
                          actions={[{ label: "retry", onClick: composer.retryDefault }]} /> : null}
            </> : null}
            {composer.conflictDraft ? <DraftDecision draft={composer.conflictDraft}
              resolve={(choice, shown) => composer.resolveConflict(choice === "saved", shown)} retire={composer.retireDraft} /> : draft.issue && draft.issue.kind !== "Source" ? <>
              <FeedbackNotice content={{ tone: "Warning", title: draft.issue.message,
                message: draft.issue.kind !== "Conflict" && !draft.operation && draft.load === "Ready" ? "review your draft before saving." : undefined,
              }} announcement="Polite" actions={draft.issue.kind === "Conflict" ? [
                { label: "use saved note", onClick: () => void composer.resolveConflict(true, composer.conflictShown) },
                { label: "save my draft instead", onClick: () => void composer.resolveConflict(false, composer.conflictShown) },
              ] : draft.issue.kind === "Deleted" ? draft.highlightId ? [
                { label: "save as a new note", onClick: () => void composer.saveAsNewNote(composer.conflictShown) },
                { label: "select passage again", onClick: composer.reselect },
              ] : [{ label: "select passage again", onClick: composer.reselect }] : draft.operation || draft.load !== "Ready" ? [{
                label: draft.operation ? "retry same request" : "reload note", onClick: composer.retry,
                commandKey: draft.operation?.id, busy: Boolean(draft.operation) || draft.load === "Loading",
              }] : undefined} />
              {draft.issue.kind === "Conflict" && draft.issue.saved.kind === "Absent"
                ? <span className={styles.composerHint}>the saved note is absent.</span> : null}
            </> : draft.status || (dirty && !draft.operation) ? <FeedbackStatus
              content={{ tone: "Neutral", title: draft.status ?? "saving…" }} announcement="None"
            /> : null}
            <div className={styles.composerHint}>{draft.referenceActive ? "enter links · escape keeps literal text" : <>enter saves · shift+enter new line · {typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "ctrl"}+enter {hasMessage ? "sends in new chat" : "opens a new chat"} · modifier+shift+enter {selected ? "uses the displayed chat" : "chooses existing chat"}</>}</div>
            {emptyExisting ? <div className={styles.composerHint}>
              backspace deletes this note and its links. the highlight stays.
              <Button size={size} tone="danger" disabled={blocked} onClick={composer.deleteNote}>delete empty note</Button>
            </div> : null}
          </div>
        );
      }}
    </FloatingActionSurface> : null}
    {!draft && composer.recoveries.length > 0 ? <details className={styles.composerHint}>
      <summary>passage drafts · {composer.recoveries.length}</summary>
      {composer.recoveries.map(saved => <div key={saved.draft_id}>
        <Button size="sm" variant="ghost" onClick={() => composer.restore(saved.draft_id)}>
          restore {saved.context.kind === "passage" ? saved.context.passage.quote || "selected passage" : "passage draft"}
        </Button>
      </div>)}
    </details> : null}
    {menu ? <FloatingActionSurface open anchor={chooserAnchor} subscribeAnchor={reader.subscribe} role="group" label="choose highlight" onDismiss={verbs.closeMenu}>
      <div className={styles.chooser}>
        <span>choose highlight</span>
        {menu.marks.map((mark) => {
          const highlight = store.highlight(mark.id);
          const item = overlapItems.find((item): item is Schema<"ReaderEvidenceHighlightOut"> => item.kind === "Highlight" && item.highlight_id === mark.id);
          return <button key={mark.id} type="button" onClick={() => verbs.chooseMark(mark.id)}>
            {item ? <ResourceBody body={item.item.preview.body} /> : "highlight"}
            <span>{mark.color} · {highlight?.is_owner ? "your highlight" : "shared highlight"}</span>
          </button>;
        })}
      </div>
    </FloatingActionSurface> : null}
    <Dialog open={verbs.recolouring !== null} title="edit highlight" onClose={() => verbs.recolour(null)}>
      <Colours selected={verbs.recolouring ? store.getState().decorations.marks.find((mark) => mark.id === verbs.recolouring)?.color ?? null : null} onSelect={verbs.recolour} />
    </Dialog>
    {draft ? <ConversationDestinationOverlay open={composer.pickerOpen} mediaId={draft.sourceMediaId} hasSourceChats={draft.sourceHasChats}
      onClose={composer.closePicker} onSelectConversation={composer.chooseDestination} /> : null}
  </>;
}
