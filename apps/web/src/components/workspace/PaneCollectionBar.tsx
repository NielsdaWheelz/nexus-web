"use client";

import {
  useCallback,
  useId,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { X } from "lucide-react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import PaneToolbar from "@/components/ui/PaneToolbar";
import PaneFilterRowsStatus from "@/components/workspace/PaneFilterRowsStatus";
import type { PaneFilterRowsStatus as RowStatus } from "@/lib/panes/paneFilterRows";
import styles from "./PaneCollectionBar.module.css";

/**
 * The collection row's input handle. `focusInput` is the pane's Cmd/Ctrl+F:
 * it scrolls the row into view and focuses the input, and says whether it could.
 */
export function usePaneCollectionInput() {
  const inputRef = useRef<HTMLInputElement>(null);
  const focusInput = useCallback((): boolean => {
    const input = inputRef.current;
    const scrollport = input?.closest<HTMLElement>(
      "[data-pane-content='true']",
    );
    if (
      !input?.isConnected ||
      !scrollport ||
      input.disabled ||
      input.closest("[inert], [aria-hidden='true']") ||
      input.getClientRects().length === 0 ||
      getComputedStyle(input).visibility !== "visible"
    )
      return false;
    scrollport.scrollTop = 0;
    input.focus({ preventScroll: true });
    if (document.activeElement !== input) return false;
    input.select();
    return true;
  }, []);
  return { inputRef, focusInput };
}

/** A collection pane's row: text filter (Esc clears), filters, chips and a terse status. */
export default function PaneCollectionBar(props: {
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
  const { inputRef, query, onClearQuery } = props;
  const statusId = useId();
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
            aria-label={props.inputLabel}
            aria-describedby={statusId}
            aria-keyshortcuts="Escape"
            placeholder={props.placeholder}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            data-pane-collection-input="true"
            onChange={(event) => props.onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || event.defaultPrevented) return;
              event.preventDefault();
              event.stopPropagation();
              onClearQuery();
            }}
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
      filters={props.filters}
      controls={props.controls}
      summary={
        <div className={styles.summary}>
          {props.appliedFilters}
          <PaneFilterRowsStatus
            id={statusId}
            status={props.rowStatus}
            query={query}
            visible
          />
        </div>
      }
    />
  );
}
