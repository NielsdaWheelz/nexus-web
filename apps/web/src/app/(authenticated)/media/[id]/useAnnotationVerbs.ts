"use client";

// What a reader does with a selection or a mark. A selection is not yet a
// resource: highlight, note and share create its highlight first
// and continue with it; Link creates nothing until a target is confirmed.
// Mobile observations remain provisional: only explicit frozen-capture commands
// prepare authoring. A quiet range owns no draft, journal or chat destination.
// A mark's verbs arrive as this pane visit's entry, claimed once its marks load.
// An unresolved quote enters the same bounds session from its evidence row;
// relocation keeps its owner, quote and note, with the mounted generation fenced.
import { useCallback, useEffect, useRef, useState } from "react";
import { type FeedbackContent } from "@/components/feedback/Feedback";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { createRandomId } from "@/lib/createRandomId";
import {
  useReaderState,
  type Mark,
  type MarkEvent,
  type SelectionEvent,
  type SelectionCapture,
  type SelectionNotice,
} from "@/lib/documentReader/DocumentReader";
import type { HighlightColor } from "@/lib/documentReader/model";
import { requirePaneRuntime, usePaneEntryDelivery, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { useShareController } from "@/lib/sharing/controller";
import { anchoredShareOpenOptions } from "@/lib/sharing/openOptions";
import { resourceShareTarget } from "@/lib/sharing/targets";
import { useOverlay } from "@/lib/ui/overlay";
import type { Reader } from "@/lib/documentReader/runtime";
import { useSelectionComposer, type SelectionComposer } from "./useSelectionComposer";
import type { AnnotationStore } from "./annotations";
import { samePassage } from "./selectionDrafts";

const MOBILE_SELECTION_QUIET_MS = 250;

export interface MobileSelection {
  readonly id: string;
  readonly capture: SelectionCapture;
  readonly highlightId: string | null;
}

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
  readonly selectionIssue: string | null;
  readonly bounds: BoundsSession | null;
  cancelBounds(): void;
  relocate(id: string): void;
  readonly mobileSelection: MobileSelection | null;
  readonly selectionVisible: boolean;
  captureSelection(): MobileSelection | null;
  ownSelectionFocus(subject: MobileSelection): boolean;
  cancelSelectionActivation(): void;
  selectionCurrent(subject: MobileSelection): boolean;
  dismissSelection(): void;
  composeSelection(subject: MobileSelection, mode: "Note" | "Ask"): void;
  highlightSelection(subject: MobileSelection, color: HighlightColor): void;
  shareSelection(subject: MobileSelection, trigger: HTMLElement | null): void;
  applySelection(subject: MobileSelection): void;
  onSelection(notice: SelectionNotice): void;
  onMarks(event: MarkEvent): void;
  highlight(color: HighlightColor): void;
  share(trigger: HTMLElement | null): void;
  focus(id: string | null): void;
  hover(id: string | null): void;
  chooseMark(id: string): void;
  closeMenu(): void;
  recolour(color: HighlightColor | null): void;
  closeNoteEdit(): void;
}

