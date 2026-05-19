"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import PaletteRow from "./PaletteRow";
import type { PaletteCommand, PaletteView } from "./types";
import styles from "./PaletteBody.module.css";

interface PaletteBodyProps {
  view: PaletteView;
  query: string;
  searchLoading: boolean;
  scopeLabel: string | null;
  activeCommandId: string | null;
  showShortcuts: boolean;
  autoFocusInput: boolean;
  onQueryChange(query: string): void;
  onClearScope(): void;
  onSelect(command: PaletteCommand): void;
  onActiveCommandChange?(commandId: string): void;
}

function flattenView(view: PaletteView): PaletteCommand[] {
  return view.state === "resting"
    ? view.groups.flatMap((group) => group.commands)
    : view.results;
}

export default function PaletteBody({
  view,
  query,
  searchLoading,
  scopeLabel,
  activeCommandId,
  showShortcuts,
  autoFocusInput,
  onQueryChange,
  onClearScope,
  onSelect,
  onActiveCommandChange,
}: PaletteBodyProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);

  useEffect(() => {
    if (!autoFocusInput) return;
    // Defer past a shell's <dialog>.showModal(), which would otherwise pull focus to the dialog.
    const focus = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(focus);
  }, [autoFocusInput]);

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (composingRef.current) return;

    if (event.key === "Enter") {
      event.preventDefault();
      const commands = flattenView(view);
      const target =
        commands.find((command) => command.id === activeCommandId) ?? commands[0];
      if (target && !target.disabled) onSelect(target);
      return;
    }

    if (!onActiveCommandChange) return;
    if (
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }

    event.preventDefault();
    const commands = flattenView(view);
    if (commands.length === 0) return;
    const current = commands.findIndex((command) => command.id === activeCommandId);
    const start = current >= 0 ? current : 0;
    const last = commands.length - 1;
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? last
          : event.key === "ArrowDown"
            ? Math.min(last, start + 1)
            : Math.max(0, start - 1);
    onActiveCommandChange(commands[next]!.id);
  }

  return (
    <>
      {scopeLabel !== null ? (
        <div className={styles.scopeRow} data-testid="palette-scope-chip">
          <span className={styles.scopeLabel}>{scopeLabel}</span>
          <Button
            iconOnly
            variant="ghost"
            size="md"
            type="button"
            aria-label="Clear scope"
            onClick={onClearScope}
          >
            <X size={16} aria-hidden="true" />
          </Button>
        </div>
      ) : null}

      <div className={styles.inputRow}>
        <Input
          ref={inputRef}
          variant="bare"
          role="combobox"
          aria-label="Search commands"
          aria-expanded="true"
          aria-controls="palette-listbox"
          aria-autocomplete="list"
          aria-activedescendant={
            activeCommandId ? `palette-option-${activeCommandId}` : undefined
          }
          className={styles.input}
          value={query}
          placeholder="Search or run an action…"
          enterKeyHint="search"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => onQueryChange(event.target.value)}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onKeyDown={onKeyDown}
        />
      </div>

      <div
        id="palette-listbox"
        className={styles.list}
        role="listbox"
        aria-busy={searchLoading || undefined}
      >
        {renderView(view, searchLoading, activeCommandId, showShortcuts, onSelect, onActiveCommandChange)}
      </div>
    </>
  );
}

function renderView(
  view: PaletteView,
  searchLoading: boolean,
  activeCommandId: string | null,
  showShortcuts: boolean,
  onSelect: (command: PaletteCommand) => void,
  onActiveCommandChange: ((commandId: string) => void) | undefined,
) {
  switch (view.state) {
    case "resting":
      return view.groups.map((group) => {
        const headingId = `palette-group-${group.sectionId}`;
        return (
          <section key={group.sectionId} className={styles.section}>
            <h3 id={headingId} className={styles.sectionTitle}>
              {group.label}
            </h3>
            <div role="group" aria-labelledby={headingId}>
              {group.commands.map((command) => (
                <PaletteRow
                  key={command.id}
                  command={command}
                  selected={command.id === activeCommandId}
                  showTag={false}
                  showShortcut={showShortcuts}
                  onSelect={onSelect}
                  onHover={onActiveCommandChange}
                />
              ))}
            </div>
          </section>
        );
      });
    case "querying": {
      const noMatches =
        !searchLoading &&
        view.results.every((command) => command.pin === "last");
      return (
        <>
          {searchLoading ? (
            <div className={styles.loading} role="status">
              Searching…
            </div>
          ) : null}
          {noMatches ? (
            <div className={styles.empty} role="status">
              No matches
            </div>
          ) : null}
          {view.results.map((command) => (
            <PaletteRow
              key={command.id}
              command={command}
              selected={command.id === activeCommandId}
              showTag
              showShortcut={showShortcuts}
              onSelect={onSelect}
              onHover={onActiveCommandChange}
            />
          ))}
        </>
      );
    }
    default: {
      const exhaustive: never = view;
      return exhaustive;
    }
  }
}
