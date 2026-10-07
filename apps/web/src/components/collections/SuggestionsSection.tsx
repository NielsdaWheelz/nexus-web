"use client";

import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import CollectionView from "@/components/collections/CollectionView";
import Button from "@/components/ui/Button";
import PaneSection from "@/components/ui/PaneSection";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import type { CollectionRowView } from "@/lib/collections/types";
import { usePaneReturnDescendantReady } from "@/lib/panes/paneRuntime";
import { presentSuggestionItem } from "@/lib/suggestions/presentSuggestionItem";
import {
  suggestionsErrorMessage,
  useSuggestions,
  type SuggestionsAccept,
  type SuggestionsDestination,
  type SuggestionsState,
} from "@/lib/suggestions/useSuggestions";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { usePaneChromeFocusReturn } from "@/lib/workspace/mobileChrome";
import { findPaneChromeFocusTarget } from "@/lib/workspace/paneDom";
import { assertNever } from "@/lib/assertNever";
import styles from "./SuggestionsSection.module.css";

function shouldMoveTerminalFocusToPaneChrome(
  isActive: boolean,
  section: HTMLElement | null,
  activeElement: Element | null,
): boolean {
  return isActive && section?.contains(activeElement) === true;
}

function rowsForState(state: SuggestionsState): CollectionRowView[] {
  switch (state.kind) {
    case "InitialLoading":
    case "InitialFailed":
      return [];
    case "Ready":
    case "Refreshing":
    case "RefreshFailed":
    case "Adding":
    case "AddFailed":
    case "AddUnknown":
      return state.items.map(presentSuggestionItem);
    case "Refilling":
    case "RefillFailed":
      return state.survivors.map(presentSuggestionItem);
    default:
      return assertNever(state);
  }
}

function isBusy(state: SuggestionsState): boolean {
  return (
    state.kind === "InitialLoading" ||
    state.kind === "Refreshing" ||
    state.kind === "Adding" ||
    state.kind === "Refilling"
  );
}

function addControlsDisabled(state: SuggestionsState): boolean {
  return (
    state.kind === "Adding" ||
    state.kind === "AddUnknown" ||
    state.kind === "Refilling" ||
    state.kind === "RefillFailed"
  );
}

function stateNotice(state: SuggestionsState) {
  switch (state.kind) {
    case "InitialLoading":
    case "InitialFailed":
    case "Ready":
    case "Refreshing":
    case "Adding":
    case "Refilling":
      return null;
    case "RefreshFailed":
      return (
        <div className={styles.quietNotice}>
          <span>{suggestionsErrorMessage("refresh", state.error)}</span>
          <Button variant="ghost" size="sm" onClick={state.retry}>
            Retry
          </Button>
        </div>
      );
    case "AddFailed":
      return (
        <p className={styles.alert} role="alert">
          {suggestionsErrorMessage("add", state.error)}
        </p>
      );
    case "AddUnknown":
      return state.recovery.kind === "Local" ? (
        <div className={styles.alert} role="alert">
          <span>{suggestionsErrorMessage("unknown", state.error)}</span>
          <Button variant="ghost" size="sm" onClick={state.recovery.retry}>
            Retry
          </Button>
        </div>
      ) : (
        <p className={styles.quietNotice}>
          {suggestionsErrorMessage("unknown", state.error)}
        </p>
      );
    case "RefillFailed":
      return (
        <div className={styles.quietNotice}>
          <span>{suggestionsErrorMessage("refill", state.error)}</span>
          <Button variant="ghost" size="sm" onClick={state.retry}>
            Retry
          </Button>
        </div>
      );
    default:
      return assertNever(state);
  }
}

