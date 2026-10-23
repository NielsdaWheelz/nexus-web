"use client";

import { forwardRef, useId, useImperativeHandle, useRef, type ReactNode } from "react";
import { ChevronDown, ChevronUp, RotateCcw, TextSearch, X } from "lucide-react";
import CollectionView from "@/components/collections/CollectionView";
import Button from "@/components/ui/Button";
import ChoiceField from "@/components/ui/ChoiceField";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import type { CollectionRowView } from "@/lib/collections/types";
import { FIND_LIMIT } from "@/lib/find/find";
import type { FindController, FindResult } from "@/lib/find/useFind";
import styles from "./Find.module.css";

function findFeedback(result: FindResult | null): {
  readonly placement: "Inline" | "Details";
  readonly content: ReactNode;
  readonly description: string;
} | null {
  if (result === null)
    return { placement: "Inline", content: "Not ready", description: "Find is not ready." };
  switch (result.kind) {
    case "Idle":
      return null;
    case "Searching":
      return { placement: "Inline", content: "Searching…", description: "Searching…" };
    case "TooMany": {
      const text = `More than ${FIND_LIMIT} matches. Refine your search.`;
      return { placement: "Details", content: text, description: text };
    }
    case "Failed":
      return { placement: "Details", content: result.message, description: result.message };
    case "Rows": {
      const count = result.rows.length;
      const found = count === 0
        ? "No matches"
        : `${result.active + 1} of ${count} ${count === 1 ? "match" : "matches"}`;
      const partial = result.partial !== null;
      const text = partial
        ? `${found} in the ${result.partial}; results are incomplete.`
        : found;
      return {
        placement: partial ? "Details" : "Inline",
        content: partial || count === 0 ? text : <span aria-hidden="true">{result.active + 1}/{count}</span>,
        description: result.wrapped
          ? `${text}${partial ? "" : "."} Wrapped to ${result.wrapped} match.`
          : text,
      };
    }
  }
}

/** Shared query presentation; the shell owns disclosure and Companion results. */
const FindBar = forwardRef<
  HTMLInputElement,
  {
    readonly find: FindController | null;
    readonly onClear: () => void;
    readonly onClose?: () => void;
    readonly resultsExpanded: boolean;
    readonly onShowResults: (opener: HTMLElement) => void;
  }
