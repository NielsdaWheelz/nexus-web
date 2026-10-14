"use client";

import { useId, useRef, useState } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import LibraryChooser, {
  type LibraryChooserItem,
} from "@/components/libraries/LibraryChooser";
import LibraryChooserSurface from "@/components/libraries/LibraryChooserSurface";
import { useLibraryDestinationSearch } from "@/components/libraries/useLibraryDestinationSearch";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import {
  isLibraryDestinationDefect,
  searchWritableLibraryDestinations,
} from "@/lib/libraries/client";
import type { LibraryDestinationSelection } from "@/lib/libraries/destinationContract";
import {
  isReservedLibraryName,
  RESERVED_LIBRARY_NAME_MESSAGE,
} from "@/lib/libraries/presentation";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import styles from "./LibraryDestinationPicker.module.css";

const DESTINATION_PAGE_LIMIT = 25;

export type DestinationSelection =
  | {
      kind: "Item";
      selected: readonly LibraryDestinationSelection[];
      onChange: (next: readonly LibraryDestinationSelection[]) => void;
    }
  | {
      kind: "Bulk";
      entries: readonly {
        destination: LibraryDestinationSelection;
        state: "All" | "Some";
      }[];
      onSet: (change: {
        destination: LibraryDestinationSelection;
        included: boolean;
      }) => void;
    };

export interface LibraryDestinationPickerProps {
  open: boolean;
  presentation: "Responsive" | "Inline";
  onClose: () => void;
  anchor: ReturnFocusTarget;
  skipReturnFocus?: () => boolean;
  title: string;
  selectedGroupLabel: string;
  selection: DestinationSelection;
  interaction:
    | { kind: "Enabled" }
    | { kind: "Disabled" }
    | { kind: "Creating" };
  onCreateDestination: (name: string) => Promise<LibraryDestinationSelection>;
  panelId?: string;
}

function toItem(
  destination: LibraryDestinationSelection,
  selected: boolean,
): LibraryChooserItem {
  return {
    id: destination.id,
    name: destination.name,
    selected,
    interaction: { kind: "Enabled" },
  };
}

/**
 * The writable-destination adapter. It runs the shared destination search over
 * the web transport, edits one local selection or emits bulk add/remove deltas,
 * offers create, and renders the caller's chosen surface. It is always mounted by
 * LibraryDestinationField, so query and last-good results survive a close and
 * reopening re-issues the preserved query immediately.
 */
