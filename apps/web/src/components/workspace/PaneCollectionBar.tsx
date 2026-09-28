"use client";

import { useId, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { X } from "lucide-react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import PaneToolbar from "@/components/ui/PaneToolbar";
import PaneFilterRowsStatus from "@/components/workspace/PaneFilterRowsStatus";
import type { PaneFilterRowsStatus as RowStatus } from "@/lib/panes/paneFilterRows";
import styles from "./PaneCollectionBar.module.css";

export default function PaneCollectionBar({
  inputRef,
  inputLabel,
  placeholder,
  query,
  onQueryChange,
  onClearQuery,
  rowStatus,
  filters,
  controls,
  appliedFilters,
}: {
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly inputLabel: string;
  readonly placeholder: string;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly onClearQuery: () => void;
  readonly rowStatus: RowStatus;
  readonly filters?: ReactNode;
  readonly controls?: ReactNode;
  readonly appliedFilters?: ReactNode;
}) {
  const statusId = useId();
  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    onClearQuery();
  };
  return (
    <PaneToolbar
      variant="Collection"
      search={
        <div className={styles.search}>
          <Input
            ref={inputRef}
            type="search"
            size="sm"
            value={query}
            aria-label={inputLabel}
            aria-describedby={statusId}
            aria-keyshortcuts="Escape"
            placeholder={placeholder}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            data-pane-collection-input="true"
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={handleInputKeyDown}
          />
          {query ? (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Clear text filter"
              title="Clear text filter"
              onClick={() => {
                onClearQuery();
                inputRef.current?.focus({ preventScroll: true });
              }}
            >
              <X size={15} aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      }
      filters={filters}
      controls={controls}
      summary={
        <div className={styles.summary}>
          {appliedFilters}
          <PaneFilterRowsStatus
            id={statusId}
            status={rowStatus}
            query={query}
            visible
          />
        </div>
      }
    />
  );
}
