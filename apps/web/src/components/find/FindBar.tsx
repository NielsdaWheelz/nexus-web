"use client";

import { forwardRef, useEffect, useId, type ReactNode } from "react";
import { ChevronDown, ChevronUp, List, RotateCcw, X } from "lucide-react";
import CollectionView from "@/components/collections/CollectionView";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import PaneToolbar from "@/components/ui/PaneToolbar";
import Toggle from "@/components/ui/Toggle";
import { absent, present } from "@/lib/api/presence";
import type { CollectionRowView } from "@/lib/collections/types";
import { FIND_LIMIT } from "@/lib/find/find";
import type { FindController, FindResult } from "@/lib/find/useFind";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { useMobileChromeVisibleLocks } from "@/lib/workspace/mobileChrome";
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
      return `Search failed. ${result.message}`;
    case "Rows": {
      const count = result.rows.length;
      const found =
        count === 0
          ? "No matches"
          : `${result.active + 1} of ${count} ${count === 1 ? "match" : "matches"}`;
      const text = result.partial
        ? `${found} in the ${result.partial}; results are incomplete`
        : found;
      return result.wrapped
        ? `${text} Wrapped to ${result.wrapped} match.`
        : text;
    }
  }
}

/** The pane's find row. PaneShell mounts it while find is expanded; onClose ends the session. */
const FindBar = forwardRef<
  HTMLInputElement,
  { readonly find: FindController; readonly onClose: () => void }
>(function FindBar({ find, onClose }, ref) {
  const statusId = useId();
  const runtime = usePaneRuntime();
  const chromeLocks = useMobileChromeVisibleLocks();
  // Mobile chrome stays pinned while the bar is in it.
  useEffect(() => chromeLocks.acquire("pane-find"), [chromeLocks]);
  const { result } = find;
  const count = result.kind === "Rows" ? result.rows.length : 0;
  const results = runtime?.transientSecondarySurface;
  const text = status(result);
  const icon = (
    label: string,
    title: string,
    onClick: () => void,
    glyph: ReactNode,
    disabled = false,
  ) => (
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {glyph}
    </Button>
  );
  return (
    <div
      className={styles.bar}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <PaneToolbar
        variant="Instrument"
        search={
          <Input
            ref={ref}
            type="search"
            size="sm"
            value={find.query}
            aria-label={find.label}
            placeholder={find.label}
            aria-describedby={statusId}
            aria-keyshortcuts="Enter Shift+Enter Escape"
            data-pane-search-input="true"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => find.setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key !== "Enter" ||
                event.altKey ||
                event.ctrlKey ||
                event.metaKey
              )
                return;
              event.preventDefault();
              find.step(event.shiftKey ? -1 : 1);
            }}
          />
        }
        filters={
          <div className={styles.group} role="group" aria-label="Find options">
            {find.narrow ? (
              <Toggle
                size="sm"
                label={find.narrow}
                checked={find.narrowed}
                onCheckedChange={find.setNarrowed}
              />
            ) : null}
            <Toggle
              size="sm"
              label="Match case"
              checked={find.matchCase}
              onCheckedChange={find.setMatchCase}
            />
            <Toggle
              size="sm"
              label="Whole word"
              checked={find.wholeWord}
              onCheckedChange={find.setWholeWord}
            />
          </div>
        }
        controls={
          <>
            <span
              id={statusId}
              className={styles.status}
              role="status"
              aria-live="polite"
              aria-atomic="true"
              title={text}
            >
              {text}
            </span>
            {result.kind === "Failed" ? (
              <Button variant="ghost" size="sm" onClick={find.retry}>
                Retry
              </Button>
            ) : null}
            <div
              className={styles.group}
              role="group"
              aria-label="Match navigation"
            >
              {icon(
                "Previous match",
                "Previous match (Shift+Enter)",
                () => find.step(-1),
                <ChevronUp size={15} aria-hidden="true" />,
                count === 0,
              )}
              {icon(
                "Next match",
                "Next match (Enter)",
                () => find.step(1),
                <ChevronDown size={15} aria-hidden="true" />,
                count === 0,
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={count === 0}
              leadingIcon={<List size={15} aria-hidden="true" />}
              aria-expanded={
                results?.id === "resource-search" && results.expanded
              }
              onClick={(event) =>
                runtime?.requestTransientSecondarySurface("resource-search", {
                  returnFocusTo: event.currentTarget,
                })
              }
            >
              Results
            </Button>
            {find.returnable
              ? icon(
                  "Go back to reading position",
                  "Go back to reading position",
                  find.goBack,
                  <RotateCcw size={15} aria-hidden="true" />,
                )
              : null}
            {icon(
              "Close search",
              "Close search",
              onClose,
              <X size={15} aria-hidden="true" />,
            )}
          </>
        }
      />
    </div>
  );
});
export default FindBar;

/** Every match with its context: the body of the pane's transient `resource-search` surface. */
export function FindResults({ find }: { readonly find: FindController }) {
  const runtime = usePaneRuntime();
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
          void find
            .activate(index)
            .then(
              (shown) => shown && runtime?.previewTransientSecondaryResult(),
            ),
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
