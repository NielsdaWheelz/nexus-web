"use client";

// What a reader does with a selection or a mark. A selection is not yet a
// resource: Highlight, Note, Ask, Learn and Share create its highlight first
// and continue with it; Link creates nothing until a target is confirmed.
// A mark's verbs arrive as this pane visit's entry, claimed once its marks load.
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
} from "@/lib/documentReader/DocumentReader";
import type { HighlightColor } from "@/lib/documentReader/model";
import { artifactPaneHref, learnDossier } from "@/lib/dossiers/dossierApi";
import { useLinkComposerHost } from "@/lib/actions/ResourceActionsProvider";
import { requirePaneRuntime, usePaneEntryDelivery, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { useShareController } from "@/lib/sharing/controller";
import { anchoredShareOpenOptions } from "@/lib/sharing/openOptions";
import { resourceShareTarget } from "@/lib/sharing/targets";
import type { Reader } from "@/lib/documentReader/runtime";
import { useSelectionComposer, type SelectionComposer } from "./useSelectionComposer";
import type { AnnotationStore } from "./annotations";

export interface AnnotationVerbs {
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
  onSelection(capture: SelectionCapture): void;
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
  const { activateTarget } = requirePaneRuntime(usePaneRuntime(), "useAnnotationVerbs");
  const feedback = useFeedback();
  const { openShare } = useShareController();
  const [menu, setMenu] = useState<AnnotationVerbs["menu"]>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
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

  const composer = useSelectionComposer({ mediaId, reader, annotations: store, active, onError: fail });
  const { highlightDeleted } = composer;
  const withHighlight = composer.ensure;

  // Resource actions target this visit; no other mounted reader may consume them.
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
          () => {
            setFocused((current) => current === id ? null : current);
            highlightDeleted(id);
          },
          (error: unknown) => fail(error, "Highlight wasn’t deleted"),
        );
    }
  }, [claim, delivery, fail, feedback, highlightDeleted, marks, openEvidence, store]);

  const closeNoteEdit = useCallback(() => {
    setNoteEdit(null);
    store.refresh();
  }, [store]);

  if (defect) throw defect.error;
  return {
    menu,
    composer,
    focused,
    hovered,
    recolouring: colour,
    noteEdit,
    choosingChat,
    onSelection(next) {
      const id = bounds.current;
      if (id && next.anchor.kind === "text") {
        bounds.current = null;
        void store.rebound(id, next.anchor).catch((error: unknown) => fail(error, "Highlight wasn’t changed"));
        return;
      }
      composer.select(next);
      setMenu(null);
    },
    onMarks(event) {
      if (event.kind === "hover") return setHovered(event.ids[0] ?? null);
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
        feedback.publish({ kind: "Hud", key: `learn:${id}`, content: { tone: "Neutral", title: "Creating dossier…" } });
        try {
          const outcome = await learnDossier(`highlight:${id}`, createRandomId("learn-dossier"));
          feedback.resolve(`learn:${id}`);
          const open = () => activateTarget({
            target: { href: artifactPaneHref(outcome.artifact_ref), labelHint: "Dossier" },
            disposition: { kind: "Adopt" },
          });
          if (isCurrent()) open();
          else feedback.publish({ kind: "Hud", content: { tone: "Success", title: "dossier created." }, actions: [{ label: "open dossier", onClick: open }] });
        } catch (error) {
          feedback.resolve(`learn:${id}`);
          fail(error, "Dossier couldn’t be created");
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
      if (!id || !color) return;
      void store.recolor(id, color).catch((error: unknown) => fail(error, "Highlight wasn’t changed"));
    },
    closeNoteEdit,
  };
}
