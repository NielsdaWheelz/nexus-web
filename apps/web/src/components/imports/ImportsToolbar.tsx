"use client";

import { useState, type ReactNode, type RefObject } from "react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import RadioGroup from "@/components/ui/RadioGroup";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import type { ImportsView } from "@/lib/imports/api";
import {
  IMPORT_FAILURE_CODES,
  KIND_LABEL,
  STATE_KIND_LABEL,
  dateFilterLabel,
  failureFilterLabel,
  stageLabel,
} from "@/lib/imports/copy";
import {
  IMPORT_STAGES,
  STATE_KINDS,
  VIEW_FILTERS,
  appliedState,
  dateBounds,
  withFilter,
  withoutFilters,
  type ImportsFilter,
  type ImportsUrlState,
} from "@/lib/imports/query";
import { MEDIA_KINDS } from "@/lib/media/kind";
import styles from "./Imports.module.css";

/** The single-choice filters, in panel order; a view shows those it applies. */
const CHOICES: readonly {
  readonly name: "media_kind" | "stage" | "failure_code" | "state";
  readonly label: string;
  readonly any: string;
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
  }[];
}[] = [
  {
    name: "media_kind",
    label: "Type",
    any: "Any type",
    options: MEDIA_KINDS.map((value) => ({ value, label: KIND_LABEL[value] })),
  },
  {
    name: "stage",
    label: "Stage",
    any: "Any stage",
    options: IMPORT_STAGES.map((value) => ({
      value,
      label: stageLabel(value),
    })),
  },
  {
    name: "failure_code",
    label: "Reason",
    any: "Any reason",
    options: IMPORT_FAILURE_CODES.map((value) => ({
      value,
      label: failureFilterLabel(value),
    })).sort((left, right) => left.label.localeCompare(right.label)),
  },
  {
    name: "state",
    label: "State",
    any: "Any state",
    options: STATE_KINDS.map((value) => ({
      value,
      label: STATE_KIND_LABEL[value],
    })),
  },
];

/**
 * Imports owns the submitted draft and the url's constraints; the toolbar
 * presents the ones the view applies.
 */
export default function ImportsToolbar({
  view,
  state,
  inputRef,
  chips,
  resultStatus,
  statusId,
  resetAvailable,
  onChange,
  onReset,
  onRefresh,
}: {
  readonly view: ImportsView;
  readonly state: ImportsUrlState;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly chips: readonly { id: ImportsFilter; label: string }[];
  readonly resultStatus: ReactNode;
  readonly statusId: string;
  readonly resetAvailable: boolean;
  readonly onChange: (next: ImportsUrlState) => void;
  readonly onReset: () => void;
  readonly onRefresh: () => void;
}) {
  const committed = state.q ?? "";
  const [draft, setDraft] = useState(committed);
  const [synced, setSynced] = useState(committed);
  if (synced !== committed) {
    setSynced(committed);
    setDraft(committed);
  }
  const applied = appliedState(view, state);
  const set = (name: ImportsFilter, value: string) =>
    onChange(withFilter(state, name, value));
  const datesBound = dateFilterLabel(dateBounds(applied));
  const date = (name: "from" | "before", label: string) => (
    <label className={styles.dateField}>
      <span>{label}</span>
      <Input
        type="date"
        size="sm"
        value={applied[name] ?? ""}
        onChange={(event) => set(name, event.target.value)}
      />
    </label>
  );
  const structured = chips.filter((chip) => chip.id !== "q");
  return (
    <PaneQueryToolbar
      inputRef={inputRef}
      input={{
        label: "Search imports",
        placeholder: "Search titles, files and sources",
        value: draft,
        appliedValue: committed,
        onChange: setDraft,
        onClear: () => {
          setDraft("");
          onChange({ ...state, q: undefined });
        },
      }}
      submit={{ onSubmit: () => set("q", draft.trim()) }}
      options={{
        label: "Filters",
        activeCount: structured.length,
        onClear: () => onChange(withoutFilters(state)),
        content: (
          <>
            {CHOICES.filter((choice) =>
              VIEW_FILTERS[view].includes(choice.name),
            ).map((choice) => (
              <RadioGroup
                key={choice.name}
                label={choice.label}
                value={applied[choice.name] ?? ""}
                choices={[{ value: "", label: choice.any }, ...choice.options]}
                onChange={(value) => set(choice.name, value)}
              />
            ))}
            {view === "History" ? (
              <>
                <RadioGroup
                  label="Recorded failures"
                  value={
                    applied.had_failures === undefined
                      ? ""
                      : String(applied.had_failures)
                  }
                  choices={[
                    { value: "", label: "Any" },
                    { value: "true", label: "Had failures" },
                    { value: "false", label: "No recorded failures" },
                  ]}
                  onChange={(value) => set("had_failures", value)}
                />
                <div
                  role="group"
                  aria-label={datesBound}
                  className={styles.dateGroup}
                >
                  <span aria-hidden="true" className={styles.dateGroupLabel}>
                    {datesBound}
                  </span>
                  {date("from", "From")}
                  {date("before", "Before")}
                </div>
              </>
            ) : null}
          </>
        ),
      }}
      chips={{
        items: structured,
        // justify-type-assertion: the toolbar hands back one of these chips' ids.
        onRemove: (id) => set(id as ImportsFilter, ""),
      }}
      status={{
        placement: "Details",
        id: statusId,
        visible: false,
        content: resultStatus,
      }}
      actions={
        <Button onClick={onRefresh}>
          Refresh
        </Button>
      }
      onReset={
        resetAvailable || draft
          ? () => {
              setDraft("");
              onReset();
            }
          : undefined
      }
    />
  );
}
