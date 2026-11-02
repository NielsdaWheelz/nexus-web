"use client";

import { forwardRef, useId, useImperativeHandle, useRef, type ReactNode } from "react";
import { ChevronDown, ChevronUp, RotateCcw, TextSearch, X } from "lucide-react";
import CollectionView from "@/components/collections/CollectionView";
import Button from "@/components/ui/Button";
import ChoiceField from "@/components/ui/ChoiceField";
import choices from "@/components/ui/ChoiceField.module.css";
import { Fact } from "@/components/feedback/Fact";
import { useOutcome } from "@/components/feedback/Feedback";
import { Ruling } from "@/components/feedback/Ruling";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import type { CollectionRowView } from "@/lib/collections/types";
import { FIND_LIMIT, type FindRow } from "@/lib/find/find";
import type { FindController, FindResult } from "@/lib/find/useFind";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { activateTargetLink, type TargetLinkActivationResult } from "@/lib/panes/targetLinkActivation";
import { workspaceTargetActivationIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import styles from "./Find.module.css";

const TOO_MANY = `more than ${FIND_LIMIT} matches. narrow the search.`;

/** Find's own count, beside its input. A pane that has not loaded leaves the input disabled with
 * a reason for a screen reader alone; a search under way shows nothing here. */
function findFeedback(result: FindResult | null): {
  readonly placement: "Inline" | "Details";
  readonly visible: boolean;
  readonly content: ReactNode;
  readonly description: string;
} | null {
  if (result === null)
    return { placement: "Inline", visible: false, content: null, description: "available once this pane loads." };
  switch (result.kind) {
    case "Idle":
    case "Searching":
      return null;
    case "TooMany":
      return { placement: "Details", visible: true, content: TOO_MANY, description: TOO_MANY };
    case "Failed":
      return { placement: "Details", visible: true, content: result.message, description: result.message };
    case "Rows": {
      const count = result.rows.length;
      const found = count === 0
        ? "no matches"
        : `${result.active + 1} of ${count} ${count === 1 ? "match" : "matches"}`;
      const partial = result.partial !== null;
      const text = partial ? `${found} in the ${result.partial} only.` : found;
      return {
        placement: partial ? "Details" : "Inline",
        visible: true,
        content: partial || count === 0 ? text : <span aria-hidden="true">{result.active + 1}/{count}</span>,
        description: result.wrapped
          ? `${text}${partial ? "" : "."} wrapped to the ${result.wrapped} match.`
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
            <fieldset className={choices.group}>
              <legend>Find options</legend>
              <div className={choices.choices}>
                <ChoiceField label="Match case" checked={find.matchCase} onChange={find.setMatchCase} />
                <ChoiceField label="Whole word" checked={find.wholeWord} onChange={find.setWholeWord} />
                {find.narrowLabel !== null || find.narrowed ? (
                  <ChoiceField label={scopeOption} checked={find.narrowed} onChange={find.setNarrowed} />
                ) : null}
              </div>
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
          visible: feedback.visible,
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
  const runtime = usePaneRuntime();
  const { say } = useOutcome();
  const refuse = () => say({ fact: "couldn’t show that match.", reason: "it’s no longer there." });
  const { result } = find;
  const open = (row: FindRow<unknown>, href: string | null, event: TargetActivationEvent): TargetLinkActivationResult => {
    const activation = workspaceTargetActivationIntent(event, href === null ? "activate" : "native");
    if (activation.kind === "Unowned") return "unhandled";
    if (activation.kind === "Consume") { event.preventDefault(); return "consumed"; }
    const currentHref = find.targetHref(row);
    const local = () => {
      void find.activate(row).then((shown) => {
        if (shown) onPreviewed();
        else refuse();
      });
    };
    if (currentHref === null) {
      event.preventDefault();
      if (activation.intent === "default") { local(); return "handled-default"; }
      refuse();
      return "consumed";
    }
    if (currentHref !== href) { event.preventDefault(); refuse(); return "consumed"; }
    const handled = activateTargetLink({ event, runtime, target: { href: currentHref }, onDefault: local });
    if (handled === "handled-new-pane") onPreviewed();
    return handled;
  };
  const rows = result.kind === "Rows" ? result.rows.map((row, index): CollectionRowView => {
    const text = row.snippet.map((segment) => segment.text).join("");
    const current = index === result.active;
    const label = [
      current ? "Current match" : "Go to match",
      `${index + 1} of ${result.rows.length}`,
      row.context.join(", "),
      text,
    ];
    const href = find.targetHref(row);
    return {
      id: String(index),
      kind: "search_result",
      presentation: "Index",
      // Desktop keeps the list open; mobile hides the sheet once the surface shows the match.
      primary: {
        kind: "link",
        href,
        label: label.filter(Boolean).join(": "),
        onActivate: (event) => open(row, href, event),
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
            <p className={styles.partial}>matches in the {result.partial} only.</p>
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
      ) : result.kind === "Idle" ? null : result.kind === "Searching" ? <Ruling />
        : result.kind === "Failed" ? <Fact line={{ fact: result.message }} verbs={[{ label: "retry", commandKey: "retry find", run: () => {
          resultsRef.current?.focus({ preventScroll: true });
          find.retry();
        } }]} />
        : <Fact line={{ fact: result.kind === "TooMany" ? TOO_MANY : "no matches" }} />}
    </div>
  );
}
