"use client";

// Find an existing Nexus user: a combobox over people search, which matches a
// display name containing the query or an account's exact email (and returns an
// email only then). It owns its query, its read (after a pause, one per query)
// and its status; the caller decides what choosing a person does. A person found
// by their exact email carries it as the viewer typed it, which an invitation or a
// share stores. A controlled `selected` person shows in the field until the viewer
// types again.

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import Input from "@/components/ui/Input";
import { apiFetch } from "@/lib/api/client";
import { usePaneFreeServerValue, useSettled } from "@/lib/api/serverState";
import type { Schema } from "@/lib/api/wire";
import { nextRovingIndexForKey } from "@/lib/ui/rovingIndex";
import styles from "./PeopleSearch.module.css";

export type Person = Schema<"UserSearchOut">;

export const personLabel = (person: {
  readonly display_name: string | null;
  readonly email: string | null;
}) => person.display_name ?? person.email ?? "Unknown person";

export default function PeopleSearch({
  label,
  placeholder,
  description,
  disabled,
  selected = null,
  onSelect,
}: {
  readonly label: string;
  readonly placeholder: string;
  readonly description?: string;
  readonly disabled: boolean;
  readonly selected?: Person | null;
  /** A pick answered false (it didn't land) keeps the query, so it can be picked again. */
  readonly onSelect: (person: Person | null) => void | Promise<boolean>;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const q = query.trim();
  const settled = useSettled(q, 250);
  const search = usePaneFreeServerValue({
    key: selected === null && q.length >= 3 && settled === q ? `/users/search?q=${encodeURIComponent(q)}` : null,
    stale: "",
    load: async (signal) =>
      (
        await apiFetch<{ data: Person[] }>(
          `/api/users/search?${new URLSearchParams({ q })}`,
          { signal },
        )
      ).data,
  });
  const results = search.status === "ready" ? search.data : [];
  const expanded = !disabled && open && results.length > 0;
  const status =
    selected !== null || q === ""
      ? null
      : q.length < 3
        ? "Enter at least 3 characters."
        : search.status === "failed"
          ? "People couldn’t be searched. Try again."
          : search.status !== "ready"
            ? "Searching…"
            : results.length === 0
              ? "No matching Nexus users."
              : `${results.length} ${results.length === 1 ? "result" : "results"}`;

  const choose = async (person: Person | undefined) => {
    if (person === undefined) return;
    setOpen(false);
    const typed = person.email === null ? person : { ...person, email: q };
    if ((await onSelect(typed)) !== false) setQuery("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    const next = nextRovingIndexForKey({
      key: event.key,
      currentIndex: active,
      itemCount: results.length,
      orientation: "vertical",
      wrap: true,
    });
    if (next !== null) {
      event.preventDefault();
      setOpen(true);
      setActive(next);
    } else if (expanded && event.key === "Enter") {
      event.preventDefault();
      void choose(results[active]);
    } else if (expanded && event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div className={styles.root}>
      <Input
        ref={input}
        type="search"
        value={selected === null ? query : personLabel(selected)}
        placeholder={placeholder}
        aria-label={label}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={`${id}-list`}
        aria-activedescendant={expanded ? `${id}-${active}` : undefined}
        aria-describedby={
          [description && `${id}-description`, status && `${id}-status`]
            .filter(Boolean)
            .join(" ") || undefined
        }
        aria-busy={status === "Searching…" || undefined}
        disabled={disabled}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        onChange={(event) => {
          if (selected !== null) onSelect(null);
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
      />
      {description ? (
        <span id={`${id}-description`} className={styles.description}>
          {description}
        </span>
      ) : null}
      {status ? (
        <div id={`${id}-status`}>
          {search.status === "failed" ? <FeedbackNotice
            content={{ tone: "Warning", title: "people search couldn’t load", requestId: search.error.requestId }}
            announcement="Polite"
            actions={[{ label: "retry search", onClick: search.refetch, busy: search.retrying }]}
            returnFocus={() => input.current}
          /> : <FeedbackStatus content={{ tone: "Neutral", title: status }} announcement="Polite" />}
        </div>
      ) : null}
      {expanded ? (
        <ul id={`${id}-list`} role="listbox" aria-label={label} className={styles.results}>
          {results.map((person, index) => (
            <li
              id={`${id}-${index}`}
              key={person.user_id}
              role="option"
              aria-selected={index === active}
              className={styles.option}
              onMouseDown={(event) => event.preventDefault()}
              onPointerMove={() => setActive(index)}
              onClick={() => void choose(person)}
            >
              <span>{personLabel(person)}</span>
              {person.display_name !== null && person.email !== null ? (
                <span>{person.email}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
