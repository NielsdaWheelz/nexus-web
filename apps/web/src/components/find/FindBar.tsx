"use client";

import { forwardRef, useId, useImperativeHandle, useRef } from "react";
import { ChevronDown, ChevronUp, List, RotateCcw, X } from "lucide-react";
import CollectionView from "@/components/collections/CollectionView";
import Button from "@/components/ui/Button";
import ChoiceField from "@/components/ui/ChoiceField";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import { absent, present } from "@/lib/api/presence";
import type { CollectionRowView } from "@/lib/collections/types";
import { FIND_LIMIT } from "@/lib/find/find";
import type { FindController, FindResult } from "@/lib/find/useFind";
import styles from "./Find.module.css";

function status(result: FindResult): string {
  switch (result.kind) {
    case "Idle":
      return "Enter a search term";
    case "Searching":
      return "Searching…";
    case "TooMany":
      return `More than ${FIND_LIMIT} matches. Refine your search.`;
    case "Failed":
      return result.message;
    case "Rows": {
      const count = result.rows.length;
      const found = count === 0
        ? "No matches"
        : `${result.active + 1} of ${count} ${count === 1 ? "match" : "matches"}`;
      const text = result.partial
        ? `${found} in the ${result.partial}; results are incomplete`
        : found;
      return result.wrapped ? `${text}. Wrapped to ${result.wrapped} match.` : text;
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
          label: "Options",
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
        status={{
          id: statusId,
          content: <span id={statusId} className={styles.status} role="status" aria-live="polite" aria-atomic="true">
            {find ? status(find.result) : "Find is not ready."}
          </span>,
        }}
        actions={<>
          <div className={styles.group} role="group" aria-label="Match navigation">
            <Button variant="ghost" size="sm" iconOnly aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={count === 0} onClick={() => find?.step(-1)}>
              <ChevronUp size={15} aria-hidden="true" />
            </Button>
            <Button variant="ghost" size="sm" iconOnly aria-label="Next match" title="Next match (Enter)" disabled={count === 0} onClick={() => find?.step(1)}>
              <ChevronDown size={15} aria-hidden="true" />
            </Button>
          </div>
          <Button variant="ghost" size="sm" disabled={count === 0} leadingIcon={<List size={15} aria-hidden="true" />} aria-expanded={resultsExpanded} onClick={(event) => onShowResults(event.currentTarget)}>
            Results
          </Button>
          {find?.result.kind === "Failed" ? <Button variant="ghost" size="sm" onClick={find.retry}>Retry</Button> : null}
          {find?.returnable ? (
            <Button variant="ghost" size="sm" iconOnly aria-label="Return to reading position" title="Return to reading position" onClick={find.goBack}>
              <RotateCcw size={15} aria-hidden="true" />
            </Button>
          ) : null}
          {onClose ? (
            <Button variant="ghost" size="sm" iconOnly aria-label="Close find" title="Close find" onClick={onClose}>
              <X size={15} aria-hidden="true" />
            </Button>
          ) : null}
        </>}
      />
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
  const { result } = find;
  if (result.kind !== "Rows" || result.rows.length === 0) {
    return (
      <div className={styles.message}>
        <span>{status(result)}</span>
        {result.kind === "Failed" ? (
          <Button variant="secondary" size="sm" onClick={find.retry}>
            Retry
          </Button>
        ) : null}
      </div>
    );
  }
  const rows = result.rows.map((row, index): CollectionRowView => {
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
          ? present({
              kind: "Snippet",
              segments: [{ text: row.context.join(" / "), emphasized: false }],
            })
          : absent(),
      contributors: [],
      publicationDate: absent(),
      activity: absent(),
      exceptionalStatus: absent(),
      actionSubject: null,
      selected: current,
    };
  });
  return (
    <div className={styles.results}>
      {result.partial ? (
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
    </div>
  );
}
