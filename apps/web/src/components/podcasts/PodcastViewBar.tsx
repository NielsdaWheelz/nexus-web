"use client";

// The collection band of the podcast panes, and the url-owned view selects
// it shares with browse: an inline sort, filters in the filter editor and one
// removable chip per filter that differs from its default.

import { useRef, type ReactNode, type RefObject } from "react";
import AppliedFilters from "@/components/ui/AppliedFilters";
import SelectField from "@/components/ui/SelectField";
import CollectionFilterEditor from "@/components/workspace/CollectionFilterEditor";
import PaneCollectionBar from "@/components/workspace/PaneCollectionBar";
import type usePaneFilterRows from "@/lib/panes/usePaneFilterRows";

/** One url-owned view parameter, shown as a select. */
export interface ViewChoice {
  readonly param: string;
  readonly label: string;
  readonly value: string;
  readonly defaultValue: string;
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
  }[];
  readonly disabled?: boolean;
}

/** Param changes; null (also chosen for a default value) removes the param. */
export type ViewChanges = Readonly<Record<string, string | null>>;

export function podcastViewHref(
  basePath: string,
  current: URLSearchParams,
  changes: ViewChanges,
): string {
  const next = new URLSearchParams(current);
  for (const [param, value] of Object.entries(changes)) {
    if (value === null) next.delete(param);
    else next.set(param, value);
  }
  const query = next.toString();
  return query ? `${basePath}?${query}` : basePath;
}

// An unknown current value (a hand-written url) is offered verbatim.
const optionsOf = (choice: ViewChoice) =>
  choice.options.some((option) => option.value === choice.value)
    ? choice.options
    : [...choice.options, { value: choice.value, label: choice.value }];

export function useViewControls({
  sort,
  filters,
  onChange,
  onReset,
}: {
  readonly sort: ViewChoice | null;
  readonly filters: readonly ViewChoice[];
  readonly onChange: (changes: ViewChanges) => void;
  /** Absent while the view is already the default one. */
  readonly onReset: (() => void) | undefined;
}): { readonly selects: ReactNode; readonly chips: ReactNode } {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const select = (choice: ViewChoice, layout: "Inline" | "Stacked") => (
    <SelectField
      key={choice.param}
      layout={layout}
      label={choice.label}
      size={layout === "Inline" ? "sm" : undefined}
      value={choice.value}
      disabled={choice.disabled}
      onChange={({ target }) =>
        onChange({
          [choice.param]:
            target.value === choice.defaultValue ? null : target.value,
        })
      }
    >
      {optionsOf(choice).map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </SelectField>
  );
  const active = filters.filter(
    (choice) => choice.value !== choice.defaultValue,
  );
  const chips = active.map((choice) => {
    const shown = optionsOf(choice).find(({ value }) => value === choice.value);
    return { id: choice.param, label: `${choice.label}: ${shown?.label}` };
  });
  return {
    selects: (
      <>
        {sort === null ? null : select(sort, "Inline")}
        <CollectionFilterEditor
          activeCount={active.length}
          triggerRef={triggerRef}
          onClearFilters={() =>
            onChange(
              Object.fromEntries(filters.map(({ param }) => [param, null])),
            )
          }
          onResetView={onReset}
        >
          {filters.map((choice) => select(choice, "Stacked"))}
        </CollectionFilterEditor>
      </>
    ),
    chips: (
      <AppliedFilters
        chips={chips}
        returnFocusTo={triggerRef}
        onRemove={(param) => onChange({ [param]: null })}
      />
    ),
  };
}

/** The podcast panes' band: a local text filter beside the view selects. */
export default function PodcastViewBar({
  inputRef,
  inputLabel,
  placeholder,
  filterRows,
  sort,
  filters,
  onChange,
}: {
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly inputLabel: string;
  readonly placeholder: string;
  readonly filterRows: ReturnType<typeof usePaneFilterRows>;
  readonly sort: ViewChoice;
  readonly filters: readonly ViewChoice[];
  readonly onChange: (changes: ViewChanges) => void;
}) {
  const changed = [sort, ...filters].filter(
    (choice) => choice.value !== choice.defaultValue,
  );
  const controls = useViewControls({
    sort,
    filters,
    onChange,
    onReset:
      changed.length > 0 || filterRows.query.trim() !== ""
        ? () => {
            filterRows.clearQuery();
            onChange(
              Object.fromEntries(changed.map(({ param }) => [param, null])),
            );
          }
        : undefined,
  });
  return (
    <PaneCollectionBar
      inputRef={inputRef}
      inputLabel={inputLabel}
      placeholder={placeholder}
      query={filterRows.query}
      onQueryChange={filterRows.onQueryChange}
      onClearQuery={filterRows.clearQuery}
      rowStatus={filterRows.rowStatus}
      filters={controls.selects}
      appliedFilters={controls.chips}
    />
  );
}
