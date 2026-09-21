"use client";

import { useId, useLayoutEffect, useRef } from "react";
import SelectField from "@/components/ui/SelectField";
import { assertNever } from "@/lib/assertNever";
import type {
  GenerationCatalog,
  GenerationRoute,
} from "@/lib/conversations/generationCatalog";
import {
  changeGenerationEffort,
  changeGenerationModel,
  changeGenerationRoute,
  routeForSelection,
  type SelectionDraft,
} from "@/lib/conversations/generationSelection";
import styles from "./GenerationSelectionPicker.module.css";

interface GenerationSelectionPickerProps {
  readonly catalog: GenerationCatalog;
  readonly value: SelectionDraft;
  readonly onChange: (next: SelectionDraft) => void;
  readonly disabled?: boolean;
}

function routeKey(route: GenerationRoute): string {
  return route.kind === "CodexPersonal"
    ? "CodexPersonal"
    : `ProviderApi:${route.provider}`;
}

export default function GenerationSelectionPicker({
  catalog,
  value,
  onChange,
  disabled = false,
}: GenerationSelectionPickerProps) {
  const effortName = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const providerRef = useRef<HTMLSelectElement>(null);
  const modelRef = useRef<HTMLSelectElement>(null);
  const effortRef = useRef<HTMLInputElement>(null);
  const focusedField = useRef<"provider" | "model" | "effort" | null>(null);

  let route: GenerationRoute | null = null;
  let modelKey: string | null = null;
  switch (value.kind) {
    case "Uninitialized":
      break;
    case "ModelRequired":
      route = value.route;
      break;
    case "EffortRequired":
      route = value.route;
      modelKey = value.modelKey;
      break;
    case "Selected":
      route = routeForSelection(value.selection);
      modelKey = value.selection.route === "CodexPersonal"
        ? value.selection.model
        : value.selection.model_ref;
      break;
    default:
      assertNever(value);
  }
  const effortKey = value.kind === "Selected" ? value.selection.reasoning : null;
  const routes = catalog.routes.filter((candidate) =>
    candidate.models.some((model) =>
      model.reasoning.some((effort) => effort.chat_state.kind === "Selectable"),
    ),
  );
  const currentRoute = catalog.routes.find(
    (candidate) => route !== null && routeKey(candidate.route) === routeKey(route),
  );
  const routeIsSelectable = routes.some(
    (candidate) => route !== null && routeKey(candidate.route) === routeKey(route),
  );
  const models = currentRoute?.models.filter((model) =>
    model.reasoning.some((effort) => effort.chat_state.kind === "Selectable"),
  ) ?? [];
  const currentModel = currentRoute?.models.find((model) => model.key === modelKey);
  const selectableModel = models.find((model) => model.key === modelKey);
  const efforts = selectableModel?.reasoning.filter(
    (effort) => effort.chat_state.kind === "Selectable",
  ) ?? [];
  const currentEffort = currentModel?.reasoning.find((effort) => effort.key === effortKey);
  const selectableEffort = efforts.find((effort) => effort.key === effortKey);

  // Refresh and singleton transitions can remove the focused control.
  useLayoutEffect(() => {
    if (focusedField.current === null || rootRef.current?.contains(document.activeElement)) return;
    const next =
      focusedField.current === "effort"
        ? effortRef.current ?? modelRef.current ?? providerRef.current
        : focusedField.current === "model"
          ? modelRef.current ?? effortRef.current ?? providerRef.current
          : providerRef.current;
    next?.focus();
  }, [catalog, value]);

  return (
    <div
      ref={rootRef}
      className={styles.root}
      onFocusCapture={(event) => {
        if (event.target instanceof HTMLSelectElement) {
          focusedField.current = event.target === providerRef.current ? "provider" : "model";
        } else if (event.target instanceof HTMLInputElement) {
          focusedField.current = "effort";
        }
      }}
      onBlurCapture={() => {
        focusedField.current = null;
      }}
    >
      <div className={styles.field}>
        <SelectField
          ref={providerRef}
          layout="Stacked"
          label="provider"
          size="lg"
          value={route === null ? "" : routeKey(route)}
          disabled={disabled || routes.length === 0}
          onChange={(event) => {
            const chosen = routes.find(
              (candidate) => routeKey(candidate.route) === event.target.value,
            );
            if (chosen === undefined) throw new TypeError("selected provider is not selectable");
            onChange(changeGenerationRoute(catalog, chosen.route));
          }}
        >
          {route === null ? <option value="" disabled>choose provider</option> : null}
          {route !== null && !routeIsSelectable ? (
            <option value={routeKey(route)} disabled>
              {currentRoute?.label ?? routeKey(route)}
            </option>
          ) : null}
          {routes.map((candidate) => (
            <option key={routeKey(candidate.route)} value={routeKey(candidate.route)}>
              {candidate.label}
            </option>
          ))}
        </SelectField>
      </div>

      <div className={styles.field}>
        {selectableModel !== undefined && models.length === 1 ? (
          <div className={styles.staticField}>
            <span>model</span>
            <strong>{selectableModel.label}</strong>
          </div>
        ) : (
          <SelectField
            ref={modelRef}
            layout="Stacked"
            label="model"
            size="lg"
            value={modelKey ?? ""}
            disabled={disabled || route === null || !routeIsSelectable}
            onChange={(event) => {
              if (route === null) throw new TypeError("model choice requires a provider");
              onChange(changeGenerationModel(catalog, route, event.target.value));
            }}
          >
            {modelKey === null ? <option value="" disabled>choose model</option> : null}
            {modelKey !== null && selectableModel === undefined ? (
              <option value={modelKey} disabled>
                {currentModel?.label ?? modelKey}
              </option>
            ) : null}
            {models.map((model) => (
              <option key={model.key} value={model.key}>
                {model.label}
              </option>
            ))}
          </SelectField>
        )}
      </div>

      <fieldset className={styles.effortField} disabled={disabled || selectableModel === undefined}>
        <legend>effort</legend>
        {selectableEffort !== undefined && efforts.length === 1 ? (
          <strong className={styles.staticEffort}>{selectableEffort.label}</strong>
        ) : (
          <div className={styles.efforts}>
            {effortKey !== null && selectableEffort === undefined ? (
              <span className={styles.unavailableEffort}>
                {currentEffort?.label ?? effortKey}
              </span>
            ) : null}
            {efforts.map((effort, index) => (
              <label key={effort.key} className={styles.effortOption}>
                <input
                  ref={index === 0 ? effortRef : undefined}
                  type="radio"
                  name={effortName}
                  value={effort.key}
                  checked={effort.key === effortKey}
                  onChange={() => {
                    if (route === null || modelKey === null) {
                      throw new TypeError("effort choice requires a model");
                    }
                    onChange(changeGenerationEffort(catalog, route, modelKey, effort.key));
                  }}
                />
                <span>{effort.label}</span>
              </label>
            ))}
          </div>
        )}
      </fieldset>
    </div>
  );
}
