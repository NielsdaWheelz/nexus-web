"use client";

// What a reader does with a selection or a mark. A selection is not yet a
// resource: Highlight, Note, Ask, Learn and Share create its highlight first
// and continue with it; Link creates nothing until a target is confirmed.
// A mark's verbs arrive as this pane visit's entry, claimed once its marks load.
// An unresolved quote enters the same bounds session from its evidence row;
// relocation keeps its owner, quote and note, with the mounted generation fenced.
import { useCallback, useEffect, useRef, useState } from "react";
import { type FeedbackContent } from "@/components/feedback/Feedback";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  assumeReaderSelectionKey,
  readerHighlightChatIntentHref,
} from "@/lib/chat/readerIntent";
import { createRandomId } from "@/lib/createRandomId";
import {
  useReaderState,
  type Mark,
  type MarkEvent,
  type SelectionEvent,
} from "@/lib/documentReader/DocumentReader";
import type { HighlightColor } from "@/lib/documentReader/model";
import { artifactPaneHref, learnDossier } from "@/lib/dossiers/dossierApi";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { requirePaneRuntime, usePaneEntryDelivery, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { openAsyncResult } from "@/lib/panes/openResult";
import { useShareController } from "@/lib/sharing/controller";
import { anchoredShareOpenOptions } from "@/lib/sharing/openOptions";
import { resourceShareTarget } from "@/lib/sharing/targets";
import { useOverlay } from "@/lib/ui/overlay";
import type { OpenIntent } from "@/lib/ui/targetActivation";
import type { Reader } from "@/lib/documentReader/runtime";
import { useSelectionComposer, type SelectionComposer } from "./useSelectionComposer";
import type { AnnotationStore } from "./annotations";

interface BoundsSession {
  readonly id: string;
  readonly highlightId: string;
  readonly mediaId: string;
  readonly identity: string;
  /** null relocates an unresolved quote within its original canonical media. */
  readonly unit: string | null;
  readonly version: string;
  readonly phase: "Selecting" | "Submitting";
  readonly issue: string | null;
}

export interface AnnotationVerbs {
  readonly notice: FeedbackContent | null;
  readonly menu: Extract<MarkEvent, { kind: "activate" }> | null;
  readonly composer: SelectionComposer;
  readonly focused: string | null;
  readonly hovered: string | null;
  /** Being recoloured from its menu. */
  readonly recolouring: string | null;
  /** A highlight whose note the Evidence row edits. */
  readonly noteEdit: { readonly kind: "highlight" | "link"; readonly id: string; readonly request: number } | null;
  /** A highlight waiting for an existing chat to be chosen. */
  readonly choosingChat: string | null;
  readonly selectionIssue: string | null;
  readonly bounds: BoundsSession | null;
  cancelBounds(): void;
  relocate(id: string): void;
  onSelection(event: SelectionEvent): void;
  onMarks(event: MarkEvent): void;
  highlight(color: HighlightColor): void;
  ask(intent?: OpenIntent): void;
  chat(conversationId: string | null, intent?: OpenIntent): void;
  learn(intent?: OpenIntent): void;
  share(trigger: HTMLButtonElement | null): void;
  focus(id: string | null): void;
  hover(id: string | null): void;
  chooseMark(id: string): void;
  closeMenu(): void;
  recolour(color: HighlightColor | null): void;
  closeNoteEdit(): void;
}

export function useAnnotationVerbs(input: {
  readonly mediaId: string;
  readonly reader: Reader;
  readonly active: boolean;
  readonly store: AnnotationStore;
  /** The marks mounted in the reader; pane entries wait for their first load. */
  readonly marks: readonly Mark[] | null;
  readonly canQuote: boolean;
  readonly openEvidence: (itemId: string | null) => void;
}): AnnotationVerbs {
  const { mediaId, reader, active, store, marks, canQuote, openEvidence } = input;
  const { ctx } = useActionRuntime();
  const [notice, setNotice] = useState<FeedbackContent | null>(null);
  const { activateTarget, paneId, closeSecondaryPane } = requirePaneRuntime(usePaneRuntime(), "useAnnotationVerbs");
  const { openShare } = useShareController();
  const [menu, setMenu] = useState<AnnotationVerbs["menu"]>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [noteEdit, setNoteEdit] = useState<AnnotationVerbs["noteEdit"]>(null);
  const [choosingChat, setChoosingChat] = useState<string | null>(null);
  const chatIntent = useRef<OpenIntent>("default");
  const [colour, setColour] = useState<string | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const [selectionIssue, setSelectionIssue] = useState<string | null>(null);
  const [bounds, setBounds] = useState<BoundsSession | null>(null);
  const currentBounds = useRef<BoundsSession | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const publication = useReaderState(reader, (state) => state.document.status === "ready" ? state.document.doc.identity : null);
  // Admission changes synchronously, before another source event or queue completion.
  const showBounds = useCallback((next: BoundsSession | null) => { currentBounds.current = next; setBounds(next); }, []);
  const cancelBounds = useCallback(() => {
    if (currentBounds.current?.phase !== "Selecting") return;
    showBounds(null);
    setSelectionIssue(null);
    reader.focusSource();
  }, [reader, showBounds]);
  useOverlay(active && bounds !== null && bounds.identity === publication && bounds.phase === "Selecting", {
    kind: "transient",
    onDismiss: cancelBounds,
  });
  useEffect(() => {
    showBounds(null);
    setSelectionIssue(null);
  }, [active, publication, showBounds]);
  useEffect(() => () => { currentBounds.current = null; activeRef.current = false; }, []);

  const fail = useCallback(
    (error: unknown, title: string) => {
      if (handleUnauthenticatedApiError(error)) return;
      if (!isApiError(error) || isSameSystemApiDefect(error)) return setDefect({ error });
      setNotice({ tone: "Danger", title, requestId: error.requestId });
    },
    [],
  );

  const composer = useSelectionComposer({ mediaId, reader, annotations: store, active, onError: fail });
  const { highlightDeleted } = composer;
  const withHighlight = composer.ensure;
  const recolouringHighlight = colour ? store.highlight(colour) : null;

  // Resource actions target this visit; no other mounted reader may consume them.
  const { delivery, claim } = usePaneEntryDelivery();
  useEffect(() => {
    if (delivery === null || !("highlightId" in delivery.entry) || marks === null) return;
    if (!claim(delivery)) return;
    const { entry } = delivery;
    const id = entry.highlightId;
    const mark = marks.find((candidate) => candidate.id === id);
    const inform = (title: string) => setNotice({ tone: "Neutral", title });
    if (!mark) return inform("this highlight is no longer available");
    setNotice(null);
    setColour(null);
    showBounds(null);
    setSelectionIssue(null);
    setMenu(null);
    switch (entry.kind) {
      case "EditHighlight":
        return setColour(id);
      case "EditHighlightNote":
        setNoteEdit((current) => ({ kind: "highlight", id, request: (current?.request ?? 0) + 1 }));
        return openEvidence(id);
      case "EditHighlightBounds": {
        if (mark.anchor.kind !== "text") return inform("this highlight’s bounds can’t be edited");
        const highlight = store.highlight(id);
        if (!highlight || !publication) return inform("this highlight is no longer available");
        composer.dismiss();
        showBounds({ id: createRandomId(), highlightId: id, mediaId: highlight.mediaId, identity: publication, unit: mark.anchor.unit,
          version: highlight.version, phase: "Selecting", issue: null });
        setFocused(id);
        return reader.focusSource();
      }
      case "DeleteHighlight":
        void store.remove(id).then(
          () => {
            setFocused((current) => current === id ? null : current);
            highlightDeleted(id);
          },
          (error: unknown) => fail(error, "Highlight wasn’t deleted"),
        );
    }
  }, [claim, composer, delivery, fail, highlightDeleted, marks, openEvidence, publication, reader, showBounds, store]);

  const closeNoteEdit = useCallback(() => {
    setNoteEdit(null);
    store.refresh();
  }, [store]);

  if (defect) throw defect.error;
  return {
    notice,
    menu,
    composer,
    focused,
    hovered,
    recolouring: colour,
    noteEdit,
    choosingChat,
    selectionIssue,
    bounds,
    cancelBounds,
    relocate(id) {
      const document = reader.getState().document;
      const map = store.getState().map;
      const highlight = store.highlight(id);
      if (!active || document.status !== "ready" || document.refreshing || document.doc.kind !== "text" ||
        map.status !== "ready" || map.data.identity !== document.doc.identity || !highlight?.is_owner ||
        !map.data.evidence.roots.some((root) => root.resolution?.kind === "Unavailable" &&
          root.content.kind === "Highlight" && root.content.highlight_id === id)) {
        setNotice({ tone: "Neutral", title: "refresh this highlight before relocating it." });
        return;
      }
      composer.dismiss();
      setMenu(null);
      setSelectionIssue(null);
      showBounds({ id: createRandomId(), highlightId: id, mediaId: highlight.mediaId, identity: document.doc.identity,
        unit: null, version: highlight.version, phase: "Selecting", issue: null });
      closeSecondaryPane({ restoreFocus: false });
      reader.focusSource();
    },
    onSelection(next) {
      const document = reader.getState().document;
      if (!active || document.status !== "ready") return;
      if (document.refreshing || next.identity !== document.doc.identity) {
        setSelectionIssue("this post changed. select the passage again.");
        return;
      }
      const session = currentBounds.current;
      setSelectionIssue(null);
      if (session?.phase === "Selecting" && session.identity === next.identity) {
        if (next.kind === "Rejected" || next.anchor.kind !== "text" ||
          (session.unit !== null && next.anchor.unit !== session.unit) || store.source(next.anchor).mediaId !== session.mediaId) {
          showBounds({ ...session, issue: session.unit === null
            ? "select matching text within the highlight’s original document."
            : "select within the same text section as this highlight." });
          return;
        }
        const submitted: BoundsSession = { ...session, phase: "Submitting", issue: null };
        showBounds(submitted);
        const owns = () => {
          const document = reader.getState().document;
          return activeRef.current && currentBounds.current?.id === submitted.id &&
            document.status === "ready" && document.doc.identity === submitted.identity;
        };
        void store.rebound(submitted.highlightId, next.anchor, submitted.version).then(
          () => { if (owns()) showBounds(null); },
          (error: unknown) => {
            if (isApiError(error) && error.code === "E_READER_CONTENT_CHANGED") {
              if (owns()) { showBounds(null); setSelectionIssue("this post changed. select the passage again."); }
              reader.reload();
            } else if (isApiError(error) && error.code === "E_HIGHLIGHT_CONFLICT") {
              if (error.details?.reason === "quote_mismatch") {
                if (owns()) showBounds({ ...submitted, phase: "Selecting",
                  issue: "select text matching the original quote. the quote and note will stay unchanged." });
              } else if (error.details?.reason === "unit_mismatch" || error.details?.reason === "version_mismatch") {
                store.refresh();
                if (owns()) {
                  showBounds(null);
                  setSelectionIssue("this highlight changed. start again from its evidence row.");
                }
              } else if (owns()) showBounds({ ...submitted, phase: "Selecting",
                issue: "a highlight already covers that passage. select another passage or cancel." });
            } else {
              if (owns()) showBounds(null);
              fail(error, "Highlight wasn’t changed");
            }
          },
        );
        return;
      }
      showBounds(null);
      if (next.kind === "Rejected") {
        composer.dismiss();
        setMenu(null);
        setSelectionIssue(next.reason === "CrossUnit" ? (document.doc.kind === "text" && document.doc.units.some((unit) => unit.xPost !== null) ? "select text within one post" : "select within one text section.") : "select within one pdf page.");
        return;
      }
      composer.select(next);
      setMenu(null);
    },
    onMarks(event) {
      if (event.kind === "hover") return setHovered(event.ids[0] ?? null);
      if (currentBounds.current?.phase === "Selecting") return;
      showBounds(null);
      setSelectionIssue(null);
      setFocused(event.marks[0]?.id ?? null);
      if (event.marks.length > 1) setMenu(event);
      else if (event.marks[0]) composer.activate(event.marks[0], event.identity, event.input !== "touch");
    },
    highlight: (color) => composer.highlight(color),
    ask(intent = "default") {
      if (!canQuote) return;
      void withHighlight().then((result) => { if (result?.isCurrent()) { chatIntent.current = intent; setChoosingChat(result.id); } });
    },
    chat(conversationId, intent = "default") {
      const highlightId = choosingChat;
      const openIntent = chatIntent.current === "new_pane" ? "new_pane" : intent;
      setChoosingChat(null);
      chatIntent.current = "default";
      if (!highlightId || !conversationId) return;
      const key = assumeReaderSelectionKey({ mediaId: store.highlight(highlightId)?.mediaId ?? mediaId, highlightId });
      activateTarget({
        target: {
          href: readerHighlightChatIntentHref({ destination: { kind: "Existing", conversationId }, key }),
          labelHint: "Chat",
        },
        disposition: { kind: openIntent === "new_pane" ? "Fork" : "Adopt" },
      });
    },
    learn(intent = "default") {
      const requestId = createRandomId("learn-dossier");
      let mayOpen = () => false;
      void openAsyncResult({ ctx, originPaneId: paneId, intent, disposition: "Adopt", mayOpen: () => mayOpen(), create: async () => {
        const ensured = await withHighlight();
        if (!ensured) return null;
        mayOpen = ensured.isCurrent;
        if (ensured.isCurrent()) setNotice({ tone: "Neutral", title: "creating dossier…" });
        const outcome = await learnDossier(`highlight:${ensured.id}`, requestId);
        if (ensured.isCurrent()) setNotice(null);
        return { target: { href: artifactPaneHref(outcome.artifact_ref), labelHint: "Dossier" }, title: "dossier created", openLabel: "open dossier" };
      } }).catch((error: unknown) => fail(error, "dossier creation not confirmed"));
    },
    share(trigger) {
      void withHighlight().then((result) => {
        if (result?.isCurrent()) openShare(resourceShareTarget(`highlight:${result.id}`), anchoredShareOpenOptions(trigger, () => null));
      });
    },
    focus: setFocused,
    hover: setHovered,
    chooseMark(id) {
      const mark = menu?.marks.find((entry) => entry.id === id);
      if (mark && menu) composer.activate(mark, menu.identity, menu.input !== "touch");
      setMenu(null);
    },
    closeMenu: () => setMenu(null),
    recolour(color) {
      const id = colour;
      setColour(null);
      if (!id || !color || !recolouringHighlight) return;
      void store.recolor(id, color, recolouringHighlight.version).catch((error: unknown) => {
        if (isApiError(error) && error.code === "E_HIGHLIGHT_CONFLICT") store.refresh();
        fail(error, "Highlight wasn’t changed");
      });
    },
    closeNoteEdit,
  };
}
