"use client";

import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, Lock, Minus, Plus } from "lucide-react";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import Input from "@/components/ui/Input";
import type { LibraryDestinationSelection } from "@/lib/libraries/destinationContract";
import type { LibraryPlacementBlockedReason } from "@/lib/libraries/libraryPlacement";
import { libraryPlacementBlockedReasonMessage } from "@/lib/libraries/libraryRequestErrorMessage";
import {
  compareLibraryNames,
  isReservedLibraryName,
  RESERVED_LIBRARY_NAME_MESSAGE,
} from "@/lib/libraries/presentation";
import styles from "./LibraryChooser.module.css";

export type LibraryChooserAdmission = "Accepted" | "Rejected";
export type LibraryChooserMembership = { included: number; total: number };

/** Membership is a fact; the action is an explicit proposed change to intent. */
export interface LibraryChooserItem {
  id: string;
  name: string;
  note?: string;
  confirmed: LibraryChooserMembership | null;
  intended: LibraryChooserMembership | null;
  progress: "Settled" | "Pending" | "Uncertain" | "Reconciling";
  exclusions: readonly { reason: LibraryPlacementBlockedReason; count: number }[];
  provenance: readonly LibraryDestinationSelection[];
  action:
    | { kind: "Set"; included: boolean; targetCount: number }
    | { kind: "Blocked"; reason: string };
}

export type LibraryChooserError = {
  content: FeedbackContent;
  onRetry: (() => void) | null;
};

export interface LibraryChooserProps {
  items: readonly LibraryChooserItem[];
  onCommit: (change: { choiceId: string; included: boolean }) => LibraryChooserAdmission;
  loading: boolean;
  summary: string;
  error: LibraryChooserError | null;
  creation: {
    available: boolean;
    pendingNames: readonly string[];
    onCreate: (name: string) => LibraryChooserAdmission;
  } | null;
  emptyInventory: string;
  status?: string;
  searchLabel?: string;
  listLabel?: string;
}

type Suggestion =
  | { kind: "Library"; id: string; item: LibraryChooserItem }
  | { kind: "Create"; id: string; name: string };

function membershipDescription(membership: LibraryChooserMembership | null): string {
  if (membership === null) return "membership unknown";
  if (membership.total === 1) return membership.included === 1 ? "included" : "not included";
  return `in ${membership.included} of ${membership.total} items`;
}

function actionDescription(item: LibraryChooserItem): string {
  const action = item.action;
  if (action.kind === "Blocked") return action.reason;
  const verb = action.included ? "add" : "remove";
  const total = item.intended?.total ?? item.confirmed?.total ?? 1;
  if (total === 1) return verb;
  if (item.exclusions.length > 0) {
    return `${verb} ${action.included ? "to" : "from"} ${action.targetCount} of ${total} items`;
  }
  return `${verb} ${action.included ? "to" : "from"} all`;
}

function progressDescription(item: LibraryChooserItem): string | null {
  switch (item.progress) {
    case "Settled": return null;
    case "Uncertain": return "change not confirmed";
    case "Reconciling": return "checking membership…";
    case "Pending": {
      if (item.confirmed === null || item.intended === null) return "updating…";
      const change = item.intended.included - item.confirmed.included;
      return change > 0 ? "adding…" : change < 0 ? "removing…" : "updating…";
    }
  }
}

