"use client";

// Search names or an exact account email. The server owns recipient identity and
// decides whether an email may be returned; pass that person unchanged to the
// invitation or immediate-sharing owner. Query, admission and keyed suggestion
// belong to this field; a selected person displays until the viewer types again.

import { useId, useRef, useState } from "react";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import Input from "@/components/ui/Input";
import collection from "@/components/ui/Collection.module.css";
import { apiFetch } from "@/lib/api/client";
import { usePaneFreeServerValue, useSettled } from "@/lib/api/serverState";
import type { Schema } from "@/lib/api/wire";
import { reconcileSearchActive, useSearchOptions, type SearchActive } from "@/lib/ui/searchOptions";
import styles from "./PeopleSearch.module.css";

export type Person = Schema<"UserSearchOut">;

export const personLabel = (person: {
  readonly display_name: string | null;
  readonly email: string | null;
}) => person.display_name ?? person.email ?? "Unknown person";

export default function PeopleSearch({
  context,
  label,
  placeholder,
  description,
  disabled,
  selected = null,
  onSelect,
}: {
  readonly context: string;
  readonly label: string;
  readonly placeholder: string;
  readonly description?: string;
  readonly disabled: boolean;
  readonly selected?: Person | null;
  /** A pick answered false keeps the query, so it can be picked again. */
  readonly onSelect: (person: Person | null) => void | Promise<boolean>;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<SearchActive>(null);
  const q = query.trim();
  const searchContext = JSON.stringify([context, query]);
  const settled = useSettled(searchContext, 250);
  const readKey = selected === null && q.length >= 3 && settled === searchContext
    ? `/users/search?q=${encodeURIComponent(q)}` : null;
  const search = usePaneFreeServerValue({
    key: readKey,
    stale: "",
    load: async signal => (await apiFetch<{ data: Person[] }>(
      `/api/users/search?${new URLSearchParams({ q })}`, { signal },
    )).data,
  });
  const admitted = readKey !== null && search.status === "ready";
  const results = admitted ? search.data : [];
  const expanded = !disabled && open && selected === null && q.length >= 3;
  const options = results.map(person => ({ key: person.user_id, disabledReason: null }));
  const current = reconcileSearchActive({
    context: searchContext, admitted, options, firstExistingKey: results[0]?.user_id ?? null, active,
  });
  if (current !== active) setActive(current);
  const navigation = useSearchOptions<HTMLUListElement>({
    listId: `${id}-list`, label, open: expanded, options, activeKey: current?.key ?? null,
    onActiveChange: key => setActive({ context: searchContext, key }),
    onActivate: key => {
      const person = results.find(person => person.user_id === key);
      if (person === undefined || disabled || !admitted) return;
      setOpen(false);
      void Promise.resolve(onSelect(person)).then(accepted => {
        if (accepted !== false) setQuery("");
      });
    },
  });
  const status = selected !== null || q === "" ? null
    : q.length < 3 ? "Enter at least 3 characters."
      : search.status === "failed" ? "People couldn’t be searched. Try again."
        : !admitted ? "Searching…"
          : results.length === 0 ? "No matching Nexus users."
            : `${results.length} ${results.length === 1 ? "result" : "results"}`;

  return (
    <div className={styles.root}>
      <Input
        ref={input}
        type="search"
        className={collection.search}
        {...navigation.inputProps}
        value={selected === null ? query : personLabel(selected)}
        placeholder={placeholder}
        aria-label={label}
        aria-describedby={[
          description && `${id}-description`, status && `${id}-status`,
        ].filter(Boolean).join(" ") || undefined}
        aria-busy={status === "Searching…" || undefined}
        disabled={disabled}
        onFocus={() => setOpen(true)}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={event => {
          if (navigation.handleKey(event.nativeEvent, composing.current)) {
            event.preventDefault();
            event.stopPropagation();
          } else if (expanded && event.key === "Escape" && !composing.current && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }
        }}
        onChange={event => {
          if (selected !== null) onSelect(null);
          setQuery(event.target.value);
          setOpen(true);
        }}
      />
      {description ? <span id={`${id}-description`} className={collection.detail}>{description}</span> : null}
      {status ? <div id={`${id}-status`}>
        {search.status === "failed" ? <FeedbackNotice
          content={{ tone: "Warning", title: "people search couldn’t load", requestId: search.error.requestId }}
          announcement="Polite"
          actions={[{ label: "retry search", onClick: search.refetch, busy: search.retrying }]}
          returnFocus={() => input.current}
        /> : <FeedbackStatus content={{ tone: "Neutral", title: status }} announcement="Polite" />}
      </div> : null}
      {expanded ? <ul ref={navigation.listRef} {...navigation.listProps}
        aria-busy={!admitted || undefined} className={`${collection.surface} ${collection.compactViewport}`}>
        {results.map(person => <li key={person.user_id} {...navigation.optionProps(person.user_id)} className={collection.row}>
          <span className={collection.content}>
            <span>{personLabel(person)}</span>
            {person.display_name !== null && person.email !== null ? <span className={collection.detail}>{person.email}</span> : null}
          </span>
        </li>)}
      </ul> : null}
    </div>
  );
}
