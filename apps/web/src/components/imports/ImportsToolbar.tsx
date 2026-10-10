"use client";

import { useId, useRef, useState, type RefObject } from "react";
import { X } from "lucide-react";
import AppliedFilters from "@/components/ui/AppliedFilters";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import PaneToolbar from "@/components/ui/PaneToolbar";
import SelectField from "@/components/ui/SelectField";
import Toggle from "@/components/ui/Toggle";
import CollectionFilterEditor from "@/components/workspace/CollectionFilterEditor";
import type { ImportsView } from "@/lib/imports/api";
import {
  FAILURE_COPY,
  KIND_LABEL,
  ORDER_LABEL,
  SAFE_FAILURE_CODES,
  STATE_KIND_LABEL,
  dateFilterLabel,
  stageLabel,
} from "@/lib/imports/copy";
import {
  IMPORT_STAGES,
  STATE_KINDS,
  dateBounds,
  decodeImportsUrl,
  encodeImportsUrl,
  withoutFilters,
  type ImportsFilter,
  type ImportsUrlState,
} from "@/lib/imports/query";
import { MEDIA_KINDS } from "@/lib/media/kind";
import styles from "./Imports.module.css";

interface Choice {
  readonly name: "media_kind" | "stage" | "failure_code" | "state";
  readonly label: string;
  readonly any: string;
  readonly options: readonly (readonly [value: string, label: string])[];
}

const TYPE: Choice = {
  name: "media_kind",
  label: "Type",
  any: "Any type",
  options: MEDIA_KINDS.map((kind) => [kind, KIND_LABEL[kind]]),
};
const STAGE: Choice = {
  name: "stage",
  label: "Stage",
  any: "Any stage",
  options: IMPORT_STAGES.map((stage) => [stage, stageLabel(stage)]),
};
const REASON: Choice = {
  name: "failure_code",
  label: "Reason",
  any: "Any reason",
  options: SAFE_FAILURE_CODES.map(
    (code) => [code, FAILURE_COPY[code].reason] as const,
  ).sort(([, left], [, right]) => left.localeCompare(right)),
};
const STATE: Choice = {
  name: "state",
  label: "State",
  any: "Any state",
  options: STATE_KINDS.map((kind) => [kind, STATE_KIND_LABEL[kind]]),
};

/** The selects each view correlates (`apiQuery` narrows the same way). */
const CHOICES: Readonly<Record<ImportsView, readonly Choice[]>> = {
  NeedsAttention: [TYPE, STAGE, REASON],
  InProgress: [TYPE, STAGE],
  History: [TYPE, STAGE, REASON, STATE],
};

/** One url param set or cleared, through the tolerant decoder. */
function withParam(state: ImportsUrlState, name: string, value: string) {
  const params = encodeImportsUrl(state);
  if (value === "") params.delete(name);
  else params.set(name, value);
  return decodeImportsUrl(params);
}

/**
 * The Imports collection bar: search (a draft committed on Enter; Escape clears
 * the draft only), the filters the view correlates, the applied-filter chips,
 * the result status and Refresh. Every change goes through `onChange`.
 */
export default function ImportsToolbar({
  view,
  state,
  inputRef,
  chips,
  resultStatus,
  announce,
  resetAvailable,
  onChange,
  onReset,
  onRefresh,
}: {
  readonly view: ImportsView;
  readonly state: ImportsUrlState;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly chips: readonly { id: ImportsFilter; label: string }[];
  readonly resultStatus: string;
  /** The status states facts, so it is a polite live region. */
  readonly announce: boolean;
  readonly resetAvailable: boolean;
  readonly onChange: (next: ImportsUrlState) => void;
  readonly onReset: () => void;
  readonly onRefresh: () => void;
}) {
  const statusId = useId();
  const filterTriggerRef = useRef<HTMLButtonElement>(null);
  const committed = state.q ?? "";
  const [draft, setDraft] = useState(committed);
  const [synced, setSynced] = useState(committed);
  if (synced !== committed) {
    setSynced(committed);
    setDraft(committed);
  }
  const set = (name: string, value: string) =>
    onChange(withParam(state, name, value));
  const clearSearch = () => {
    setDraft("");
    onChange({ ...state, q: undefined });
    inputRef.current?.focus({ preventScroll: true });
  };
  const datesBound = dateFilterLabel(dateBounds(state));
  const date = (name: "from" | "before", label: string) => (
    <label className={styles.dateField}>
      <span>{label}</span>
      <input
        type="date"
        value={state[name] ?? ""}
        onChange={(event) => set(name, event.target.value)}
      />
    </label>
  );

  return (
    <PaneToolbar
      variant="Collection"
      search={
        <form
          className={styles.search}
          onSubmit={(event) => {
            event.preventDefault();
            set("q", draft.trim());
          }}
        >
          <Input
            ref={inputRef}
            type="search"
            size="sm"
            aria-label="Search imports"
            aria-describedby={statusId}
            aria-keyshortcuts="Escape"
            placeholder="Search titles, files and sources"
            value={draft}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            data-pane-collection-input="true"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || event.defaultPrevented) return;
              event.preventDefault();
              event.stopPropagation();
              setDraft("");
            }}
          />
          {draft || state.q !== undefined ? (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              type="button"
              aria-label="Clear text filter"
              title="Clear text filter"
              onClick={clearSearch}
            >
              <X size={15} aria-hidden="true" />
            </Button>
          ) : null}
          <button type="submit" className="sr-only" tabIndex={-1}>
            Apply search
          </button>
        </form>
      }
      filters={
        <>
          <span className={styles.sortLabel}>Order: {ORDER_LABEL[view]}</span>
          <CollectionFilterEditor
            activeCount={chips.filter((chip) => chip.id !== "q").length}
            triggerRef={filterTriggerRef}
            onClearFilters={() => onChange(withoutFilters(state))}
            onResetView={
              resetAvailable || draft !== ""
                ? () => {
                    setDraft("");
                    onReset();
                  }
                : undefined
            }
          >
            {CHOICES[view].map((choice) => (
              <SelectField
                key={choice.name}
                layout="Inline"
                label={choice.label}
                size="sm"
                value={state[choice.name] ?? ""}
                onChange={(event) => set(choice.name, event.target.value)}
              >
                <option value="">{choice.any}</option>
                {choice.options.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </SelectField>
            ))}
            {view !== "History" ? null : (
              <>
                <Toggle
                  size="sm"
                  label="Had failures"
                  checked={state.had_failures === true}
                  onCheckedChange={(next) =>
                    set("had_failures", next ? "true" : "")
                  }
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
            )}
          </CollectionFilterEditor>
        </>
      }
      summary={
        <div className={styles.summary}>
          <AppliedFilters
            chips={[...chips]}
            onRemove={(id) => set(id, "")}
            returnFocusTo={filterTriggerRef}
          />
          <span
            id={statusId}
            className={styles.resultStatus}
            role={announce ? "status" : undefined}
            aria-live={announce ? "polite" : undefined}
          >
            {resultStatus}
          </span>
          <Button variant="ghost" size="sm" onClick={onRefresh}>
            Refresh
          </Button>
        </div>
      }
    />
  );
}
