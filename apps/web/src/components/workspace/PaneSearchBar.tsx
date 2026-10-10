"use client";

import { forwardRef, useId } from "react";
import { X } from "lucide-react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import PaneToolbar from "@/components/ui/PaneToolbar";
import PaneFilterRowsStatus from "@/components/workspace/PaneFilterRowsStatus";
import type { PaneFilterRowsSearch } from "@/lib/panes/paneChrome";
import styles from "./PaneCollectionBar.module.css";

/** The pane's filter row (Find has FindBar); its input names its status. Esc or ✕ closes it. */
const PaneSearchBar = forwardRef<
  HTMLInputElement,
  { readonly search: PaneFilterRowsSearch; readonly onClose: () => void }
>(function PaneSearchBar({ search, onClose }, ref) {
  const statusId = useId();
  return (
    <div
      className={styles.bar}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
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
            value={search.query}
            aria-label={search.inputLabel}
            aria-describedby={statusId}
            aria-keyshortcuts="Escape"
            placeholder={search.placeholder}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            data-pane-search-input="true"
            onChange={(event) => search.onQueryChange(event.target.value)}
          />
        }
        controls={
          <>
            <PaneFilterRowsStatus
              id={statusId}
              status={search.rowStatus}
              query={search.query}
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
