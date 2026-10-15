"use client";

// What a reader does with a selection or a mark. A selection is not yet a
// resource: Highlight, Note, Ask, Learn and Share create its highlight first
// and continue with it; Link creates nothing until a target is confirmed.
// A mark's verbs from the resource menu arrive as this pane's entry (edit,
// note, bounds, delete), served once the marks are loaded.
import { useCallback, useEffect, useRef, useState } from "react";
import { useFeedback } from "@/components/feedback/Feedback";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  assumeReaderSelectionKey,
  readerHighlightChatIntent,
  readerHighlightChatIntentHref,
} from "@/lib/chat/readerIntent";
import { createRandomId } from "@/lib/createRandomId";
import type {
  Mark,
  MarkEvent,
  SelectionCapture,
  TextRange,
} from "@/lib/documentReader/DocumentReader";
import type { HighlightColor } from "@/lib/documentReader/model";
import { artifactPaneHref, learnDossier } from "@/lib/dossiers/dossierApi";
import { useLinkComposerHost } from "@/lib/actions/ResourceActionsProvider";
import {
  requirePaneRuntime,
  usePaneEntryDelivery,
  usePaneRuntime,
} from "@/lib/panes/paneRuntime";
import { useShareController } from "@/lib/sharing/controller";
import { anchoredShareOpenOptions } from "@/lib/sharing/openOptions";
import { resourceShareTarget } from "@/lib/sharing/targets";
import { isEditableTarget } from "@/lib/ui/eventTarget";
import type { AnnotationStore } from "./annotations";

/** The quick note: a draft whose highlight exists, or is being created under it. */
export interface QuickNote {
  readonly key: string;
  readonly highlightId: string | null;
  readonly creation: Promise<{ id: string } | null> | null;
  readonly quote: string;
  readonly rect: DOMRect;
}

export interface AnnotationVerbs {
  readonly capture: SelectionCapture | null;
  readonly menu: { readonly ids: readonly string[]; readonly rect: DOMRect } | null;
  readonly composer: QuickNote | null;
  readonly focused: string | null;
  readonly hovered: string | null;
  readonly busy: boolean;
  /** Being recoloured from its menu. */
  readonly recolouring: string | null;
  /** A highlight whose note the Evidence row edits. */
  readonly noteEdit: { readonly kind: "highlight" | "link"; readonly id: string; readonly request: number } | null;
  /** A highlight waiting for an existing chat to be chosen. */
  readonly choosingChat: string | null;
  onSelection(capture: SelectionCapture | null): void;
  onMarks(event: MarkEvent): void;
  highlight(color: HighlightColor): void;
  note(): void;
  linkSelection(): void;
  ask(destination: "new" | "existing"): void;
  chat(conversationId: string | null): void;
  learn(): void;
  share(trigger: HTMLButtonElement | null): void;
  focus(id: string | null): void;
  hover(id: string | null): void;
  openMenu(ids: readonly string[], rect: DOMRect): void;
  recolour(color: HighlightColor | null): void;
  closeComposer(): void;
  closeNoteEdit(): void;
}