export default function SuggestionsSection({
  destination,
  paneId,
  isActive,
  accept,
  returnScope,
}: {
  destination: SuggestionsDestination;
  paneId: string;
  isActive: boolean;
  accept: SuggestionsAccept;
  returnScope: string;
}) {
  const reactId = useId();
  const sectionId = `suggestions-${reactId.replaceAll(":", "")}`;
  const controller = useSuggestions({ destination, isActive, accept });
  const isMobile = useIsMobileViewport();
  const { focus: returnPaneChromeFocus } = usePaneChromeFocusReturn();
  const { state } = controller;
  const returnReadyRootRef = useRef<HTMLDivElement>(null);
  usePaneReturnDescendantReady({
    rootRef: returnReadyRootRef,
    ready: state.kind !== "InitialLoading",
  });
  const activeRef = useRef(isActive);
  activeRef.current = isActive;
  const handledFocusRequestRef = useRef<typeof controller.focusRequest>(null);
  const rows = rowsForState(state);
  const rowOwnerKey =
    destination.kind === "Lectern" ? "Lectern" : `Library:${destination.id}`;
  const retainedRowsRef = useRef<{
    ownerKey: string;
    rows: CollectionRowView[];
  }>({ ownerKey: rowOwnerKey, rows: [] });
  const title = "Suggestions";
  const ariaLabel =
    destination.kind === "Lectern"
      ? "Suggestions for Lectern"
      : `Suggestions for ${destination.name}`;
  const terminalEmpty = state.kind === "Ready" && state.items.length === 0;
  const [terminalHidden, setTerminalHidden] = useState(false);
  const rendersSection = !terminalEmpty || !terminalHidden;
  // Keep only this destination's previous rows through the terminal layout
  // handoff. That leaves focused DOM connected until pane chrome owns focus,
  // while a destination change can never resurrect another suggestions's rows.
  const renderedRows =
    terminalEmpty && retainedRowsRef.current.ownerKey === rowOwnerKey
      ? retainedRowsRef.current.rows
      : rows;

  useLayoutEffect(() => {
    if (!terminalEmpty) {
      retainedRowsRef.current = { ownerKey: rowOwnerKey, rows };
      if (terminalHidden) setTerminalHidden(false);
      return;
    }
    if (terminalHidden) return;
    const section = document.getElementById(sectionId);
    const pendingFocusRequest =
      controller.focusRequest !== null &&
      handledFocusRequestRef.current !== controller.focusRequest;
    const activeElement = document.activeElement;
    const shouldReturnFocus =
      shouldMoveTerminalFocusToPaneChrome(isActive, section, activeElement) ||
      (isActive &&
        pendingFocusRequest &&
        (activeElement === null || activeElement === document.body));
    if (shouldReturnFocus) {
      if (pendingFocusRequest) {
        handledFocusRequestRef.current = controller.focusRequest;
      }
      if (!isMobile) {
        findPaneChromeFocusTarget(paneId)?.focus();
        setTerminalHidden(true);
        return;
      }
      let live = true;
      void returnPaneChromeFocus(paneId).then(() => {
        if (live) setTerminalHidden(true);
      });
      return () => {
        live = false;
      };
    }
    setTerminalHidden(true);
  }, [
    isActive,
    controller.focusRequest,
    isMobile,
    paneId,
    returnPaneChromeFocus,
    rowOwnerKey,
    rows,
    sectionId,
    terminalEmpty,
    terminalHidden,
  ]);

  useLayoutEffect(() => {
    const request = controller.focusRequest;
    if (request === null || handledFocusRequestRef.current === request) {
      return;
    }
    // A request is one-shot even when the pane is inactive. Reactivating a
    // pane must never replay focus repair from an earlier Add.
    handledFocusRequestRef.current = request;
    if (!isActive) return;

    const { survivorRef } = request;
    const section = document.getElementById(sectionId);
    if (!section) return;
    if (!activeRef.current) return;
    if (
      document.activeElement !== null &&
      document.activeElement !== document.body
    ) {
      return;
    }
    if (survivorRef === null) {
      section.focus();
      return;
    }
    const row = Array.from(
      section.querySelectorAll<HTMLElement>("[data-collection-row-id]"),
    ).find((candidate) => candidate.dataset.collectionRowId === survivorRef);
    (
      row?.querySelector<HTMLElement>("[data-row-focusable]") ?? section
    ).focus();
  }, [controller.focusRequest, isActive, sectionId]);

  const controls = useMemo(() => {
    const byRef: Record<string, ReactNode> = {};
    const disabled = addControlsDisabled(state);
    const items =
      state.kind === "Refilling" || state.kind === "RefillFailed"
        ? state.survivors
        : state.kind === "InitialLoading" || state.kind === "InitialFailed"
          ? []
          : state.items;
    for (const item of items) {
      const title = item.target.kind === "Media"
        ? item.target.mediaSummary.title
        : item.target.title;
      const loading =
        state.kind === "Adding" && state.acceptedRef === item.target.ref;
      const accessibleName =
        destination.kind === "Lectern"
          ? `Add ${title} to Lectern`
          : `Add ${title} to ${destination.name}`;
      byRef[item.target.ref] = (
        <Button
          variant="secondary"
          size="sm"
          aria-label={accessibleName}
          disabled={disabled}
          loading={loading}
          onClick={(event) => {
            const originatingRow = event.currentTarget.closest<HTMLElement>(
              "[data-collection-row-id]",
            );
            if (originatingRow === null) {
              throw new Error(
                "Suggestions Add control must be contained by its collection row.",
              );
            }
            const focusWasOwnedAtAdd =
              document.activeElement !== null &&
              originatingRow.contains(document.activeElement);
            controller.add(item, {
              // Evaluated by the controller immediately before successful
              // removal. Disabling the pressed button may itself drop focus
              // to body; preserve that owned interaction while still honoring
              // a deliberate move to another meaningful target.
              isFocusOwned: () => {
                const activeElement = document.activeElement;
                return (
                  focusWasOwnedAtAdd &&
                  originatingRow.isConnected &&
                  (activeElement === null ||
                    activeElement === document.body ||
                    originatingRow.contains(activeElement))
                );
              },
            });
          }}
        >
          {destination.kind === "Lectern" ? "Add to Lectern" : `Add to ${destination.name}`}
        </Button>
      );
    }
    return byRef;
  }, [controller, destination, state]);

  let content: ReactNode = null;
  if (state.kind === "InitialFailed") {
    content = (
      <PaneSection
        id={sectionId}
        aria-label={ariaLabel}
        tabIndex={-1}
        title={title}
      >
        <div className={styles.quietNotice}>
          <span>{suggestionsErrorMessage("initial", state.error)}</span>
          <Button variant="ghost" size="sm" onClick={state.retry}>
            Retry
          </Button>
        </div>
      </PaneSection>
    );
  } else if (
    !(state.kind === "InitialLoading" && destination.kind === "Library") &&
    rendersSection
  ) {
    content = (
      <PaneSection
        id={sectionId}
        aria-label={ariaLabel}
        tabIndex={-1}
        title={title}
        aria-busy={isBusy(state) || undefined}
      >
        {state.kind === "InitialLoading" ? (
          <div className={styles.loading}>
            <PaneLoadingState
              label={`Loading ${ariaLabel}…`}
              announcement="Polite"
            />
          </div>
        ) : (
          <CollectionView
            returnScope={returnScope}
            rows={renderedRows}
            status="ready"
            ariaLabel={ariaLabel}
            notice={stateNotice(state)}
            rowControls={controls}
            surface={false}
          />
        )}
      </PaneSection>
    );
  }

  return (
    <div ref={returnReadyRootRef} style={{ display: "contents" }}>
      {content}
    </div>
  );
}
