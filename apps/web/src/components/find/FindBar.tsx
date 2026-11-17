"use client";
import * as Icon from "@/lib/ui/icons";

import { forwardRef, useId, useImperativeHandle, useRef, type ReactNode } from "react";
import CollectionView from "@/components/collections/CollectionView";
import Button from "@/components/ui/Button";
import { Fact } from "@/components/feedback/Fact";
import { useOutcome } from "@/components/feedback/Feedback";
import { Ruling } from "@/components/feedback/Ruling";
import QueryField from "@/components/workspace/QueryField";
import type { CollectionRowView } from "@/lib/collections/types";
import { FIND_LIMIT, type FindRow } from "@/lib/find/find";
import type { FindController, FindResult } from "@/lib/find/useFind";
import { PANE_COMMAND_RESOLVING_REASON } from "@/lib/panes/paneChrome";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { activateTargetLink, type TargetLinkActivationResult } from "@/lib/panes/targetLinkActivation";
import { workspaceTargetActivationIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import styles from "./Find.module.css";

const TOO_MANY = `more than ${FIND_LIMIT} matches. narrow the search.`;

/** Find's own count, beside its input. A pane that has not loaded leaves the input disabled with
 * a reason for a screen reader alone; a search under way shows nothing here. */
function findFeedback(result: FindResult | null): {
  readonly position: ReactNode;
  readonly notice: string | null;
  readonly description: string;
} | null {
  if (result === null)
    return { position: null, notice: null, description: PANE_COMMAND_RESOLVING_REASON };
  switch (result.kind) {
    case "Idle":
    case "Searching":
      return null;
    case "TooMany":
      return { position: null, notice: TOO_MANY, description: TOO_MANY };
    case "Failed":
      return { position: null, notice: result.message, description: result.message };
    case "Rows": {
      const count = result.rows.length;
      const found = count === 0
        ? "no matches"
        : `${result.active + 1} of ${count} ${count === 1 ? "match" : "matches"}`;
      const partial = result.partial !== null;
      const text = partial ? `${found} in the ${result.partial} only.` : found;
      return {
        position: count === 0 ? "no matches" : <span aria-hidden="true">{result.active + 1}/{count}</span>,
        notice: partial ? text : null,
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
    readonly onClose: () => void;
    readonly resultsExpanded: boolean;
    readonly onShowResults: (opener: HTMLElement) => void;
  }
>(function FindBar({ find, onClear, onClose, resultsExpanded, onShowResults }, ref) {
  const inputRef = useRef<HTMLInputElement>(null);
  // justify-type-assertion: QueryField mounts this input before imperative handles run.
  useImperativeHandle(ref, () => inputRef.current!, []);
  const statusId = useId();
  const feedback = findFeedback(find?.result ?? null);
  const count = find?.result.kind === "Rows" ? find.result.rows.length : 0;
  const scope = find?.query
    ? find.narrow ?? "selected scope unavailable"
    : find?.narrowLabel ?? "selected scope unavailable";
  const scopeOption = find?.query
    ? find.narrow ? `limit to ${find.narrow}` : "selected scope unavailable"
    : find?.narrowLabel ? `limit to ${find.narrowLabel.toLowerCase()}` : "selected scope unavailable";
  return (
    <div className={styles.bar} onKeyDown={(event) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }}>
      <QueryField
        inputRef={inputRef}
        applied={find?.query ?? ""}
        input={{
          "aria-label": find?.label ?? "find in document",
          placeholder: find?.label ?? "find in document",
          "aria-describedby": statusId,
          "aria-keyshortcuts": "Enter Shift+Enter Escape",
          value: find?.query ?? "",
          disabled: find === null,
          onChange: event => event.currentTarget.value ? find?.setQuery(event.currentTarget.value) : onClear(),
          onKeyDown(event) {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            } else if (event.key === "Enter" && !event.altKey && !event.ctrlKey && !event.metaKey) {
              event.preventDefault();
              find?.step(event.shiftKey ? -1 : 1);
            }
          },
        }}
        onClear={onClear}
        onClose={onClose}
        notice={feedback?.notice ? {
          kind: "Ready", line: { fact: feedback.notice },
          ...(find?.result.kind === "Failed" ? { verbs: [{ label: "retry", commandKey: "Find.Retry", run: () => find.retry() }] } : {}),
        } : null}
        parts={<>
          {feedback?.position ? <span className={styles.status}>{feedback.position}</span> : null}
          <div className={styles.group} role="group" aria-label="match navigation">
            <Button iconOnly aria-label="previous match" tooltip={{ text: "previous match (Shift+Enter)" }} disabled={count === 0} onClick={() => find?.step(-1)} icon={<Icon.Up aria-hidden="true" />} />
            <Button iconOnly aria-label="next match" tooltip={{ text: "next match (Enter)" }} disabled={count === 0} onClick={() => find?.step(1)} icon={<Icon.Down aria-hidden="true" />} />
          </div>
          {find ? <>
            <Button className={styles.switch} aria-label="match case" tooltip={{ text: "match case" }} aria-pressed={find.matchCase} onClick={() => find.setMatchCase(!find.matchCase)}>case</Button>
            <Button className={styles.switch} aria-label="whole word" tooltip={{ text: "whole word" }} aria-pressed={find.wholeWord} onClick={() => find.setWholeWord(!find.wholeWord)}>word</Button>
            {find.narrowLabel !== null || find.narrowed ? <Button
              className={styles.switch} aria-label={scopeOption} tooltip={{ text: scopeOption }} aria-pressed={find.narrowed}
              onClick={() => find.setNarrowed(!find.narrowed)}
            >{scope.toLocaleLowerCase()}</Button> : null}
          </> : null}
          <Button aria-label="show search results" tooltip={{ text: "show search results" }} disabled={count === 0} aria-expanded={resultsExpanded} onClick={event => onShowResults(event.currentTarget)}>results</Button>
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
