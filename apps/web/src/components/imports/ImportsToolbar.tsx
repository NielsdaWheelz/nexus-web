"use client";

import { useId, useState, type RefObject } from "react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import RadioGroup from "@/components/ui/RadioGroup";
import type { ImportsView } from "@/lib/imports/api";
import {
  failureFilterLabel,
  KIND_LABEL,
  IMPORT_FAILURE_CODES,
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
  options: IMPORT_FAILURE_CODES.map(
    (code) => [code, failureFilterLabel(code)] as const,
  ).sort(([, left], [, right]) => left.localeCompare(right)),
};
const STATE: Choice = {
  name: "state",
  label: "State",
  any: "Any state",
  options: STATE_KINDS.map((kind) => [kind, STATE_KIND_LABEL[kind]]),
};

/** The singular constraints each view correlates (`apiQuery` narrows likewise). */
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

/** Imports owns the submitted draft and url constraints; the toolbar presents them. */
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
  };
  const datesBound = dateFilterLabel(dateBounds(state));
  const date = (name: "from" | "before", label: string) => (
    <label className={styles.dateField}>
      <span>{label}</span>
      <Input
        type="date"
        size="sm"
        value={state[name] ?? ""}
        onChange={(event) => set(name, event.target.value)}
      />
    </label>
  );

  const structuredChips = chips.filter((chip) => chip.id !== "q");
  return (
    <PaneQueryToolbar
      inputRef={inputRef}
      input={{
        label: "Search imports",
        placeholder: "Search titles, files and sources",
        value: draft,
        appliedValue: committed,
        onChange: setDraft,
        onClear: clearSearch,
      }}
      submit={{ onSubmit: () => set("q", draft.trim()) }}
      options={{
        label: "Filters",
        activeCount: structuredChips.length,
        onClear: () => onChange(withoutFilters(state)),
        content: <>
          {CHOICES[view].map((choice) => <RadioGroup
            key={choice.name}
            label={choice.label}
            value={state[choice.name] ?? ""}
            choices={[{ value: "", label: choice.any }, ...choice.options.map(([value, label]) => ({ value, label }))]}
            onChange={(value) => set(choice.name, value)}
          />)}
          {view === "History" ? <>
            <RadioGroup
              label="Recorded failures"
              value={state.had_failures === undefined ? "" : String(state.had_failures)}
              choices={[
                { value: "", label: "Any" },
                { value: "true", label: "Had failures" },
                { value: "false", label: "No recorded failures" },
              ]}
              onChange={(value) => set("had_failures", value)}
            />
            <div role="group" aria-label={datesBound} className={styles.dateGroup}>
              <span aria-hidden="true" className={styles.dateGroupLabel}>{datesBound}</span>
              {date("from", "From")}
              {date("before", "Before")}
            </div>
          </> : null}
        </>,
      }}
      chips={{ items: structuredChips, onRemove: (id) => set(id, "") }}
      status={{ id: statusId, visible: true, content:
        <span id={statusId} className={styles.resultStatus} role={announce ? "status" : undefined} aria-live={announce ? "polite" : undefined} aria-atomic={announce ? true : undefined}>{resultStatus}</span>
      }}
      actions={<Button variant="ghost" size="sm" onClick={onRefresh}>Refresh</Button>}
      onReset={resetAvailable || draft ? () => { setDraft(""); onReset(); } : undefined}
    />
  );
}