export function useAnnotationVerbs(input: {
  readonly reader: Reader;
  readonly active: boolean;
  readonly isMobile: boolean;
  readonly store: AnnotationStore;
  /** The marks mounted in the reader; pane entries wait for their first load. */
  readonly marks: readonly Mark[] | null;
  readonly openEvidence: (itemId: string | null) => void;
}): AnnotationVerbs {
  const { reader, active, isMobile, store, marks, openEvidence } = input;
  const [notice, setNotice] = useState<FeedbackContent | null>(null);
  const { closeSecondaryPane } = requirePaneRuntime(usePaneRuntime(), "useAnnotationVerbs");
  const { openShare } = useShareController();
  const [menu, setMenu] = useState<AnnotationVerbs["menu"]>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [noteEdit, setNoteEdit] = useState<AnnotationVerbs["noteEdit"]>(null);
  const [colour, setColour] = useState<string | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const [selectionIssue, setSelectionIssue] = useState<string | null>(null);
  const [bounds, setBounds] = useState<BoundsSession | null>(null);
  const currentBounds = useRef<BoundsSession | null>(null);
  const [mobileSelection, setMobileSelection] = useState<MobileSelection | null>(null);
  const [selectionVisible, setSelectionVisible] = useState(false);
  const candidate = useRef<MobileSelection | null>(null);
  const activation = useRef<MobileSelection | null>(null);
  const quietTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputHeld = useRef(false);
  const mobileRef = useRef(isMobile);
  mobileRef.current = isMobile;
  const activeRef = useRef(active);
  activeRef.current = active;
  const documentState = useReaderState(reader, state => state.document);
  const publication = documentState.status === "ready" ? documentState.doc.identity : null;
  const clearQuiet = useCallback(() => {
    if (quietTimer.current !== null) clearTimeout(quietTimer.current);
    quietTimer.current = null;
  }, []);
  const retireSelection = useCallback(() => {
    clearQuiet();
    candidate.current = null; activation.current = null; inputHeld.current = false;
    setMobileSelection(null); setSelectionVisible(false);
  }, [clearQuiet]);
  // Admission changes synchronously, before another source event or queue completion.
  const showBounds = useCallback((next: BoundsSession | null) => { currentBounds.current = next; setBounds(next); }, []);
  const cancelBounds = useCallback(() => {
    if (currentBounds.current?.phase !== "Selecting") return;
    retireSelection();
    showBounds(null);
    setSelectionIssue(null);
    reader.focusSource();
  }, [reader, retireSelection, showBounds]);
  useOverlay(active && bounds !== null && bounds.identity === publication && bounds.phase === "Selecting", {
    kind: "transient",
    onDismiss: cancelBounds,
  });
  useEffect(() => {
    retireSelection();
    showBounds(null);
    setSelectionIssue(null);
  }, [active, isMobile, publication, retireSelection, showBounds]);
  useEffect(() => {
    if (documentState.status !== "ready" || documentState.refreshing) retireSelection();
  }, [documentState, retireSelection]);
  useEffect(() => {
    const retire = () => { retireSelection(); showBounds(null); setSelectionIssue(null); };
    const visibility = () => { if (document.visibilityState === "hidden") retire(); };
    window.addEventListener("blur", retire);
    document.addEventListener("visibilitychange", visibility);
    return () => { window.removeEventListener("blur", retire); document.removeEventListener("visibilitychange", visibility); };
  }, [retireSelection, showBounds]);
  useEffect(() => () => { clearQuiet(); candidate.current = null; activation.current = null; currentBounds.current = null; activeRef.current = false; }, [clearQuiet]);

  const fail = useCallback(
    (error: unknown, title: string) => {
      if (handleUnauthenticatedApiError(error)) return;
      if (!isApiError(error) || isSameSystemApiDefect(error)) return setDefect({ error });
      setNotice({ tone: "Danger", title, requestId: error.requestId });
    },
    [],
  );

  const composer = useSelectionComposer({ reader, annotations: store, active, isMobile, onError: fail });
  const { highlightDeleted } = composer;
  const withHighlight = composer.ensure;
  const recolouringHighlight = colour ? store.highlight(colour) : null;
  useEffect(() => {
    const shown = candidate.current;
    if (!shown) return;
    const highlightId = store.twin(shown.capture.anchor);
    if (highlightId === shown.highlightId) return;
    if (activation.current) return retireSelection();
    const next = { ...shown, highlightId };
    candidate.current = next; setMobileSelection(next);
  }, [marks, store, retireSelection]);

  const currentSource = (capture: SelectionCapture) => {
    const shown = reader.getState().document;
    return activeRef.current && mobileRef.current && document.visibilityState !== "hidden" &&
      shown.status === "ready" && !shown.refreshing && shown.doc.identity === capture.identity && reader.measureBounds() !== null;
  };
  const selectionCurrent = (subject: MobileSelection) => activation.current === subject && currentSource(subject.capture);
  const consumeSelection = () => {
    clearQuiet(); candidate.current = null; setMobileSelection(null); setSelectionVisible(false);
  };
  const observeSelection = (capture: SelectionCapture, held: boolean) => {
    clearQuiet(); setSelectionVisible(false);
    const previous = candidate.current;
    const highlightId = store.twin(capture.anchor);
    const next = previous && samePassage(previous.capture, capture) && previous.capture.quote === capture.quote && previous.highlightId === highlightId
      ? previous : { id: previous?.id ?? createRandomId(), capture, highlightId };
    candidate.current = next; setMobileSelection(next);
    if (held) return;
    quietTimer.current = setTimeout(() => {
      quietTimer.current = null;
      if (candidate.current?.id !== next.id || inputHeld.current || !currentSource(next.capture)) return;
      const fresh = reader.captureSelection();
      if (!fresh || fresh.kind !== "Captured" || !currentSource(fresh) || !reader.measurePassage(fresh)) return retireSelection();
      const latest = candidate.current, saved = store.twin(fresh.anchor);
      const revealed = latest && samePassage(latest.capture, fresh) && latest.capture.quote === fresh.quote && latest.highlightId === saved
        ? latest : { id: next.id, capture: fresh, highlightId: saved };
      candidate.current = revealed; setMobileSelection(revealed); setSelectionVisible(true);
    }, MOBILE_SELECTION_QUIET_MS);
  };
  const rejectedSelection = (next: Extract<SelectionEvent, { kind: "Rejected" }>) => {
    const shown = reader.getState().document;
    setSelectionIssue(next.reason === "CrossUnit" ? (shown.status === "ready" && shown.doc.kind === "text" && shown.doc.units.some(unit => unit.xPost !== null)
      ? "select text within one post" : "select within one text section.") : "select within one pdf page.");
  };
  const validBounds = (session: BoundsSession, next: SelectionEvent): next is SelectionCapture & { anchor: Extract<SelectionCapture["anchor"], { kind: "text" }> } => {
    if (next.kind === "Rejected" || next.anchor.kind !== "text" || session.identity !== next.identity ||
      (session.unit !== null && next.anchor.unit !== session.unit) || store.source(next.anchor).mediaId !== session.mediaId) {
      showBounds({ ...session, issue: session.unit === null
        ? "select matching text within the highlight’s original document."
        : "select within the same text section as this highlight." });
      return false;
    }
    return true;
  };
  const applyBounds = (session: BoundsSession, next: SelectionEvent) => {
    if (!validBounds(session, next)) return;
    const submitted: BoundsSession = { ...session, phase: "Submitting", issue: null };
    showBounds(submitted);
    const owns = () => {
      const shown = reader.getState().document;
      return activeRef.current && currentBounds.current?.id === submitted.id &&
        shown.status === "ready" && shown.doc.identity === submitted.identity;
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
            if (owns()) { showBounds(null); setSelectionIssue("this highlight changed. start again from its evidence row."); }
          } else if (owns()) showBounds({ ...submitted, phase: "Selecting",
            issue: "a highlight already covers that passage. select another passage or cancel." });
        } else {
          if (owns()) showBounds(null);
          fail(error, "Highlight wasn’t changed");
        }
      },
    );
  };
  const ensureSelection = async (subject: MobileSelection) => {
    const result = await composer.ensureCapture(subject.capture);
    return result ? { id: result.id, isCurrent: () => selectionCurrent(subject) && result.isCurrent() } : null;
  };

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
    retireSelection();
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
  }, [claim, composer, delivery, fail, highlightDeleted, marks, openEvidence, publication, reader, retireSelection, showBounds, store]);

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
    selectionIssue,
    bounds,
    cancelBounds,
    mobileSelection,
    selectionVisible: active && isMobile && selectionVisible,
    captureSelection() {
      const shown = candidate.current;
      if (!shown || !selectionVisible || inputHeld.current || !currentSource(shown.capture)) return null;
      const fresh = reader.captureSelection();
      if (!fresh || fresh.kind !== "Captured" || !currentSource(fresh)) { retireSelection(); return null; }
      if (!samePassage(shown.capture, fresh) || shown.capture.quote !== fresh.quote) {
        activation.current = null; observeSelection(fresh, inputHeld.current); return null;
      }
      const highlightId = store.twin(fresh.anchor);
      const captured = highlightId === shown.highlightId ? shown : { ...shown, highlightId };
      clearQuiet(); candidate.current = captured; activation.current = captured; setMobileSelection(captured);
      return captured;
    },
    ownSelectionFocus(subject) {
      if (candidate.current !== subject || !selectionVisible || inputHeld.current || !currentSource(subject.capture)) return false;
      clearQuiet(); activation.current = subject;
      return true;
    },
    cancelSelectionActivation() {
      activation.current = null;
      const fresh = reader.captureSelection();
      if (fresh?.kind === "Captured" && candidate.current && currentSource(fresh)) observeSelection(fresh, inputHeld.current);
      else retireSelection();
    },
    selectionCurrent,
    dismissSelection() {
      retireSelection(); composer.cancelReselection();
      if (currentBounds.current?.phase === "Selecting") showBounds(null);
      setSelectionIssue(null);
    },
    composeSelection(subject, mode) {
      if (!selectionCurrent(subject)) return;
      consumeSelection(); composer.compose(subject.capture, mode);
    },
    highlightSelection(subject, color) {
      if (!selectionCurrent(subject) || subject.highlightId && store.highlight(subject.highlightId)?.color === color) return;
      consumeSelection(); void composer.highlightCapture(subject.capture, color);
    },
    shareSelection(subject, trigger) {
      if (!selectionCurrent(subject)) return;
      consumeSelection();
      void ensureSelection(subject).then(result => {
        if (result?.isCurrent()) openShare(resourceShareTarget(`highlight:${result.id}`), anchoredShareOpenOptions(trigger, () => null));
      });
    },
    applySelection(subject) {
      if (!selectionCurrent(subject)) return;
      const session = currentBounds.current;
      if (session?.phase === "Selecting") { consumeSelection(); applyBounds(session, subject.capture); }
      else if (composer.reselection) { consumeSelection(); composer.applyReselection(subject.capture); }
    },
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
      retireSelection();
      composer.dismiss();
      setMenu(null);
      setSelectionIssue(null);
      showBounds({ id: createRandomId(), highlightId: id, mediaId: highlight.mediaId, identity: document.doc.identity,
        unit: null, version: highlight.version, phase: "Selecting", issue: null });
      closeSecondaryPane({ restoreFocus: false });
      reader.focusSource();
    },
    onSelection(notice) {
      if (!isMobile && notice.kind === "Observed") return;
      const shown = reader.getState().document;
      if (!active || shown.status !== "ready") return;
      const next = notice.selection;
      if (shown.refreshing || next && next.identity !== shown.doc.identity) {
        retireSelection(); setSelectionIssue("this post changed. select the passage again."); return;
      }
      const session = currentBounds.current;
      if (isMobile) {
        const held = notice.kind === "Observed" ? notice.inputHeld : inputHeld.current;
        inputHeld.current = held;
        if (reader.measureBounds() === null) { retireSelection(); return; }
        // Default focus may collapse the browser range after this control froze
        // it. Only source activity, cancellation or dismissal retires that press.
        const owned = activation.current;
        if (notice.kind === "Observed" && owned && !held && (next === null ||
          next.kind === "Captured" && samePassage(owned.capture, next) && owned.capture.quote === next.quote)) return;
        activation.current = null;
        if (!next) { retireSelection(); inputHeld.current = held; return; }
        if (session?.phase === "Submitting") { retireSelection(); return; }
        if (notice.kind === "Observed" && candidate.current === null) return;
        setSelectionIssue(null);
        if (next.kind === "Rejected") {
          retireSelection();
          if (session?.phase === "Selecting") validBounds(session, next); else rejectedSelection(next);
          return;
        }
        if (session?.phase === "Selecting") {
          if (!validBounds(session, next)) { retireSelection(); return; }
          if (session.issue) showBounds({ ...session, issue: null });
        }
        observeSelection(next, held);
        return;
      }
      if (!next) return;
      setSelectionIssue(null);
      if (session?.phase === "Selecting" && session.identity === next.identity) { applyBounds(session, next); return; }
      showBounds(null);
      if (next.kind === "Rejected") { composer.dismiss(); setMenu(null); rejectedSelection(next); return; }
      composer.select(next); setMenu(null);
    },
    onMarks(event) {
      if (event.kind === "hover") return setHovered(event.ids[0] ?? null);
      if (currentBounds.current?.phase === "Selecting") return;
      retireSelection();
      showBounds(null);
      setSelectionIssue(null);
      setFocused(event.marks[0]?.id ?? null);
      if (event.marks.length > 1) setMenu(event);
      else if (event.marks[0]) composer.activate(event.marks[0], event.identity, event.input !== "touch");
    },
    highlight: (color) => composer.highlight(color),
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
