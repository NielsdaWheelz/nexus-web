"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import Button from "@/components/ui/Button";
import PaletteBody from "./PaletteBody";
import type { PaletteCommand, PaletteView } from "./types";
import styles from "./PaletteDesktopShell.module.css";

interface PaletteDesktopShellProps {
  query: string;
  view: PaletteView;
  searchLoading: boolean;
  scopeLabel: string | null;
  initialActiveCommandId: string | null;
  onQueryChange(query: string): void;
  onClearScope(): void;
  onSelect(command: PaletteCommand): void;
  onClose(): void;
}

export default function PaletteDesktopShell({
  query,
  view,
  searchLoading,
  scopeLabel,
  initialActiveCommandId,
  onQueryChange,
  onClearScope,
  onSelect,
  onClose,
}: PaletteDesktopShellProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [activeCommandId, setActiveCommandId] = useState<string | null>(
    initialActiveCommandId ?? null,
  );

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  useEffect(() => {
    const flat =
      view.state === "resting"
        ? view.groups.flatMap((group) => group.commands)
        : view.results;
    setActiveCommandId((current) =>
      flat.some((command) => command.id === current) ? current : (flat[0]?.id ?? null),
    );
  }, [view]);

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby="palette-title"
      onCancel={(event) => {
        event.preventDefault();
        if (scopeLabel !== null) onClearScope();
        else onClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
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
            onClick={onClose}
          >
            <X size={16} aria-hidden="true" />
          </Button>
        </header>

        <PaletteBody
          view={view}
          query={query}
          searchLoading={searchLoading}
          scopeLabel={scopeLabel}
          activeCommandId={activeCommandId}
          showShortcuts
          autoFocusInput
          onQueryChange={onQueryChange}
          onClearScope={onClearScope}
          onSelect={onSelect}
          onActiveCommandChange={setActiveCommandId}
        />
      </div>
    </dialog>
  );
}
