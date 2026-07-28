"use client";

import {
  useId,
  useMemo,
  useRef,
  useState,
  type CompositionEvent,
  type KeyboardEvent,
} from "react";
import Input from "@/components/ui/Input";
import { nextRovingIndexForKey } from "@/lib/ui/rovingIndex";
import type { UserSearchResult } from "@/lib/users/search";
import styles from "./PeopleSearchCombobox.module.css";

function labelFor(person: UserSearchResult): string {
  return person.displayName.kind === "Present"
    ? person.displayName.value
    : person.email.kind === "Present"
      ? person.email.value
      : person.userHandle;
}

function normalizedActiveIndex(index: number, itemCount: number): number {
  if (itemCount === 0) return -1;
  return Math.min(Math.max(index, 0), itemCount - 1);
}

export default function PeopleSearchCombobox({
  label,
  placeholder,
  description,
  status,
  query,
  results,
  searching = false,
  disabled = false,
  onQueryChange,
  onSelect,
}: {
  label: string;
  placeholder: string;
  description?: string;
  status?: string;
  query: string;
  results: readonly UserSearchResult[];
  searching?: boolean;
  disabled?: boolean;
  onQueryChange: (query: string) => void;
  onSelect: (person: UserSearchResult) => void;
}) {
  const reactId = useId();
  const inputId = `${reactId}-input`;
  const listboxId = `${reactId}-listbox`;
  const descriptionId = description ? `${reactId}-description` : undefined;
  const statusId = status || searching ? `${reactId}-status` : undefined;
  const [open, setOpen] = useState(true);
  const [activeIndex, setRenderedActiveIndex] = useState(-1);
  const activeIndexRef = useRef(-1);
  const [composing, setComposing] = useState(false);
  const expanded = !disabled && open && results.length > 0;
  const optionIds = useMemo(
    () => results.map((_, index) => `${reactId}-option-${index}`),
    [reactId, results],
  );
  const effectiveActiveIndex = normalizedActiveIndex(activeIndex, results.length);

  const setActiveIndex = (next: number) => {
    activeIndexRef.current = next;
    setRenderedActiveIndex(next);
  };

  const selectIndex = (index: number) => {
    if (disabled) return;
    const person = results[index];
    if (!person) return;
    onSelect(person);
    setOpen(false);
    setActiveIndex(-1);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (composing || event.nativeEvent.isComposing) return;
    if (
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "Home" ||
      event.key === "End"
    ) {
      if (results.length === 0) return;
      event.preventDefault();
      setOpen(true);
      const next = nextRovingIndexForKey({
        key: event.key,
        currentIndex: normalizedActiveIndex(
          activeIndexRef.current,
          results.length,
        ),
        itemCount: results.length,
        orientation: "vertical",
        wrap: true,
      });
      if (next !== null) setActiveIndex(next);
      return;
    }
    const currentActiveIndex = normalizedActiveIndex(
      activeIndexRef.current,
      results.length,
    );
    if (event.key === "Enter" && expanded && currentActiveIndex >= 0) {
      event.preventDefault();
      selectIndex(currentActiveIndex);
      return;
    }
    if (event.key === "Escape" && expanded) {
      event.preventDefault();
      setOpen(false);
      setActiveIndex(-1);
    }
  };

  return (
    <div className={styles.root}>
      <Input
        id={inputId}
        type="search"
        value={query}
        placeholder={placeholder}
        aria-label={label}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listboxId}
        aria-describedby={
          [descriptionId, statusId].filter(Boolean).join(" ") || undefined
        }
        aria-busy={searching || undefined}
        disabled={disabled}
        aria-activedescendant={
          expanded && effectiveActiveIndex >= 0
            ? optionIds[effectiveActiveIndex]
            : undefined
        }
        onFocus={() => {
          if (!disabled) setOpen(true);
        }}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={(event: CompositionEvent<HTMLInputElement>) => {
          setComposing(false);
          onQueryChange(event.currentTarget.value);
        }}
        onKeyDown={handleKeyDown}
        onChange={(event) => {
          onQueryChange(event.target.value);
          setOpen(true);
        }}
      />
      {description ? (
        <span id={descriptionId} className={styles.description}>
          {description}
        </span>
      ) : null}
      {status || searching ? (
        <span id={statusId} role="status" className={styles.status}>
          {status ?? "Searching…"}
        </span>
      ) : null}
      {expanded ? (
        <ul id={listboxId} role="listbox" className={styles.results}>
          {results.map((person, index) => (
            <li
              id={optionIds[index]}
              key={person.userHandle}
              role="option"
              className={styles.option}
              aria-selected={index === effectiveActiveIndex}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => selectIndex(index)}
            >
              <span>{labelFor(person)}</span>
              {person.displayName.kind === "Present" &&
              person.email.kind === "Present" ? (
                <span>{person.email.value}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
