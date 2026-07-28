"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CompositionEvent,
  type KeyboardEvent,
} from "react";
import Input from "@/components/ui/Input";
import type { UserSearchResult } from "@/lib/users/search";
import styles from "./PeopleSearchCombobox.module.css";

function labelFor(person: UserSearchResult): string {
  return person.displayName.kind === "Present"
    ? person.displayName.value
    : person.email.kind === "Present"
      ? person.email.value
      : person.userHandle;
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

  const setActiveIndex = (next: number | ((current: number) => number)) => {
    const resolved =
      typeof next === "function" ? next(activeIndexRef.current) : next;
    activeIndexRef.current = resolved;
    setRenderedActiveIndex(resolved);
  };

  useEffect(() => {
    const next =
      results.length === 0
        ? -1
        : Math.min(Math.max(activeIndexRef.current, 0), results.length - 1);
    activeIndexRef.current = next;
    setRenderedActiveIndex(next);
  }, [results]);

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
      setActiveIndex((current) => {
        if (event.key === "Home") return 0;
        if (event.key === "End") return results.length - 1;
        if (event.key === "ArrowDown") {
          return current < 0 ? 0 : (current + 1) % results.length;
        }
        return current <= 0 ? results.length - 1 : current - 1;
      });
      return;
    }
    const currentActiveIndex = activeIndexRef.current;
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
          expanded && activeIndex >= 0 ? optionIds[activeIndex] : undefined
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
              aria-selected={index === activeIndex}
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
