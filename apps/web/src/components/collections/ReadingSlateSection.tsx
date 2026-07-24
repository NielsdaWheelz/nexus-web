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
import { presentSlateItem } from "@/lib/resonance/presentSlateItem";
import {
  readingSlateErrorMessage,
  useReadingSlate,
  type ReadingSlateAccept,
  type ReadingSlateDestination,
  type ReadingSlateState,
} from "@/lib/resonance/useReadingSlate";
import { findPaneChromeFocusTarget } from "@/lib/workspace/paneDom";
import styles from "./ReadingSlateSection.module.css";

function assertNever(value: never): never {
  throw new Error(`Unhandled Reading Slate variant: ${JSON.stringify(value)}`);
}

function shouldMoveTerminalFocusToPaneChrome(
  isActive: boolean,
  section: HTMLElement | null,
  activeElement: Element | null,
): boolean {
  return isActive && section?.contains(activeElement) === true;
}

function rowsForState(state: ReadingSlateState): CollectionRowView[] {
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
      return state.items.map(presentSlateItem);
    case "Refilling":
    case "RefillFailed":
      return state.survivors.map(presentSlateItem);
    default:
      return assertNever(state);
  }
}

function isBusy(state: ReadingSlateState): boolean {
  return (
    state.kind === "InitialLoading" ||
    state.kind === "Refreshing" ||
    state.kind === "Adding" ||
    state.kind === "Refilling"
  );
}

function addControlsDisabled(state: ReadingSlateState): boolean {
  return (
    state.kind === "Adding" ||
    state.kind === "AddUnknown" ||
    state.kind === "Refilling" ||
    state.kind === "RefillFailed"
  );
}

function stateNotice(state: ReadingSlateState) {
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
          <span>{readingSlateErrorMessage("refresh", state.error)}</span>
          <Button variant="ghost" size="sm" onClick={state.retry}>
            Retry
          </Button>
        </div>
      );
    case "AddFailed":
      return (
        <p className={styles.alert} role="alert">
          {readingSlateErrorMessage("add", state.error)}
        </p>
      );
    case "AddUnknown":
      return state.recovery.kind === "Local" ? (
        <div className={styles.alert} role="alert">
          <span>{readingSlateErrorMessage("unknown", state.error)}</span>
          <Button variant="ghost" size="sm" onClick={state.recovery.retry}>
            Retry
          </Button>
        </div>
      ) : (
        <p className={styles.quietNotice}>
          {readingSlateErrorMessage("unknown", state.error)}
        </p>
      );
    case "RefillFailed":
      return (
        <div className={styles.quietNotice}>
          <span>{readingSlateErrorMessage("refill", state.error)}</span>
          <Button variant="ghost" size="sm" onClick={state.retry}>
            Retry
          </Button>
        </div>
      );
    default:
      return assertNever(state);
  }
}

export default function ReadingSlateSection({
  destination,
  paneId,
  isActive,
  accept,
  returnScope,
}: {
  destination: ReadingSlateDestination;
  paneId: string;
  isActive: boolean;
  accept: ReadingSlateAccept;
  returnScope: string;
}) {
  const reactId = useId();
  const sectionId = `reading-slate-${reactId.replaceAll(":", "")}`;
  const controller = useReadingSlate({ destination, isActive, accept });
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
  const title =
    destination.kind === "Lectern" ? "At hand" : "Suggested for this library";
  const ariaLabel =
    destination.kind === "Lectern"
      ? "At hand suggestions"
      : `Suggestions for ${destination.name}`;
  const terminalEmpty = state.kind === "Ready" && state.items.length === 0;
  const [terminalHidden, setTerminalHidden] = useState(false);
  const rendersSection = !terminalEmpty || !terminalHidden;
  // Keep only this destination's previous rows through the terminal layout
  // handoff. That leaves focused DOM connected until pane chrome owns focus,
  // while a destination change can never resurrect another slate's rows.
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
    if (
      shouldMoveTerminalFocusToPaneChrome(isActive, section, activeElement) ||
      (isActive &&
        pendingFocusRequest &&
        (activeElement === null || activeElement === document.body))
    ) {
      if (pendingFocusRequest) {
        handledFocusRequestRef.current = controller.focusRequest;
      }
      findPaneChromeFocusTarget(paneId)?.focus();
    }
    setTerminalHidden(true);
  }, [
    isActive,
    controller.focusRequest,
    paneId,
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
      const loading =
        state.kind === "Adding" && state.acceptedRef === item.target.ref;
      const accessibleName =
        destination.kind === "Lectern"
          ? `Add ${item.target.title} to Lectern`
          : `Add ${item.target.title} to ${destination.name}`;
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
                "Reading Slate Add control must be contained by its collection row.",
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
          {destination.kind === "Lectern" ? "Add to Lectern" : "Add"}
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
          <span>{readingSlateErrorMessage("initial", state.error)}</span>
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
            <PaneLoadingState label={`Loading ${ariaLabel}…`} />
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
