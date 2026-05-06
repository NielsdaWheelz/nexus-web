"use client";

import { useEffect, useMemo, useRef } from "react";
import { X } from "lucide-react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import type { PaletteCommand, PaletteSection } from "./types";
import styles from "./Palette.module.css";

interface PaletteProps {
  open: boolean;
  query: string;
  sections: PaletteSection[];
  commands: PaletteCommand[];
  activeCommandId: string | null;
  loadingSectionIds: string[];
  onOpenChange(open: boolean): void;
  onQueryChange(query: string): void;
  onActiveCommandChange(commandId: string | null): void;
  onSelect(command: PaletteCommand): void;
}

function optionId(commandId: string): string {
  return `palette-option-${commandId}`;
}

export default function Palette({
  open,
  query,
  sections,
  commands,
  activeCommandId,
  loadingSectionIds,
  onOpenChange,
  onQueryChange,
  onActiveCommandChange,
  onSelect,
}: PaletteProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);

  const activeCommand = commands.find((command) => command.id === activeCommandId);
  const activeOptionId = activeCommand ? optionId(activeCommand.id) : undefined;
  const loadingSections = new Set(loadingSectionIds);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
      requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
      return;
    }

    if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (activeCommandId) return;
    onActiveCommandChange(commands[0]?.id ?? null);
  }, [activeCommandId, commands, onActiveCommandChange, open]);

  const orderedSections = useMemo(
    () => [...sections].sort((a, b) => a.order - b.order),
    [sections],
  );

  function moveActive(offset: number) {
    if (commands.length === 0) return;
    const current = commands.findIndex((command) => command.id === activeCommandId);
    const start = current >= 0 ? current : 0;
    const next = Math.max(0, Math.min(commands.length - 1, start + offset));
    onActiveCommandChange(commands[next]!.id);
  }

  function selectActive() {
    if (composingRef.current || activeCommand?.disabled) return;
    if (activeCommand) onSelect(activeCommand);
  }

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby="palette-title"
      onCancel={(event) => {
        event.preventDefault();
        onOpenChange(false);
      }}
      onClose={() => onOpenChange(false)}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
    >
      <div className={styles.panel}>
        <header className={styles.header}>
          <h2 id="palette-title" className={styles.title}>
            Command palette
          </h2>
          <Button
            iconOnly
            variant="ghost"
            size="sm"
            type="button"
            aria-label="Close command palette"
            onClick={() => onOpenChange(false)}
          >
            <X size={16} aria-hidden="true" />
          </Button>
        </header>

        <Input
          ref={inputRef}
          role="combobox"
          aria-label="Search commands"
          aria-expanded="true"
          aria-controls="palette-listbox"
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          className={styles.input}
          value={query}
          placeholder="Search or run an action..."
          onChange={(event) => onQueryChange(event.target.value)}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              moveActive(1);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              moveActive(-1);
              return;
            }
            if (event.key === "Home") {
              event.preventDefault();
              onActiveCommandChange(commands[0]?.id ?? null);
              return;
            }
            if (event.key === "End") {
              event.preventDefault();
              onActiveCommandChange(commands.at(-1)?.id ?? null);
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              selectActive();
            }
          }}
        />

        <div
          id="palette-listbox"
          className={styles.list}
          role="listbox"
          aria-busy={loadingSectionIds.length > 0 ? "true" : undefined}
        >
          {commands.length === 0 && loadingSectionIds.length === 0 ? (
            <div className={styles.empty} role="status">
              No matching commands
            </div>
          ) : null}

          {orderedSections.map((section) => {
            const sectionCommands = commands.filter((command) => command.sectionId === section.id);
            if (sectionCommands.length === 0 && !loadingSections.has(section.id)) return null;
            const headingId = `palette-section-${section.id}`;

            return (
              <section key={section.id} className={styles.section}>
                <h3 id={headingId} className={styles.sectionTitle}>
                  {section.label}
                </h3>
                <div role="group" aria-labelledby={headingId}>
                  {sectionCommands.map((command) => {
                    const Icon = command.icon;
                    const selected = command.id === activeCommandId;
                    const optionName = [
                      command.title,
                      section.label,
                      command.subtitle,
                      command.shortcutLabel,
                      command.disabled?.reason,
                    ]
                      .filter(Boolean)
                      .join(" ");

                    return (
                      <div
                        key={command.id}
                        id={optionId(command.id)}
                        role="option"
                        aria-selected={selected ? "true" : "false"}
                        aria-label={optionName}
                        aria-disabled={command.disabled ? "true" : undefined}
                        className={styles.option}
                        data-active={selected ? "true" : "false"}
                        data-disabled={command.disabled ? "true" : "false"}
                        onMouseMove={() => onActiveCommandChange(command.id)}
                        onClick={() => {
                          if (!command.disabled) onSelect(command);
                        }}
                      >
                        <Icon size={16} aria-hidden="true" />
                        <span className={styles.optionText}>
                          <span className={styles.optionTitle}>{command.title}</span>
                          {command.subtitle ? (
                            <span className={styles.optionSubtitle}>{command.subtitle}</span>
                          ) : null}
                        </span>
                        {command.disabled ? (
                          <span className={styles.optionMeta}>{command.disabled.reason}</span>
                        ) : command.shortcutLabel ? (
                          <span className={styles.optionMeta}>{command.shortcutLabel}</span>
                        ) : null}
                      </div>
                    );
                  })}
                  {loadingSections.has(section.id) ? (
                    <div className={styles.loading}>Searching...</div>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </dialog>
  );
}
