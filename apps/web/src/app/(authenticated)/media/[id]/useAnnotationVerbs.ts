"use client";

// What a reader does with a selection or a mark. A selection is not yet a
// resource: highlight, note and share create a new independent highlight and
// continue with it; overlapping or identical extents never reuse another one.
// Mobile observations remain provisional: only explicit frozen-capture commands
// prepare authoring. A mark's verbs arrive as this pane visit's entry, claimed
// once its marks load. Resizing and relocation replace one highlight's whole
// selection capture locally; its identity, colour and notes stay.
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
import { captureSelection, recolorHighlight, resizeHighlight, type SourceLabel } from "@/lib/documentReader/annotations";
import { deleteResource } from "@/lib/resourceGraph/links";
import type { HighlightColor } from "@/lib/documentReader/model";

import { useWritingRuntime } from "@/lib/notes/hooks";
import { LocalCommitError } from "@/lib/notes/runtime";
import { normalizeQuote } from "@nexus/authored/identity";
import { requirePaneRuntime, usePaneEntryDelivery, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { useShareController } from "@/lib/sharing/controller";
import { anchoredShareOpenOptions } from "@/lib/sharing/openOptions";
import { resourceShareTarget } from "@/lib/sharing/targets";
import { useOverlay } from "@/lib/ui/overlay";
import type { Reader } from "@/lib/documentReader/runtime";
import { useSelectionComposer, type SelectionComposer } from "./useSelectionComposer";
import type { MediaAnnotations } from "./annotations";
import { samePassage } from "./selectionDrafts";

const MOBILE_SELECTION_QUIET_MS = 250;

export interface MobileSelection {
  readonly id: string;
  readonly capture: SelectionCapture;
}

interface BoundsSession {
  readonly id: string;
  readonly highlightId: string;
  readonly identity: string;
  /** Where the new extent must fall: its text section, its pdf page, or (relocation) anywhere matching its quote. */
  readonly scope: { readonly kind: "unit"; readonly unit: string } | { readonly kind: "page"; readonly page: number } | { readonly kind: "quote" };
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
  /** A highlight whose attached notes the Evidence row should focus. */
  readonly noteEdit: { readonly id: string; readonly request: number } | null;
  readonly selectionIssue: string | null;
  readonly bounds: BoundsSession | null;
  cancelBounds(): void;
  editBounds(id: string): void;
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
  remove(id: string): void;
  closeNoteEdit(): void;
}

export function useAnnotationVerbs(input: {
  readonly reader: Reader;
  readonly mediaId: string;
  readonly sourceLabel: (sourceRef: string) => SourceLabel | null;
  readonly active: boolean;
  readonly isMobile: boolean;
  readonly store: MediaAnnotations;
  /** The marks mounted in the reader; pane entries wait for their first load. */
  readonly marks: readonly Mark[] | null;
  readonly openEvidence: (itemId: string | null) => void;
}): AnnotationVerbs {
  const { reader, mediaId, sourceLabel, active, isMobile, store, marks, openEvidence } = input;
  const writing = useWritingRuntime();
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
  // Admission changes synchronously, before another source event or commit completion.
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
      // an uncommitted local frame is retried from the pane's writing error notice.
      if (error instanceof LocalCommitError) return;
      if (isApiError(error) && isSameSystemApiDefect(error)) return setDefect({ error });
      // any other local failure committed nothing: say so and keep the reader usable.
      setNotice(isApiError(error) ? { tone: "Danger", title, requestId: error.requestId } : { tone: "Danger", title, message: "nothing was saved. try again." });
    },
    [],
  );

  const composer = useSelectionComposer({ reader, mediaId, annotations: store, sourceLabel, active, isMobile, onError: fail });
  const { highlightDeleted } = composer;
  const withHighlight = composer.ensure;

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
    const next = previous && samePassage(previous.capture, capture) && previous.capture.quote === capture.quote
      ? previous : { id: previous?.id ?? createRandomId(), capture };
    candidate.current = next; setMobileSelection(next);
    if (held) return;
    quietTimer.current = setTimeout(() => {
      quietTimer.current = null;
      if (candidate.current?.id !== next.id || inputHeld.current || !currentSource(next.capture)) return;
      const fresh = reader.captureSelection();
      if (!fresh || fresh.kind !== "Captured" || !currentSource(fresh) || !reader.measurePassage(fresh)) return retireSelection();
      const latest = candidate.current;
      const revealed = latest && samePassage(latest.capture, fresh) && latest.capture.quote === fresh.quote
        ? latest : { id: next.id, capture: fresh };
      candidate.current = revealed; setMobileSelection(revealed); setSelectionVisible(true);
    }, MOBILE_SELECTION_QUIET_MS);
  };
  const rejectedSelection = (next: Extract<SelectionEvent, { kind: "Rejected" }>) => {
    const shown = reader.getState().document;
    setSelectionIssue(next.reason === "CrossUnit" ? (shown.status === "ready" && shown.doc.kind === "text" && shown.doc.units.some(unit => unit.xPost !== null)
      ? "select text within one post" : "select within one text section.") : "select within one pdf page.");
  };
  /** The new extent's exact capture, when it may replace this highlight's selection. */
  const boundsCapture = (session: BoundsSession, next: SelectionEvent) => {
    const annotation = store.annotation(session.highlightId);
    const shown = reader.getState().document;
    const capture = next.kind === "Captured" && annotation && shown.status === "ready" && shown.doc.identity === next.identity
      ? captureSelection(shown.doc, mediaId, next.anchor) : null;
    const scope = session.scope;
    const fits = next.kind === "Captured" && capture !== null && capture.sourceRef === annotation?.sourceRef && session.identity === next.identity && (
      scope.kind === "unit" ? next.anchor.kind === "text" && next.anchor.unit === scope.unit
        : scope.kind === "page" ? next.anchor.kind === "pdf" && next.anchor.page === scope.page
          : normalizeQuote(capture.selection.quote_exact) === normalizeQuote(annotation.selection.quote_exact));
    if (fits) return { annotation: annotation!, capture: capture! };
    showBounds({ ...session, issue: scope.kind === "quote"
      ? "select text matching the original quote. the quote and note will stay unchanged."
      : scope.kind === "page" ? "select within the same pdf page as this highlight." : "select within the same text section as this highlight." });
    return null;
  };
  const applyBounds = (session: BoundsSession, next: SelectionEvent) => {
    const admitted = boundsCapture(session, next);
    if (!admitted || !writing) return;
    // relocation moves the location only: the saved literal quote stays exactly as written.
    const capture = session.scope.kind === "quote"
      ? { ...admitted.capture, selection: { ...admitted.capture.selection, quote_exact: admitted.annotation.selection.quote_exact } } : admitted.capture;
    const submitted: BoundsSession = { ...session, phase: "Submitting", issue: null };
    showBounds(submitted);
    const owns = () => activeRef.current && currentBounds.current?.id === submitted.id;
    void resizeHighlight(writing, admitted.annotation, capture).then(
      () => { if (owns()) showBounds(null); },
      (error: unknown) => { if (owns()) showBounds(null); fail(error, "highlight wasn’t changed"); },
    );
  };
  const ensureSelection = async (subject: MobileSelection) => {
    const result = await composer.ensureCapture(subject.capture);
    return result ? { id: result.id, isCurrent: () => selectionCurrent(subject) && result.isCurrent() } : null;
  };
  const startBounds = useCallback((id: string, scope: BoundsSession["scope"]) => {
    if (!publication) return;
    retireSelection();
    composer.dismiss();
    setMenu(null);
    setSelectionIssue(null);
    showBounds({ id: createRandomId(), highlightId: id, identity: publication, scope, phase: "Selecting", issue: null });
    setFocused(id);
    reader.focusSource();
  }, [composer, publication, reader, retireSelection, showBounds]);
  const editBounds = useCallback((id: string) => {
    const annotation = store.annotation(id);
    if (annotation?.placement.kind !== "placed") { setNotice({ tone: "Neutral", title: "this highlight isn’t shown in this version" }); return; }
    const anchor = annotation.placement.anchor;
    startBounds(id, anchor.kind === "text" ? { kind: "unit", unit: anchor.unit } : { kind: "page", page: anchor.page });
  }, [startBounds, store]);
  const remove = useCallback((id: string) => {
    const annotation = store.annotation(id);
    if (!annotation || !writing) return;
    void deleteResource(writing, { ref: annotation.ref }).then(
      () => { setFocused((current) => current === id ? null : current); highlightDeleted(id); },
      (error: unknown) => fail(error, "highlight wasn’t deleted"),
    );
  }, [fail, highlightDeleted, store, writing]);

  // Resource actions target this visit; no other mounted reader may consume them.
  const { delivery, claim } = usePaneEntryDelivery();
  useEffect(() => {
    if (delivery === null || !("highlightId" in delivery.entry) || marks === null) return;
    if (!claim(delivery)) return;
    const { entry } = delivery;
    const id = entry.highlightId;
    if (!store.annotation(id)) return setNotice({ tone: "Neutral", title: "this highlight is no longer available" });
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
        setNoteEdit((current) => ({ id, request: (current?.request ?? 0) + 1 }));
        return openEvidence(id);
      case "EditHighlightBounds":
        return editBounds(id);
      case "DeleteHighlight":
        return remove(id);
    }
  }, [claim, delivery, editBounds, marks, openEvidence, remove, retireSelection, showBounds, store]);

  const closeNoteEdit = useCallback(() => setNoteEdit(null), []);

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
    editBounds,
    remove,
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
      clearQuiet(); candidate.current = shown; activation.current = shown; setMobileSelection(shown);
      return shown;
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
      if (!selectionCurrent(subject)) return;
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
      const annotation = store.annotation(id);
      if (!active || document.status !== "ready" || document.refreshing || document.doc.kind !== "text" || annotation?.placement.kind !== "unlocated") {
        setNotice({ tone: "Neutral", title: "open this highlight’s source text before relocating it." });
        return;
      }
      startBounds(id, { kind: "quote" });
      closeSecondaryPane({ restoreFocus: false });
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
          if (session?.phase === "Selecting") boundsCapture(session, next); else rejectedSelection(next);
          return;
        }
        if (session?.phase === "Selecting") {
          if (!boundsCapture(session, next)) { retireSelection(); return; }
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
      const only = event.marks.length === 1 ? event.marks[0] : null;
      if (!only) { if (event.marks.length) setMenu(event); return; }
      // library members' highlights are read-only server evidence.
      if (store.annotation(only.id)) composer.activate(only, event.identity, event.input !== "touch");
      else openEvidence(only.id);
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
      if (mark && menu) {
        if (store.annotation(id)) composer.activate(mark, menu.identity, menu.input !== "touch");
        else openEvidence(id);
      }
      setMenu(null);
    },
    closeMenu: () => setMenu(null),
    recolour(color) {
      const id = colour;
      setColour(null);
      const annotation = id ? store.annotation(id) : null;
      if (!annotation || !color || !writing) return;
      void recolorHighlight(writing, annotation, color).catch((error: unknown) => fail(error, "highlight wasn’t changed"));
    },
    closeNoteEdit,
  };
}
