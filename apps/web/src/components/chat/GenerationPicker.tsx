"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import ChoicePicker, { type ChoiceOption } from "@/components/ui/ChoicePicker";
import type { ServerValue } from "@/lib/api/serverState";
import {
  catalogRoute,
  choiceUnavailable,
  chooseModel,
  chooseRoute,
  chooseThinking,
  editorRoute,
  editorVariant,
  modelKeyOf,
  modelVariants,
  routeKey,
  unavailability,
  type SelectionEditor,
  type ModelVariant,
} from "@/lib/chat/selection";
import type { Catalog, Selection } from "@/lib/chat/wire";
import EffortPicker from "./EffortPicker";
import styles from "./ChatComposer.module.css";

const chatCapable = (variant: ModelVariant) => variant.reasoning.some((choice) =>
  choice.chat_state.kind !== "Ineligible" || choice.chat_state.code !== "unsupported_capability");

/** The three choices share one read and commit only advertised exact selections. */
export default function GenerationPicker({
  catalogRead,
  value,
  onChange,
  disabled,
}: {
  catalogRead: ServerValue<Catalog>;
  value: SelectionEditor;
  onChange(value: SelectionEditor): void;
  disabled: boolean;
}) {
  if (catalogRead.status !== "ready")
    return (
      <span className={styles.status} role="status">
        {catalogRead.status === "failed" ? "couldn’t refresh models" : "loading models…"}
        {catalogRead.status === "failed" ? (
          <Button variant="ghost" size="sm" onClick={catalogRead.refetch}>refresh</Button>
        ) : null}
      </span>
    );
  const catalog = catalogRead.data;
  const route = editorRoute(catalog, value);
  const routeRow = route ? catalogRoute(catalog, route) : null;
  const variant = editorVariant(catalog, value);
  const routes = catalog.routes.filter((row) => modelVariants(row).some(chatCapable));
  const providers: ChoiceOption[] = routes.map((row) => {
    const choices = modelVariants(row).filter(chatCapable).flatMap((item) => item.reasoning);
    return {
      id: routeKey(row.route),
      label: row.label,
      detail: row.billing.kind === "Subscription" ? "subscription" : "metered api",
      unavailable_reason: choices.some((choice) => choice.chat_state.kind === "Selectable")
        ? null : choiceUnavailable(choices[0]),
    };
  });
  const missingId = JSON.stringify(value);
  const providerId = route ? routeKey(route) : value.kind === "Selected" ? missingId : null;
  if (providerId !== null && !providers.some((option) => option.id === providerId))
    providers.unshift({ id: providerId, label: routeRow?.label ?? "provider unavailable", detail: null,
      unavailable_reason: "this provider has no available chat models" });
  const variants = modelVariants(routeRow).filter(chatCapable);
  const models: ChoiceOption[] = variants.map((item) => ({
    id: item.key,
    label: item.mode === null ? item.model.label : `${item.model.label} · ${item.mode}`,
    detail: null,
    unavailable_reason: item.reasoning.some((choice) => choice.chat_state.kind === "Selectable")
      ? null : choiceUnavailable(item.reasoning[0]),
  }));
  const modelId = variant?.key ??
    (value.kind === "Selected" || value.kind === "EffortRequired" ? missingId : null);
  if (modelId !== null && !models.some((option) => option.id === modelId)) {
    const modelKey = value.kind === "Selected" ? modelKeyOf(value.selection)
      : value.kind === "EffortRequired" ? value.model_key : null;
    const knownModel = routeRow?.models.find((model) => model.key === modelKey) ?? null;
    let label = "model unavailable";
    if (variant)
      label = variant.mode === null ? variant.model.label : `${variant.model.label} · ${variant.mode}`;
    else if (knownModel) {
      const mode = value.kind === "EffortRequired" ? value.mode : "mode unavailable";
      label = mode === null ? knownModel.label : `${knownModel.label} · ${mode}`;
    }
    models.unshift({ id: modelId, label, detail: null,
      unavailable_reason: variant ? choiceUnavailable(variant.reasoning[0])
        : "this model or mode is no longer available" });
  }
  const footer = (
    <div className={styles.pickerFooter}>
      <span role="status">
        {catalogRead.error ? "couldn’t refresh models" : catalogRead.refreshing ? "refreshing models…" : ""}
      </span>
      <Button variant="ghost" size="sm" onClick={catalogRead.refetch}>refresh</Button>
    </div>
  );
  return (
    <div className={styles.picker}>
      <ChoicePicker label="provider" value={providerId} options={providers} disabled={disabled}
        footer={footer} onOpen={catalogRead.refetch}
        onChange={(key) => {
          const selected = routes.find((row) => routeKey(row.route) === key);
          if (selected) onChange(chooseRoute(catalog, selected.route, value));
        }} />
      <ChoicePicker label="model" value={modelId} options={models} disabled={disabled || !route}
        footer={footer} onOpen={catalogRead.refetch}
        onChange={(key) => {
          const selected = variants.find((item) => item.key === key);
          if (route && selected)
            onChange(chooseModel(catalog, route, selected.model.key, selected.mode, value));
        }} />
      <EffortPicker variant={variant} value={value}
        disabled={disabled || (!variant && value.kind !== "Selected")}
        footer={footer} onOpen={catalogRead.refetch}
        onChange={(key) => {
          if (route && variant) onChange(chooseThinking(route, variant.model.key, key));
        }} />
    </div>
  );
}

/** Settings stay local to this candidate; only its execution button starts a run. */
export function CandidatePicker({
  op,
  source,
  disabled,
  onConfirm,
  catalogRead,
}: {
  op: "rerun" | "regenerate";
  source: Selection;
  disabled: boolean;
  onConfirm(selection: Selection): Promise<boolean>;
  catalogRead: ServerValue<Catalog>;
}) {
  const [draft, setDraft] = useState<SelectionEditor | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const reason = catalogRead.status === "ready" && draft
    ? unavailability(catalogRead.data, draft) : null;
  return (
    <div className={styles.candidate}>
      <Button variant="ghost" size="sm" disabled={disabled || submitting}
        aria-expanded={draft !== null}
        onClick={() => setDraft(draft ? null : { kind: "Selected", selection: source })}>
        {draft ? "cancel" : `${op} with…`}
      </Button>
      {draft ? (
        <>
          <GenerationPicker catalogRead={catalogRead} value={draft} onChange={setDraft}
            disabled={disabled || submitting} />
          {reason ? <p className={styles.status} role="status">{reason}</p> : null}
          <Button variant="secondary" size="sm" loading={submitting}
            disabled={disabled || catalogRead.status !== "ready" || reason !== null || draft.kind !== "Selected"}
            onClick={async () => {
              if (draft.kind !== "Selected") return;
              setSubmitting(true);
              const accepted = await onConfirm(draft.selection);
              setSubmitting(false);
              if (accepted) setDraft(null);
              else catalogRead.refetch();
            }}>
            {op}
          </Button>
        </>
      ) : null}
    </div>
  );
}