export function useAnnotationVerbs(input: {
  readonly mediaId: string;
  readonly store: AnnotationStore;
  /** The marks mounted in the reader; menu entries are served once they load. */
  readonly marks: readonly Mark[] | null;
  readonly canQuote: boolean;
  readonly openEvidence: (itemId: string | null) => void;
}): AnnotationVerbs {
  const { mediaId, store, marks, canQuote, openEvidence } = input;
  const { activateTarget } = requirePaneRuntime(usePaneRuntime(), "useAnnotationVerbs");
  const feedback = useFeedback();
  const { openShare } = useShareController();
  const [capture, setCapture] = useState<SelectionCapture | null>(null);
  const [menu, setMenu] = useState<AnnotationVerbs["menu"]>(null);
  const [composer, setComposer] = useState<QuickNote | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [noteEdit, setNoteEdit] = useState<AnnotationVerbs["noteEdit"]>(null);
  const [choosingChat, setChoosingChat] = useState<string | null>(null);
  const [colour, setColour] = useState<string | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const bounds = useRef<string | null>(null);

  const fail = useCallback(
    (error: unknown, title: string) => {
      if (handleUnauthenticatedApiError(error)) return;
      if (!isApiError(error) || isSameSystemApiDefect(error)) return setDefect({ error });
      feedback.publish({ kind: "Hud", content: { tone: "Danger", title, requestId: error.requestId } });
    },
    [feedback],
  );
  const link = useLinkComposerHost();

  /** Creates the selection's highlight (or finds the viewer's exact twin), then continues with it. */
  const withHighlight = useCallback(
    (color: HighlightColor, then?: (id: string) => void | Promise<void>) => {
      const anchor = capture?.anchor;
      if (!anchor || busy) return;
      setBusy(true);
      void store
        .create(anchor, color)
        .then(async ({ id }) => {
          setFocused(id);
          setCapture(null);
          document.getSelection()?.removeAllRanges();
          await then?.(id);
        })
        .catch((error: unknown) => fail(error, "Highlight wasn’t changed"))
        .finally(() => setBusy(false));
    },
    [busy, capture, fail, store],
  );

  const note = useCallback(() => {
    if (!capture) return;
    const twin = store.twin(capture.anchor);
    setComposer({
      key: twin ?? createRandomId(),
      highlightId: twin,
      creation: twin
        ? null
        : store.create(capture.anchor, "yellow").then(({ id }) => ({ id }), () => null),
      quote: capture.quote,
      rect: capture.rect,
    });
    setCapture(null);
    document.getSelection()?.removeAllRanges();
  }, [capture, store]);

  // Single-key chords on a live selection or a focused highlight.
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (isEditableTarget(event.target) || (!capture && !focused)) return;
      const run = event.key === "n" && capture ? note : null;
      if (!run) return;
      event.preventDefault();
      run();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [capture, focused, note]);

  // A menu verb on one of this reader's highlights, served once the marks are
  // loaded; a newer entry replaces the colour picker, note editor or bounds mode.
  const { delivery, claim } = usePaneEntryDelivery();
  useEffect(() => {
    if (delivery === null || !("highlightId" in delivery.entry) || marks === null) return;
    if (!claim(delivery)) return;
    const { entry } = delivery;
    const id = entry.highlightId;
    const mark = marks.find((candidate) => candidate.id === id);
    const notice = (title: string) => feedback.publish({ kind: "Hud", content: { tone: "Neutral", title } });
    if (!mark) return notice("This highlight is no longer available.");
    setColour(null);
    bounds.current = null;
    setMenu(null);
    switch (entry.kind) {
      case "EditHighlight":
        return setColour(id);
      case "EditHighlightNote":
        setNoteEdit((current) => ({ kind: "highlight", id, request: (current?.request ?? 0) + 1 }));
        return openEvidence(`highlight:${id}`);
      case "EditHighlightBounds":
        if (mark.anchor.kind !== "text") return notice("This highlight’s bounds can’t be edited.");
        bounds.current = id;
        setFocused(id);
        return notice("Select the new passage for this highlight");
      case "DeleteHighlight":
        void store.remove(id).then(
          () => setFocused((current) => (current === id ? null : current)),
          (error: unknown) => fail(error, "Highlight wasn’t deleted"),
        );
    }
  }, [claim, delivery, fail, feedback, marks, openEvidence, store]);

  // The Evidence row's note editor holds this: stable, so its published body is too.
  const closeNoteEdit = useCallback(() => {
    setNoteEdit(null);
    store.refresh();
  }, [store]);

  if (defect) throw defect.error;
  return {
    capture,
    menu,
    composer,
    focused,
    hovered,
    busy,
    recolouring: colour,
    noteEdit,
    choosingChat,
    onSelection(next) {
      const id = bounds.current;
      if (id && next?.anchor.kind === "text") {
        bounds.current = null;
        void store.rebound(id, next.anchor as TextRange).then(
          () => document.getSelection()?.removeAllRanges(),
          (error: unknown) => fail(error, "Highlight wasn’t changed"),
        );
        return;
      }
      setCapture(next);
      if (next) setMenu(null);
    },
    onMarks(event) {
      if (event.kind === "hover") return setHovered(event.ids[0] ?? null);
      setFocused(event.ids[0] ?? null);
      setMenu(event.rect ? { ids: event.ids, rect: event.rect } : null);
    },
    highlight: (color) => withHighlight(color),
    note,
    linkSelection() {
      const anchor = capture?.anchor;
      if (!anchor) return;
      const highlight_id = createRandomId();
      setCapture(null);
      document.getSelection()?.removeAllRanges();
      link.openLink({
        label: "selected passage",
        onLinked: store.refresh,
        onAddLinkNote: (id) => {
          setNoteEdit((current) => ({ kind: "link", id, request: (current?.request ?? 0) + 1 }));
          openEvidence(id);
        },
        onViewConnection: () => openEvidence(null),
        source:
          anchor.kind === "text"
            ? { kind: "fragment_selection", highlight_id, fragment_id: anchor.unit, start_offset: anchor.start, end_offset: anchor.end, color: "yellow" }
            : { kind: "pdf_selection", highlight_id, media_id: mediaId, page_number: anchor.page, quads: [...anchor.quads], exact: anchor.exact, color: "yellow" },
      });
    },
    ask(destination) {
      if (!canQuote) return;
      withHighlight("yellow", (highlightId) => {
        if (destination === "existing") return setChoosingChat(highlightId);
        const key = assumeReaderSelectionKey({ mediaId, highlightId });
        activateTarget({
          target: { href: readerHighlightChatIntentHref(readerHighlightChatIntent({ kind: "New" }, key)), labelHint: "Chat" },
          disposition: { kind: "Fork" },
        });
      });
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
      withHighlight("yellow", async (id) => {
        feedback.publish({ kind: "Hud", key: `learn:${id}`, content: { tone: "Neutral", title: "Creating dossier…" } });
        try {
          const outcome = await learnDossier(`highlight:${id}`, createRandomId("learn-dossier"));
          feedback.resolve(`learn:${id}`);
          activateTarget({
            target: { href: artifactPaneHref(outcome.artifact_ref), labelHint: "Dossier" },
            disposition: { kind: "Adopt" },
          });
        } catch (error) {
          feedback.resolve(`learn:${id}`);
          fail(error, "Dossier couldn’t be created");
        }
      });
    },
    share(trigger) {
      withHighlight("yellow", (id) =>
        openShare(resourceShareTarget(`highlight:${id}`), anchoredShareOpenOptions(trigger, () => null)),
      );
    },
    focus: setFocused,
    hover: setHovered,
    openMenu: (ids, rect) => setMenu({ ids, rect }),
    recolour(color) {
      const id = colour;
      setColour(null);
      if (!id || !color) return;
      void store.recolor(id, color).catch((error: unknown) => fail(error, "Highlight wasn’t changed"));
    },
    closeComposer() {
      setComposer(null);
      store.refresh();
    },
    closeNoteEdit,
  };
}