export default function LibraryDestinationPicker({
  open,
  presentation,
  onClose,
  anchor,
  skipReturnFocus,
  title,
  selectedGroupLabel,
  selection,
  interaction,
  onCreateDestination,
  panelId,
}: LibraryDestinationPickerProps) {
  const statusId = useId();
  const bulkSearchRef = useRef<HTMLInputElement>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createDefect, setCreateDefect] = useState<{ error: unknown } | null>(
    null,
  );
  const enabled = interaction.kind !== "Disabled";
  const creating = interaction.kind === "Creating";
  const busy = interaction.kind !== "Enabled";
  const selected = selection.kind === "Item"
    ? selection.selected
    : selection.entries.map(({ destination }) => destination);
  const {
    query,
    setQuery,
    normalizedQuery,
    results,
    resultsQuery,
    nextCursor,
    loading,
    loadingMore,
    failure,
    retry,
    loadMore,
  } = useLibraryDestinationSearch<unknown>({
    active: open && enabled,
    search: ({ q, cursor, signal }) =>
      searchWritableLibraryDestinations({
        q,
        cursor,
        limit: DESTINATION_PAGE_LIMIT,
        signal,
      }).then(
        (page) => ({ kind: "page" as const, page }),
        (caught: unknown) =>
          handleUnauthenticatedApiError(caught)
            ? { kind: "handled" as const }
            : { kind: "failure" as const, failure: caught },
      ),
  });

  const selectedIds = new Set(selected.map((destination) => destination.id));

  function toggle(id: string) {
    if (busy || selection.kind !== "Item") return;
    if (selectedIds.has(id)) {
      selection.onChange(selected.filter((d) => d.id !== id));
      return;
    }
    const destination = results.find((d) => d.id === id);
    if (destination) selection.onChange([...selected, destination]);
  }

  async function runCreate(name: string) {
    if (busy) return;
    setCreateError(null);
    try {
      const destination = await onCreateDestination(name);
      if (selection.kind === "Bulk") {
        selection.onSet({ destination, included: true });
      } else if (!selectedIds.has(destination.id)) {
        selection.onChange([...selected, destination]);
      }
      setQuery("");
    } catch (caught) {
      if (isAbortError(caught)) return;
      if (handleUnauthenticatedApiError(caught)) return;
      if (isLibraryDestinationDefect(caught)) {
        setCreateDefect({ error: caught });
        return;
      }
      setCreateError(
        caught instanceof Error ? caught.message : "Couldn’t create the library.",
      );
    }
  }

  const createName = query.trim();
  const normalizedCreateName = createName.toLowerCase();
  const createNameReserved =
    createName.length > 0 && isReservedLibraryName(createName);
  const selectedItems = selected.map((d) => toItem(d, true));
  const otherItems = results
    .filter((d) => !selectedIds.has(d.id))
    .map((d) => toItem(d, false));
  const bulkStates = new Map(selection.kind === "Bulk"
    ? selection.entries.map(({ destination, state }) => [destination.id, state])
    : []);
  const resultIds = new Set(results.map(({ id }) => id));
  const bulkEntries = selection.kind === "Bulk"
    ? [
        ...selection.entries.filter(({ destination }) => !resultIds.has(destination.id)),
        ...results.map((destination) => ({
          destination,
          state: bulkStates.get(destination.id) ?? "None",
        })),
      ]
    : [];

  const canCreate =
    createName.length > 0 &&
    createName.length <= 100 &&
    !createNameReserved &&
    !loading &&
    !loadingMore &&
    failure === null &&
    createError === null &&
    nextCursor === null &&
    resultsQuery === normalizedCreateName &&
    !selected.some(
      (d) => d.name.trim().toLowerCase() === normalizedCreateName,
    ) &&
    !results.some((d) => d.name.trim().toLowerCase() === normalizedCreateName);

  const count = selectedItems.length + otherItems.length;
  const status = creating
    ? "Creating library…"
    : loading
      ? "Loading libraries…"
      : loadingMore
        ? "Loading more libraries…"
        : createNameReserved
          ? RESERVED_LIBRARY_NAME_MESSAGE
          : count === 1
            ? "1 library"
            : `${count} libraries`;

  const emptyState = loading
    ? null
    : createNameReserved
      ? RESERVED_LIBRARY_NAME_MESSAGE
      : count === 0
        ? normalizedQuery === ""
          ? "No libraries yet. Type a name to create one."
          : "No libraries match your search."
        : null;

  const chooserError =
    failure !== null
      ? {
          content: {
            tone: "Danger" as const,
            title:
              failure instanceof Error
                ? failure.message
                : "Couldn’t load your libraries.",
          },
          onRetry: retry,
        }
      : createError !== null
        ? {
            content: { tone: "Danger" as const, title: createError },
            onRetry: () => {
              setCreateError(null);
              retry();
            },
          }
        : null;

  if (failure !== null && isLibraryDestinationDefect(failure)) throw failure;
  if (createDefect) throw createDefect.error;

  return (
    <LibraryChooserSurface
      active={open}
      presentation={presentation}
      onClose={creating ? null : onClose}
      anchor={anchor}
      skipReturnFocus={skipReturnFocus}
      title={title}
      panelId={panelId}
    >
      {selection.kind === "Item" ? (
        <LibraryChooser
          query={query}
          onQueryChange={setQuery}
          searchPlaceholder="Search or create"
          searchLabel="Search or create a library"
          listLabel="Library options"
          selectedGroup={{ label: selectedGroupLabel, items: selectedItems }}
          otherGroup={{ label: "Other libraries", items: otherItems }}
          onToggle={toggle}
          busy={busy}
          loading={loading}
          status={status}
          emptyState={emptyState}
          error={chooserError}
          create={
            canCreate
              ? {
                  name: createName,
                  pending: creating,
                  onCreate: () => void runCreate(createName),
                }
              : null
          }
          loadMore={
            nextCursor !== null
              ? { pending: loadingMore, onLoadMore: loadMore }
              : null
          }
        />
      ) : (
        <div className={styles.bulk}>
          <div className={styles.searchHeader}>
            <Input
              ref={bulkSearchRef}
              bare
              className={styles.search}
              aria-label="Search or create a library"
              aria-describedby={statusId}
              value={query}
              readOnly={busy}
              placeholder="Search or create"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div
            id={statusId}
            role={chooserError === null ? "status" : undefined}
            className={styles.srOnly}
          >
            {chooserError === null ? status : ""}
          </div>
          {chooserError !== null ? (
            <FeedbackNotice
              content={chooserError.content}
              announcement="Assertive"
              actions={busy ? undefined : [{ label: "Retry", onClick: chooserError.onRetry }]}
            />
          ) : null}
          <div
            role="group"
            aria-label="Library options"
            aria-busy={busy || loading || undefined}
            className={styles.choices}
          >
            {bulkEntries.map(({ destination, state }) => (
              <label key={destination.id} className={styles.choice}>
                <input
                  type="checkbox"
                  checked={state === "All"}
                  ref={(input) => {
                    if (input) input.indeterminate = state === "Some";
                  }}
                  disabled={busy}
                  onChange={() => {
                    if (state === "All" && !resultIds.has(destination.id)) {
                      bulkSearchRef.current?.focus({ preventScroll: true });
                    }
                    selection.onSet({ destination, included: state !== "All" });
                  }}
                />
                <span className={styles.name}>{destination.name}</span>
              </label>
            ))}
            {canCreate ? (
              <Button
                variant="ghost"
                className={styles.action}
                disabled={busy}
                loading={creating}
                onClick={() => {
                  bulkSearchRef.current?.focus({ preventScroll: true });
                  void runCreate(createName);
                }}
              >
                Create “{createName}”
              </Button>
            ) : null}
            {nextCursor !== null ? (
              <Button
                variant="ghost"
                className={styles.action}
                disabled={busy}
                loading={loadingMore}
                onClick={() => {
                  bulkSearchRef.current?.focus({ preventScroll: true });
                  loadMore();
                }}
              >
                {loadingMore ? "Loading more libraries…" : "Load more libraries"}
              </Button>
            ) : null}
            {emptyState !== null && chooserError === null && !canCreate ? (
              <p className={styles.empty}>{emptyState}</p>
            ) : null}
          </div>
        </div>
      )}
    </LibraryChooserSurface>
  );
}
