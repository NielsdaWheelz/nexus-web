"use client";

import { forwardRef, useId } from "react";
import { X } from "lucide-react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import PaneToolbar from "@/components/ui/PaneToolbar";
import PaneFilterRowsStatus from "@/components/workspace/PaneFilterRowsStatus";
import type { PaneFilterRowsPublication } from "@/lib/panes/paneSearch";
import styles from "./PaneSearchBar.module.css";

/** The pane's filter row. Find has its own bar (components/find/FindBar). */
const PaneSearchBar = forwardRef<
  HTMLInputElement,
  {
    readonly publication: PaneFilterRowsPublication;
    readonly onClose: () => void;
  }
>(function PaneSearchBar({ publication, onClose }, ref) {
  const statusId = useId();

  return (
    <div
      className={styles.bar}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <PaneToolbar
        variant="Refinement"
        search={
          <Input
            ref={ref}
            type="search"
            size="sm"
            value={publication.query}
            aria-label={publication.inputLabel}
            aria-keyshortcuts="Escape"
            placeholder={publication.placeholder}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            data-pane-search-input="true"
            onChange={(event) => publication.onQueryChange(event.target.value)}
          />
        }
        controls={
          <>
            <PaneFilterRowsStatus
              id={statusId}
              status={publication.rowStatus}
              query={publication.query}
              visible={false}
            />
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Close search"
              title="Close search"
              onClick={onClose}
            >
              <X size={15} aria-hidden="true" />
            </Button>
          </>
        }
      />
    </div>
  );
});

export default PaneSearchBar;