export default function LibraryChooser({
  items,
  onCommit,
  loading,
  summary,
  error,
  creation,
  emptyInventory,
  status,
  searchLabel = creation === null ? "search libraries" : "search or create a library",
  listLabel = "library options",
}: LibraryChooserProps) {
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const [query, setQuery] = useState("");
  const [requestedActiveId, setActiveId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<{ text: string; sequence: number } | null>(null);
  const name = query.trim();
  const normalizedQuery = name.toLowerCase();
  const reserved = name !== "" && isReservedLibraryName(name);
  const tooLong = [...name].length > 100;
  const matching = useMemo(() => {
    const rank = (item: LibraryChooserItem) => {
      const candidate = item.name.trim().toLowerCase();
      return candidate === normalizedQuery ? 0 : candidate.startsWith(normalizedQuery) ? 1 : 2;
    };
    return items
      .filter((item) => item.name.trim().toLowerCase().includes(normalizedQuery))
      .toSorted((a, b) => rank(a) - rank(b) || compareLibraryNames(a, b));
  }, [items, normalizedQuery]);
  const canCreate = creation?.available === true && name !== "" && !reserved && !tooLong
    && !items.some((item) => item.id !== "SavedInNexus" && item.name.trim().toLowerCase() === normalizedQuery)
    && !creation.pendingNames.some((pending) => pending.trim().toLowerCase() === normalizedQuery);
  const suggestions: Suggestion[] = matching.map((item) => ({
    kind: "Library", id: `${baseId}-library-${item.id}`, item,
  }));
  if (canCreate) suggestions.push({ kind: "Create", id: `${baseId}-create`, name });
  const activeId = requestedActiveId !== null && suggestions.some((row) => row.id === requestedActiveId)
    ? requestedActiveId
    : normalizedQuery === "" ? null : suggestions[0]?.id ?? null;

  // Install a refresh's fallback so a previously removed id cannot later steal focus.
  useLayoutEffect(() => {
    if (requestedActiveId !== activeId) setActiveId(activeId);
    const list = listRef.current;
    if (!list || activeId === null) return;
    const option = document.getElementById(activeId);
    if (!option || !list.contains(option)) return;
    const top = list.getBoundingClientRect().top + list.clientTop;
    const bottom = top + list.clientHeight;
    const rect = option.getBoundingClientRect();
    // Only the results scroll; scrollIntoView would move the containing task.
    if (rect.top < top) list.scrollTop += rect.top - top;
    else if (rect.bottom > bottom) list.scrollTop += rect.bottom - bottom;
  }, [activeId, requestedActiveId, matching]);

  function announce(text: string) {
    setAnnouncement((previous) => ({ text, sequence: (previous?.sequence ?? 0) + 1 }));
  }

  function activate(suggestion: Suggestion) {
    let admission: LibraryChooserAdmission;
    if (suggestion.kind === "Create") {
      if (!creation?.available) return;
      admission = creation.onCreate(suggestion.name);
    } else {
      const { item } = suggestion;
      if (item.action.kind === "Blocked") {
        announce(item.action.reason);
        return;
      }
      admission = onCommit({ choiceId: item.id, included: item.action.included });
    }
    if (admission === "Rejected") return;
    announce(suggestion.kind === "Create"
      ? `creating “${suggestion.name}”…`
      : `${suggestion.item.name}: ${actionDescription(suggestion.item)}`);
    setQuery("");
    setActiveId(null);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (composing.current || event.nativeEvent.isComposing) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      if (suggestions.length === 0) return;
      const current = suggestions.findIndex((row) => row.id === activeId);
      const next = current < 0
        ? event.key === "ArrowDown" ? 0 : suggestions.length - 1
        : Math.max(0, Math.min(suggestions.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
      setActiveId(suggestions[next]!.id);
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      const suggestion = suggestions.find((row) => row.id === activeId);
      if (suggestion) activate(suggestion);
    }
    // Escape, Tab and all native text-editing keys retain their existing owners.
  }

  const validation = creation === null ? null : reserved ? RESERVED_LIBRARY_NAME_MESSAGE
    : tooLong ? "library names can contain at most 100 characters" : null;
  const empty = loading && items.length === 0 ? "loading libraries…"
    : normalizedQuery === "" ? emptyInventory : "no matching libraries";

  return (
    <div className={styles.chooser}>
      <div className={styles.searchHeader}>
        <Input
          ref={inputRef}
          bare
          className={styles.search}
          role="combobox"
          aria-label={searchLabel}
          aria-controls={listboxId}
          aria-expanded={true}
          aria-activedescendant={activeId ?? undefined}
          aria-describedby={`${baseId}-summary`}
          aria-autocomplete="list"
          value={query}
          placeholder={searchLabel}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveId(null);
            setAnnouncement(null);
          }}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={onKeyDown}
        />
      </div>
      <p id={`${baseId}-summary`} className={styles.summary}>{summary}</p>
      {status ? <p className={styles.status} role="status">{status}</p> : null}
      {validation ? <p className={styles.status} role="status">{validation}</p> : null}
      <div className={styles.srOnly} role="status" aria-atomic="true">
        {announcement ? <span key={announcement.sequence}>{announcement.text}</span> : null}
      </div>
      {error ? (
        <FeedbackNotice
          content={error.content}
          announcement="Assertive"
          actions={error.onRetry ? [{ label: "retry", onClick: error.onRetry }] : undefined}
        />
      ) : null}
      <div ref={listRef} id={listboxId} role="listbox" aria-label={listLabel}
        aria-busy={loading || undefined} className={styles.list}>
        {suggestions.map((suggestion) => {
          const item = suggestion.kind === "Library" ? suggestion.item : null;
          const blocked = item?.action.kind === "Blocked";
          const progress = item === null ? null : progressDescription(item);
          const description = item === null ? null : [
            item.note ?? null,
            membershipDescription(item.confirmed),
            progress,
            actionDescription(item),
            item.provenance.length > 0 ? `inherited from ${item.provenance.map(({ name }) => name).join(", ")}` : null,
            ...item.exclusions.map(({ reason, count }) => `${count}: ${libraryPlacementBlockedReasonMessage(reason)}`),
          ].filter((part) => part !== null).join(" · ");
          return (
            <div key={suggestion.id} id={suggestion.id} role="option"
              aria-selected={suggestion.id === activeId}
              aria-disabled={blocked || undefined}
              aria-labelledby={`${suggestion.id}-name`}
              aria-describedby={description ? `${suggestion.id}-description` : undefined}
              className={styles.option}
              data-active={suggestion.id === activeId || undefined}
              onMouseDown={(event) => {
                if (document.activeElement === inputRef.current) event.preventDefault();
              }}
              onMouseMove={() => setActiveId(suggestion.id)}
              onClick={() => activate(suggestion)}>
              <span className={styles.optionText}>
                <span id={`${suggestion.id}-name`} className={styles.optionName}>
                  {suggestion.kind === "Create" ? `create “${suggestion.name}”` : suggestion.item.name}
                </span>
                {description ? <span id={`${suggestion.id}-description`} className={styles.optionDescription}>{description}</span> : null}
              </span>
              {item === null ? <Plus size={16} aria-hidden="true" />
                : item.progress === "Pending" || item.progress === "Reconciling"
                  ? <span className={styles.spinner}><Loader2 size={16} aria-hidden="true" /></span>
                  : blocked ? <Lock size={16} aria-hidden="true" />
                    : item.confirmed && item.confirmed.included > 0
                      ? <span className={styles.check}>{item.confirmed.included === item.confirmed.total
                        ? <Check size={16} aria-hidden="true" /> : <Minus size={16} aria-hidden="true" />}</span>
                      : null}
            </div>
          );
        })}
        {suggestions.length === 0 && error === null ? <div className={styles.empty}>{empty}</div> : null}
      </div>
    </div>
  );
}
