"use client";

import {
  useEffect,
  useMemo,
  useState,
  type CompositionEvent,
  type KeyboardEvent,
} from "react";
import Input from "@/components/ui/Input";
import styles from "./PeopleSearchCombobox.module.css";

export interface PeopleSearchResult {
  userHandle: string;
  email: string | null;
  displayName: string | null;
}

function labelFor(person: PeopleSearchResult): string {
  return person.displayName ?? person.email ?? person.userHandle;
}

export default function PeopleSearchCombobox({
  id,
  label,
  placeholder,
  query,
  results,
  searching = false,
  disabled = false,
  onQueryChange,
  onSelect,
}: {
  id: string;
  label: string;
  placeholder: string;
  query: string;
  results: readonly PeopleSearchResult[];
  searching?: boolean;
  disabled?: boolean;
  onQueryChange: (query: string) => void;
  onSelect: (person: PeopleSearchResult) => void;
}) {
  const [open, setOpen] = useState(true);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [composing, setComposing] = useState(false);
  const expanded = !disabled && open && results.length > 0;
  const optionIds = useMemo(
    () => results.map((_, index) => `${id}-option-${index}`),
    [id, results],
  );

  useEffect(() => {
    setActiveIndex((current) =>
      results.length === 0 ? -1 : Math.min(Math.max(current, 0), results.length - 1),
    );
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
    if (event.key === "Enter" && expanded && activeIndex >= 0) {
      event.preventDefault();
      selectIndex(activeIndex);
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
        type="search"
        value={query}
        placeholder={placeholder}
        aria-label={label}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={id}
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
      {searching ? <span role="status">Searching…</span> : null}
      {expanded ? (
        <ul id={id} role="listbox" className={styles.results}>
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
              {person.displayName && person.email ? (
                <span>{person.email}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
