"use client";

// What a reader does with a selection or a mark. A selection is not yet a
// resource: Highlight, Note, Ask, Learn and Share create its highlight first
// and continue with it; Link creates nothing until a target is confirmed.
// A mark's verbs arrive as this pane visit's entry, claimed once its marks load.
import { useCallback, useEffect, useRef, useState } from "react";
import { useFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  assumeReaderSelectionKey,
  readerHighlightChatIntent,
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
import { useLinkComposerHost } from "@/lib/actions/ResourceActionsProvider";
import { requirePaneRuntime, usePaneEntryDelivery, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { useShareController } from "@/lib/sharing/controller";
import { anchoredShareOpenOptions } from "@/lib/sharing/openOptions";
import { resourceShareTarget } from "@/lib/sharing/targets";
import { useOverlay } from "@/lib/ui/overlay";
import type { Reader } from "@/lib/documentReader/runtime";
import { useSelectionComposer, type SelectionComposer } from "./useSelectionComposer";
import type { AnnotationStore } from "./annotations";

interface BoundsSession {
  readonly id: string;
  readonly highlightId: string;
  readonly identity: string;
  readonly unit: string;
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
  onSelection(event: SelectionEvent): void;
  onMarks(event: MarkEvent): void;
  highlight(color: HighlightColor): void;
  linkSelection(): void;
  ask(): void;
  chat(conversationId: string | null): void;
  learn(): void;
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
  const feedback = useFeedback();
  const [notice, setNotice] = useState<FeedbackContent | null>(null);
  const { activateTarget } = requirePaneRuntime(usePaneRuntime(), "useAnnotationVerbs");
  const { openShare } = useShareController();
  const [menu, setMenu] = useState<AnnotationVerbs["menu"]>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [noteEdit, setNoteEdit] = useState<AnnotationVerbs["noteEdit"]>(null);
  const [choosingChat, setChoosingChat] = useState<string | null>(null);
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
  const link = useLinkComposerHost();

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
        return openEvidence(`highlight:${id}`);
      case "EditHighlightBounds": {
        if (mark.anchor.kind !== "text") return inform("this highlight’s bounds can’t be edited");
        const highlight = store.highlight(id);
        if (!highlight || !publication) return inform("this highlight is no longer available");
        composer.dismiss();
        showBounds({ id: createRandomId(), highlightId: id, identity: publication, unit: mark.anchor.unit,
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
    onSelection(next) {
      const document = reader.getState().document;
      if (!active || document.status !== "ready" || next.identity !== document.doc.identity) return;
      const session = currentBounds.current;
      setSelectionIssue(null);
      if (session?.phase === "Selecting" && session.identity === next.identity) {
        if (next.kind === "Rejected" || next.anchor.kind !== "text" || next.anchor.unit !== session.unit) {
          showBounds({ ...session, issue: "select within the same text section as this highlight." });
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
            if (isApiError(error) && error.code === "E_HIGHLIGHT_CONFLICT") {
              if (error.details?.reason === "unit_mismatch" || error.details?.reason === "version_mismatch") {
                store.refresh();
                if (owns()) {
                  showBounds(null);
                  setSelectionIssue("this highlight changed. reopen change highlighted passage.");
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
        setSelectionIssue(next.reason === "CrossUnit" ? "select within one text section." : "select within one pdf page.");
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
    linkSelection() {
      const selected = composer.draft;
      const anchor = selected?.passage.anchor;
      if (!anchor) return;
      const highlight_id = createRandomId();
      composer.dismiss();
      link.openLink({
        label: "selected passage",
        onLinked: store.refresh,
        onAddLinkNote: (id) => {
          setNoteEdit((current) => ({ kind: "link", id, request: (current?.request ?? 0) + 1 }));
          openEvidence(id);
        },
        onViewConnection: () => openEvidence(null),
        source: selected?.highlightId ? { kind: "resource", ref: `highlight:${selected.highlightId}` } :
          anchor.kind === "text"
            ? { kind: "fragment_selection", highlight_id, fragment_id: anchor.unit, start_offset: anchor.start, end_offset: anchor.end, color: "yellow" }
            : { kind: "pdf_selection", highlight_id, media_id: mediaId, page_number: anchor.page, quads: [...anchor.quads], exact: selected?.passage.quote ?? "", color: "yellow" },
      });
    },
    ask() {
      if (!canQuote) return;
      withHighlight((highlightId) => setChoosingChat(highlightId));
    },
    chat(conversationId) {
      const highlightId = choosingChat;
      setChoosingChat(null);
      if (!highlightId || !conversationId) return;
      const key = assumeReaderSelectionKey({ mediaId, highlightId });
      activateTarget({
        target: {
          href: readerHighlightChatIntentHref(readerHighlightChatIntent({ kind: "Existing", conversationId }, key)),
          labelHint: "Chat",
        },
        disposition: { kind: "Adopt" },
      });
    },
    learn() {
      withHighlight(async (id, isCurrent) => {
        setNotice({ tone: "Neutral", title: "creating dossier…" });
        try {
          const outcome = await learnDossier(`highlight:${id}`, createRandomId("learn-dossier"));
          setNotice(null);
          const open = () => activateTarget({
            target: { href: artifactPaneHref(outcome.artifact_ref), labelHint: "Dossier" },
            disposition: { kind: "Adopt" },
          });
          if (isCurrent()) open();
          else feedback.offer({ key: `learn:${id}`, announcement: "Polite", content: { tone: "Success", title: "dossier created" }, actions: [{ label: "open dossier", onClick: open }] });
        } catch (error) {
          fail(error, "dossier creation not confirmed");
        }
      });
    },
    share(trigger) {
      withHighlight((id) =>
        openShare(resourceShareTarget(`highlight:${id}`), anchoredShareOpenOptions(trigger, () => null)),
      );
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
