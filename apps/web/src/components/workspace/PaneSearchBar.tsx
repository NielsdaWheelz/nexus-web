"use client";

import {
  forwardRef,
  useEffect,
  useId,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import {
  ChevronDown,
  ChevronUp,
  List,
  RotateCcw,
  X,
} from "lucide-react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import PaneToolbar from "@/components/ui/PaneToolbar";
import Select from "@/components/ui/Select";
import Toggle from "@/components/ui/Toggle";
import type {
  PaneFindResult,
  PaneSearchPublication,
} from "@/lib/panes/paneSearch";
import { truncatePaneSearchQuery } from "@/lib/panes/paneSearch";
import styles from "./PaneSearchBar.module.css";

const PANE_FILTER_ROWS_ANNOUNCEMENT_DEBOUNCE_MS = 160;

function assertUnreachableRowStatus(status: never): never {
  throw new Error(
    `Unreachable Pane Filter row status: ${JSON.stringify(status)}`,
  );
}

function resultStatus(
  result: PaneFindResult,
  partialSourceLabel?: string,
): string {
  switch (result.kind) {
    case "Idle":
      return "Enter a search term";
    case "Searching":
      return "Searching…";
    case "NoMatches":
      return result.completeness === "Complete"
        ? "No matches"
        : partialSourceLabel
          ? `No matches in the ${partialSourceLabel}; results are incomplete`
          : "No matches found so far";
    case "Ready": {
      const activeIndex = result.rows.findIndex(
        (row) => row.key === result.activeKey,
      );
      const ordinal = `${activeIndex + 1} of ${result.rows.length}`;
      return result.completeness === "Complete"
        ? `${ordinal} ${result.rows.length === 1 ? "match" : "matches"}`
        : partialSourceLabel
          ? `${ordinal} ${
              result.rows.length === 1 ? "match" : "matches"
            } in the ${partialSourceLabel}; results are incomplete`
          : `${ordinal} ${
              result.rows.length === 1 ? "match" : "matches"
            } found so far`;
    }
    case "TooManyMatches":
      return `More than ${result.threshold} matches. Refine your search.`;
    case "Failed":
      return `Search failed. ${result.message}`;
  }
}

function SearchInput({
  publication,
  describedBy,
  onQueryChange,
  onStep,
  ref,
}: {
  readonly publication: PaneSearchPublication;
  readonly describedBy?: string;
  readonly onQueryChange: (query: string) => void;
  readonly onStep: (direction: "Previous" | "Next") => void;
  readonly ref: Ref<HTMLInputElement>;
}) {
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (
      publication.kind === "FindOccurrences" &&
      event.key === "Enter" &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      if (publication.result.kind === "Ready") {
        onStep(event.shiftKey ? "Previous" : "Next");
      }
    }
  };

  return (
    <Input
      ref={ref}
      type="search"
      size="sm"
      value={publication.query}
      aria-label={publication.inputLabel}
      aria-describedby={describedBy}
      aria-keyshortcuts={
        publication.kind === "FindOccurrences"
          ? "Enter Shift+Enter Escape"
          : "Escape"
      }
      placeholder={publication.placeholder}
      autoComplete="off"
      autoCapitalize="none"
      spellCheck={false}
      data-pane-search-input="true"
      onChange={(event) =>
        onQueryChange(truncatePaneSearchQuery(event.target.value))
      }
      onKeyDown={handleKeyDown}
    />
  );
}