>(function FindBar({ find, onClear, onClose, resultsExpanded, onShowResults }, ref) {
  const inputRef = useRef<HTMLInputElement>(null);
  // justify-type-assertion: the toolbar mounts this input before imperative handles run.
  useImperativeHandle(ref, () => inputRef.current!, []);
  const statusId = useId();
  const feedback = findFeedback(find?.result ?? null);
  const count = find?.result.kind === "Rows" ? find.result.rows.length : 0;
  const scope = find?.query
    ? find.narrow ?? "Selected scope unavailable"
    : find?.narrowLabel ?? "Selected scope unavailable";
  const scopeOption = find?.query
    ? find.narrow ? `Limit to ${find.narrow}` : "Selected scope unavailable"
    : find?.narrowLabel ? `Limit to ${find.narrowLabel.toLowerCase()}` : "Selected scope unavailable";
  const chips = [
    ...(find?.matchCase ? [{ id: "case", label: "Match case" }] : []),
    ...(find?.wholeWord ? [{ id: "word", label: "Whole word" }] : []),
    ...(find?.narrowed ? [{ id: "scope", label: `Scope: ${scope}` }] : []),
  ];
  return (
    <div className={styles.bar} onKeyDown={(event) => {
      if (!onClose || event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }}>
      <PaneQueryToolbar
        inputRef={inputRef}
        input={{
          label: find?.label ?? "Find in pane",
          placeholder: find?.label ?? "Find in pane",
          value: find?.query ?? "",
          appliedValue: find?.query ?? "",
          disabled: find === null,
          keyShortcuts: "Enter Shift+Enter Escape",
          onChange: (value) => value ? find?.setQuery(value) : onClear(),
          onClear,
          onKeyDown(event) {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape" && onClose) {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            } else if (event.key === "Enter" && !event.altKey && !event.ctrlKey && !event.metaKey) {
              event.preventDefault();
              find?.step(event.shiftKey ? -1 : 1);
            }
          },
        }}
        options={find ? {
          label: "Find options",
          iconOnly: true,
          activeCount: chips.length,
          content: (
            <fieldset className={styles.options}>
              <legend>Find options</legend>
              <ChoiceField label="Match case" checked={find.matchCase} onChange={find.setMatchCase} />
              <ChoiceField label="Whole word" checked={find.wholeWord} onChange={find.setWholeWord} />
              {find.narrowLabel !== null || find.narrowed ? (
                <ChoiceField label={scopeOption} checked={find.narrowed} onChange={find.setNarrowed} />
              ) : null}
            </fieldset>
          ),
          onClear() {
            find.setMatchCase(false);
            find.setWholeWord(false);
            find.setNarrowed(false);
          },
        } : undefined}
        chips={{
          items: chips,
          onRemove(id) {
            if (id === "case") find?.setMatchCase(false);
            else if (id === "word") find?.setWholeWord(false);
            else find?.setNarrowed(false);
          },
        }}
        status={feedback ? {
          placement: feedback.placement,
          id: statusId,
          visible: true,
          content: <span className={styles.status}>{feedback.content}</span>,
        } : undefined}
        actions={<>
          <div className={styles.group} role="group" aria-label="Match navigation">
            <Button iconOnly aria-label="Previous match" tooltip={{ text: "Previous match (Shift+Enter)" }} disabled={count === 0} onClick={() => find?.step(-1)} icon={<ChevronUp size={15} aria-hidden="true" />} />
            <Button iconOnly aria-label="Next match" tooltip={{ text: "Next match (Enter)" }} disabled={count === 0} onClick={() => find?.step(1)} icon={<ChevronDown size={15} aria-hidden="true" />} />
          </div>
          {find?.result.kind === "Failed" ? <Button onClick={() => {
            inputRef.current?.focus({ preventScroll: true });
            find.retry();
          }}>Retry</Button> : null}
        </>}
        trailingActions={<>
          <Button iconOnly aria-label="Show search results" disabled={count === 0} icon={<TextSearch size={15} aria-hidden="true" />} aria-expanded={resultsExpanded} onClick={(event) => onShowResults(event.currentTarget)} />
          {find?.returnable ? (
            <Button iconOnly aria-label="Return to reading position" onClick={() => {
              inputRef.current?.focus({ preventScroll: true });
              find.goBack();
            }}
              icon={<RotateCcw size={15} aria-hidden="true" />} />
          ) : null}
          {onClose ? (
            <Button iconOnly aria-label="Close find" onClick={onClose} icon={<X size={15} aria-hidden="true" />} />
          ) : null}
        </>}
      />
      <span id={statusId} className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {feedback?.description}
      </span>
    </div>
  );
});
export default FindBar;

/** Every match with its context: the Companion's transient "Search results" tab. */
export function FindResults({
  find,
  onPreviewed,
}: {
  readonly find: FindController;
  /** A match was shown in the pane (mobile hides the sheet). */
  readonly onPreviewed: () => void;
}) {
  const resultsRef = useRef<HTMLDivElement>(null);
  const { result } = find;
  const rows = result.kind === "Rows" ? result.rows.map((row, index): CollectionRowView => {
    const text = row.snippet.map((segment) => segment.text).join("");
    const current = index === result.active;
    const label = [
      current ? "Current match" : "Go to match",
      `${index + 1} of ${result.rows.length}`,
      row.context.join(", "),
      text,
    ];
    return {
      id: String(index),
      kind: "search_result",
      // Desktop keeps the list open; mobile hides the sheet once the surface shows the match.
      primary: {
        kind: "button",
        label: label.filter(Boolean).join(": "),
        onActivate: () =>
          void find.activate(index).then((shown) => shown && onPreviewed()),
      },
      title: { text, segments: row.snippet },
      context:
        row.context.length > 0
          ? {
              kind: "Snippet",
              segments: [{ text: row.context.join(" / "), emphasized: false }],
            }
          : null,
      contributors: [],
      publicationDate: null,
      activity: null,
      exceptionalStatus: null,
      resourceRef: null,
      selected: current,
    };
  }) : [];
  return (
    <div ref={resultsRef} className={styles.results} role="group" aria-label="Search results" tabIndex={-1}>
      {result.kind === "Rows" && rows.length > 0 ? (
        <>
          {result.partial !== null ? (
            <p className={styles.partial}>
              Showing matches in the {result.partial}. Results are incomplete.
            </p>
          ) : null}
          <CollectionView
            returnScope="PaneFind.Results"
            rows={rows}
            status="ready"
            ariaLabel="Search results"
            rowActionsAvailable={false}
            surface={false}
          />
        </>
      ) : result.kind === "Idle" ? null : (
        <div className={styles.message}>
          <span>{findFeedback(result)?.description}</span>
          {result.kind === "Failed" ? (
            <Button onClick={() => {
              resultsRef.current?.focus({ preventScroll: true });
              find.retry();
            }}>
              Retry
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
