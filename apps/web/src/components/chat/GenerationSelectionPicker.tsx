"use client";

import { useLayoutEffect, useRef } from "react";
import SelectField from "@/components/ui/SelectField";
import { assertNever } from "@/lib/assertNever";
import type {
  GenerationCatalog,
  GenerationRoute,
} from "@/lib/conversations/generationCatalog";
import {
  changeGenerationThinking,
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
  const rootRef = useRef<HTMLDivElement>(null);
  const providerRef = useRef<HTMLSelectElement>(null);
  const modelRef = useRef<HTMLSelectElement>(null);
  const thinkingRef = useRef<HTMLSelectElement>(null);
  const focusedField = useRef<"provider" | "model" | "thinking" | null>(null);

  let route: GenerationRoute | null = null;
  let modelKey: string | null = null;
  switch (value.kind) {
    case "Uninitialized":
      break;
    case "ModelRequired":
      route = value.route;
      break;
    case "ThinkingRequired":
      route = value.route;
      modelKey = value.modelKey;
      break;
    case "Selected":
      route = routeForSelection(catalog, value.selection);
      modelKey = value.selection.route === "CodexPersonal"
        ? value.selection.model
        : value.selection.model_ref;
      break;
    default:
      assertNever(value);
  }
  const reasoningKey = value.kind === "Selected" ? value.selection.reasoning : null;
  const routes = catalog.routes.filter((candidate) =>
    candidate.models.some((model) =>
      model.reasoning.some((choice) => choice.chat_state.kind === "Selectable"),
    ),
  );
  const currentRoute = catalog.routes.find(
    (candidate) => route !== null && routeKey(candidate.route) === routeKey(route),
  );
  const routeIsSelectable = routes.some(
    (candidate) => route !== null && routeKey(candidate.route) === routeKey(route),
  );
  const models = currentRoute?.models.filter((model) =>
    model.reasoning.some((choice) => choice.chat_state.kind === "Selectable"),
  ) ?? [];
  const currentModel = currentRoute?.models.find((model) => model.key === modelKey);
  const selectableModel = models.find((model) => model.key === modelKey);
  const choices = selectableModel?.reasoning.filter(
    (choice) => choice.chat_state.kind === "Selectable",
  ) ?? [];
  const currentChoice = currentModel?.reasoning.find((choice) => choice.key === reasoningKey);
  const selectedChoice = choices.find((choice) => choice.key === reasoningKey);

  // Refresh and singleton transitions can remove the focused control.
  useLayoutEffect(() => {
    if (focusedField.current === null || rootRef.current?.contains(document.activeElement)) return;
    const candidates =
      focusedField.current === "thinking"
        ? [thinkingRef.current, modelRef.current, providerRef.current]
        : focusedField.current === "model"
          ? [modelRef.current, thinkingRef.current, providerRef.current]
          : [providerRef.current];
    candidates.find((control) => control !== null && !control.disabled)?.focus();
  }, [catalog, value]);

  return (
    <div
      ref={rootRef}
      className={styles.root}
      onFocusCapture={(event) => {
        if (!(event.target instanceof HTMLSelectElement)) return;
        if (event.target === providerRef.current) focusedField.current = "provider";
        else if (event.target === modelRef.current) focusedField.current = "model";
        else if (event.target === thinkingRef.current) focusedField.current = "thinking";
      }}
      onBlurCapture={(event) => {
        if (
          event.relatedTarget !== null &&
          !event.currentTarget.contains(event.relatedTarget)
        ) focusedField.current = null;
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

      <div className={`${styles.field} ${styles.thinkingField}`}>
        {selectedChoice !== undefined && choices.length === 1 ? (
          <div className={styles.staticField}>
            <span>thinking</span>
            <strong>{selectedChoice.label}</strong>
          </div>
        ) : (
          <SelectField
            ref={thinkingRef}
            layout="Stacked"
            label="thinking"
            size="lg"
            value={reasoningKey ?? ""}
            disabled={disabled || selectableModel === undefined}
            onChange={(event) => {
              if (route === null || modelKey === null) {
                throw new TypeError("thinking choice requires a model");
              }
              onChange(changeGenerationThinking(catalog, route, modelKey, event.target.value));
            }}
          >
            {reasoningKey === null ? <option value="" disabled>choose thinking</option> : null}
            {reasoningKey !== null && selectedChoice === undefined ? (
              <option value={reasoningKey} disabled>
                {currentChoice?.label ?? reasoningKey}
              </option>
            ) : null}
            {choices.map((choice) => (
              <option key={choice.key} value={choice.key}>
                {choice.label}
              </option>
            ))}
          </SelectField>
        )}
      </div>
    </div>
  );
}