function FilterRowsStatus({
  publication,
  statusId,
}: {
  readonly publication: Extract<PaneSearchPublication, { kind: "FilterRows" }>;
  readonly statusId: string;
}) {
  const [announcement, setAnnouncement] = useState("");
  const { query, rowStatus } = publication;
  const effectiveQuery = query.trim();

  useEffect(() => {
    if (effectiveQuery.length === 0) {
      setAnnouncement("");
      return;
    }
    const timeout = window.setTimeout(() => {
      const unit =
        rowStatus.visibleCount === 1
          ? rowStatus.unit.singular
          : rowStatus.unit.plural;
      switch (rowStatus.kind) {
        case "Partial":
          setAnnouncement(
            `${rowStatus.visibleCount} matching ${unit} among ${rowStatus.loadedCount} loaded; loading remaining ${rowStatus.unit.plural}.`,
          );
          break;
        case "Complete":
          setAnnouncement(
            `${rowStatus.visibleCount} matching ${unit} of ${rowStatus.totalCount} total.`,
          );
          break;
        default:
          assertUnreachableRowStatus(rowStatus);
      }
    }, PANE_FILTER_ROWS_ANNOUNCEMENT_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [effectiveQuery, rowStatus]);

  return (
    <span
      id={statusId}
      className="sr-only"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {effectiveQuery.length > 0 ? announcement : ""}
    </span>
  );
}

function CloseButton({ onDismiss }: { readonly onDismiss: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      aria-label="Close search"
      title="Close search"
      onClick={onDismiss}
    >
      <X size={15} aria-hidden="true" />
    </Button>
  );
}

function FindOptions({
  publication,
}: {
  readonly publication: Extract<
    PaneSearchPublication,
    { kind: "FindOccurrences" }
  >;
}) {
  const scopeId = useId();
  const { scope } = publication;
  return (
    <div className={styles.findOptions} role="group" aria-label="Find options">
      {scope.kind === "Selectable" ? (
        <label className={styles.scopeField} htmlFor={scopeId}>
          <span>Scope</span>
          <Select
            id={scopeId}
            size="sm"
            value={scope.selectedId}
            onChange={(event) => scope.onChange(event.target.value)}
          >
            {scope.options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
        </label>
      ) : null}
      <Toggle
        size="sm"
        label="Match case"
        checked={publication.matchCase}
        onCheckedChange={publication.onMatchCaseChange}
      />
      <Toggle
        size="sm"
        label="Whole word"
        checked={publication.wholeWord}
        onCheckedChange={publication.onWholeWordChange}
      />
    </div>
  );
}

function FindControls({
  publication,
  statusId,
  wrapAnnouncement,
  onStep,
  onDismiss,
}: {
  readonly publication: Extract<
    PaneSearchPublication,
    { kind: "FindOccurrences" }
  >;
  readonly statusId: string;
  readonly wrapAnnouncement: string;
  readonly onStep: (direction: "Previous" | "Next") => void;
  readonly onDismiss: () => void;
}) {
  const ready = publication.result.kind === "Ready";
  const status = [
    resultStatus(
      publication.result,
      publication.partialSourceLabel,
    ),
    ready ? wrapAnnouncement : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <>
      <span
        id={statusId}
        className={styles.status}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        title={status}
      >
        {status}
      </span>
      {publication.result.kind === "Failed" ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={publication.result.onRetry}
        >
          Retry
        </Button>
      ) : null}
      <div
        className={styles.stepControls}
        role="group"
        aria-label="Match navigation"
      >
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label="Previous match"
          title="Previous match (Shift+Enter)"
          disabled={!ready}
          onClick={() => onStep("Previous")}
        >
          <ChevronUp size={15} aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label="Next match"
          title="Next match (Enter)"
          disabled={!ready}
          onClick={() => onStep("Next")}
        >
          <ChevronDown size={15} aria-hidden="true" />
        </Button>
      </div>
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={publication.resultsExpanded}
        disabled={!ready}
        leadingIcon={<List size={15} aria-hidden="true" />}
        onClick={(event) => publication.onShowResults(event.currentTarget)}
      >
        Results
      </Button>
      {publication.returnToReadingPosition.kind === "Available" ? (
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label="Go back to reading position"
          title="Go back to reading position"
          onClick={publication.returnToReadingPosition.onReturn}
        >
          <RotateCcw size={15} aria-hidden="true" />
        </Button>
      ) : null}
      <CloseButton onDismiss={onDismiss} />
    </>
  );
}

const PaneSearchBar = forwardRef<
  HTMLInputElement,
  {
    readonly publication: PaneSearchPublication;
    readonly onClose: () => void;
  }
>(function PaneSearchBar({ publication, onClose }, ref) {
  const statusId = useId();
  const [wrapAnnouncement, setWrapAnnouncement] = useState("");
  const dismiss = () => {
    publication.onDismiss();
    onClose();
  };
  const changeQuery = (query: string) => {
    setWrapAnnouncement("");
    publication.onQueryChange(query);
  };
  const step = (direction: "Previous" | "Next") => {
    if (publication.kind !== "FindOccurrences") return;
    const { result } = publication;
    if (result.kind !== "Ready") return;
    const activeIndex = result.rows.findIndex(
      (row) => row.key === result.activeKey,
    );
    const wrapped =
      (direction === "Next" && activeIndex === result.rows.length - 1) ||
      (direction === "Previous" && activeIndex === 0);
    setWrapAnnouncement(
      wrapped
        ? direction === "Next"
          ? "Wrapped to first match."
          : "Wrapped to last match."
        : "",
    );
    publication.onStep(direction);
  };
  let filters: ReactNode;
  let controls: ReactNode;

  switch (publication.kind) {
    case "FilterRows":
      filters = publication.filters;
      controls = (
        <>
          <FilterRowsStatus publication={publication} statusId={statusId} />
          {publication.controls}
          <CloseButton onDismiss={dismiss} />
        </>
      );
      break;
    case "FindOccurrences":
      filters = <FindOptions publication={publication} />;
      controls = (
        <FindControls
          publication={publication}
          statusId={statusId}
          wrapAnnouncement={wrapAnnouncement}
          onStep={step}
          onDismiss={dismiss}
        />
      );
      break;
  }

  return (
    <div
      className={styles.bar}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      }}
    >
      <PaneToolbar
        variant={
          publication.kind === "FilterRows" ? "Refinement" : "Instrument"
        }
        search={
          <SearchInput
            ref={ref}
            publication={publication}
            onQueryChange={changeQuery}
            onStep={step}
            describedBy={
              publication.kind === "FindOccurrences" ? statusId : undefined
            }
          />
        }
        filters={filters}
        controls={controls}
      />
    </div>
  );
});

export default PaneSearchBar;
