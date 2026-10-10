"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import Button from "@/components/ui/Button";
import SelectField from "@/components/ui/SelectField";
import { apiFetch, isSameSystemApiDefect } from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  catalogRoute,
  chooseModel,
  chooseRoute,
  chooseThinking,
  modelKeyOf,
  routeKey,
  routeOf,
  selectableModels,
  unavailability,
  type Route,
  type SelectionDraft,
} from "@/lib/chat/selection";
import type { Catalog, Selection } from "@/lib/chat/wire";
import styles from "./ChatComposer.module.css";

// One catalog per tab: loaded on first use and refreshed only after a catalog
// rejection or an explicit retry, never on focus.
let cached: Catalog | null = null;
let request: Promise<Catalog> | null = null;
const listeners = new Set<() => void>();

export function loadCatalog(refresh = false): Promise<Catalog> {
  if (cached && !refresh) return Promise.resolve(cached);
  request ??= apiFetch<ApiJson<"/llm-catalog", "get">>("/api/llm-catalog", {
    cache: "no-store",
  })
    .then(({ data }) => {
      cached = data;
      for (const listener of listeners) listener();
      return data;
    })
    .finally(() => {
      request = null;
    });
  return request;
}

export function useCatalog(): {
  catalog: Catalog | null;
  failed: boolean;
  refresh(): void;
} {
  const catalog = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => cached,
    () => null,
  );
  const [failed, setFailed] = useState(false);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const load = useCallback((refresh: boolean) => {
    setFailed(false);
    loadCatalog(refresh).catch((error: unknown) => {
      if (handleUnauthenticatedApiError(error)) return;
      if (isSameSystemApiDefect(error)) setDefect({ error });
      else setFailed(true);
    });
  }, []);
  useEffect(() => {
    if (!cached) load(false);
  }, [load]);
  if (defect) throw defect.error;
  return { catalog, failed, refresh: () => load(true) };
}

/** One labelled select; a current value the catalog no longer offers stays shown, disabled. */
function Choice(props: {
  label: string;
  value: string | null;
  options: readonly { key: string; label: string }[];
  disabled: boolean;
  onPick(key: string): void;
}) {
  const { label, value, options } = props;
  return (
    <SelectField
      layout="Stacked"
      label={label}
      size="lg"
      value={value ?? ""}
      disabled={props.disabled}
      onChange={(event) => props.onPick(event.target.value)}
    >
      {options.some((option) => option.key === value) ? null : (
        <option value={value ?? ""} disabled>
          {value ?? `choose ${label}`}
        </option>
      )}
      {options.map((option) => (
        <option key={option.key} value={option.key}>
          {option.label}
        </option>
      ))}
    </SelectField>
  );
}

export default function GenerationPicker({
  catalog,
  value,
  onChange,
  disabled,
}: {
  catalog: Catalog;
  value: SelectionDraft;
  onChange(value: SelectionDraft): void;
  disabled: boolean;
}) {
  const route: Route | null =
    value.kind === "Uninitialized"
      ? null
      : value.kind === "Selected"
        ? routeOf(catalog, value.selection)
        : value.route;
  const modelKey =
    value.kind === "Selected"
      ? modelKeyOf(value.selection)
      : value.kind === "ThinkingRequired"
        ? value.modelKey
        : null;
  const routes = catalog.routes
    .filter((row) => selectableModels(row).length > 0)
    .map((row) => ({
      key: routeKey(row.route),
      label: row.label,
      route: row.route,
    }));
  const models = selectableModels(
    route ? catalogRoute(catalog, route) : undefined,
  );
  const model = models.find((row) => row.key === modelKey);
  return (
    <div className={styles.picker}>
      <Choice
        label="provider"
        value={route && routeKey(route)}
        options={routes}
        disabled={disabled}
        onPick={(key) => {
          const row = routes.find((option) => option.key === key);
          if (row) onChange(chooseRoute(catalog, row.route));
        }}
      />
      <Choice
        label="model"
        value={modelKey}
        options={models}
        disabled={disabled || !route}
        onPick={(key) => route && onChange(chooseModel(catalog, route, key))}
      />
      <Choice
        label="thinking"
        value={value.kind === "Selected" ? value.selection.reasoning : null}
        options={(model?.reasoning ?? []).filter(
          (row) => row.chat_state.kind === "Selectable",
        )}
        disabled={disabled || !model}
        onPick={(key) =>
          route && modelKey && onChange(chooseThinking(route, modelKey, key))
        }
      />
    </div>
  );
}

/** "Rerun / Regenerate with a different model": the source run's selection, editable. */
export function CandidatePicker({
  op,
  source,
  disabled,
  onConfirm,
}: {
  op: "rerun" | "regenerate";
  source: Selection;
  disabled: boolean;
  onConfirm(selection: Selection): Promise<boolean>;
}) {
  const verb = op === "rerun" ? "Rerun" : "Regenerate";
  const [draft, setDraft] = useState<SelectionDraft | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { catalog, failed, refresh } = useCatalog();
  const reason = catalog && draft ? unavailability(catalog, draft) : null;
  return (
    <div className={styles.candidate}>
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled || submitting}
        aria-expanded={draft !== null}
        onClick={() =>
          setDraft(draft ? null : { kind: "Selected", selection: source })
        }
      >
        {draft ? "Cancel model choice" : `${verb} with a different model`}
      </Button>
      {draft && !catalog ? (
        <p className={styles.status} role="status">
          {failed
            ? "Model availability could not be loaded."
            : "Loading model availability…"}
          {failed ? (
            <Button variant="ghost" size="sm" onClick={refresh}>
              Retry
            </Button>
          ) : null}
        </p>
      ) : null}
      {draft && catalog ? (
        <>
          <GenerationPicker
            catalog={catalog}
            value={draft}
            onChange={setDraft}
            disabled={disabled || submitting}
          />
          {reason ? (
            <p className={styles.status} role="status">
              {reason}
            </p>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            disabled={disabled || reason !== null || draft.kind !== "Selected"}
            loading={submitting}
            onClick={async () => {
              if (draft.kind !== "Selected") return;
              setSubmitting(true);
              const accepted = await onConfirm(draft.selection);
              setSubmitting(false);
              if (accepted) setDraft(null);
              else refresh();
            }}
          >
            {verb} with this model
          </Button>
        </>
      ) : null}
    </div>
  );
}
