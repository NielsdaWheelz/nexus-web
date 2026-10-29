"use client";

import { useLayoutEffect } from "react";
import { FeedbackFailure, FeedbackBusy, useFeedbackOccurrence } from "@/components/feedback/Feedback";
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
  type SelectionEditor,
} from "@/lib/chat/selection";
import type { Catalog } from "@/lib/chat/wire";
import EffortPicker from "./EffortPicker";
import styles from "./ChatComposer.module.css";

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
  const failure = catalogRead.status === "loading" ? null : catalogRead.error;
  const occurrence = useFeedbackOccurrence(failure !== null);
  // Complete only the committed unresolved intent. No deferred callback can
  // overwrite a later explicit choice, and exact selections are never normalized.
  useLayoutEffect(() => {
    if (disabled || catalogRead.status !== "ready" || value.kind !== "DefaultUnavailable") return;
    const next = chooseModel(catalogRead.data, value.route, value.model_key, value.mode, value);
    if (next.kind === "Selected") onChange(next);
  }, [catalogRead, value, onChange, disabled]);
  if (catalogRead.status !== "ready") return <div className={styles.picker}>
    <FeedbackBusy pending={catalogRead.status === "loading"} />
    {catalogRead.status === "failed" ? <FeedbackFailure scope="Local" occurrence={occurrence} content={{ tone: "Warning", title: "model availability couldn’t be loaded" }} announcement="Polite"
      actions={[{label: "retry", onClick: catalogRead.refetch, busy: catalogRead.retrying}]} /> : null}
    <ChoicePicker label="provider" value={null} options={[]} disabled footer={null} onOpen={catalogRead.refetch} onChange={() => {}} />
    <ChoicePicker label="model" value={null} options={[]} disabled footer={null} onOpen={catalogRead.refetch} onChange={() => {}} />
    <EffortPicker variant={null} value={value} disabled onOpen={catalogRead.refetch} onChange={() => {}} />
  </div>;
  const catalog = catalogRead.data;
  const refresh = catalogRead.error ? catalogRead.refetch : catalogRead.revalidate;
  const route = editorRoute(value);
  const routeRow = route ? catalogRoute(catalog, route) : null;
  const variant = editorVariant(catalog, value);
  const routes = catalog.routes;
  const providers: ChoiceOption[] = routes.map((row) => {
    const choices = modelVariants(row).flatMap((item) => item.reasoning);
    return {
      id: routeKey(row.route),
      label: row.label,
      detail: null,
      unavailable_reason: row.readiness.kind !== "Ready" ? row.readiness.explanation
        : choices.some((choice) => choice.chat_state.kind === "Selectable")
        ? null : choices[0] ? choiceUnavailable(choices[0]) : "no chat models available",
    };
  });
  const missingId = JSON.stringify(value);
  const providerId = route ? routeKey(route) : value.kind === "Selected" ? missingId : null;
  if (providerId !== null && !providers.some((option) => option.id === providerId))
    providers.unshift({ id: providerId, label: routeRow?.label ?? (route?.kind === "ProviderApi" ? route.provider : route?.kind === "CodexPersonal" ? "Codex" : "provider unavailable"), detail: null,
      unavailable_reason: "this provider has no available chat models" });
  const variants = modelVariants(routeRow);
  const models: ChoiceOption[] = variants.map((item) => ({
    id: item.key,
    label: item.mode === null ? item.model.label : `${item.model.label} · ${item.reasoning[0].mode_label}`,
    detail: null,
    unavailable_reason: item.reasoning.some((choice) => choice.chat_state.kind === "Selectable")
      ? null : choiceUnavailable(item.reasoning[0]),
  }));
  const modelId = variant?.key ??
    (value.kind === "Selected" || value.kind === "DefaultUnavailable" ? missingId : null);
  if (modelId !== null && !models.some((option) => option.id === modelId)) {
    const modelKey = value.kind === "Selected" ? modelKeyOf(value.selection)
      : value.kind === "DefaultUnavailable" ? value.model_key : null;
    const knownModel = routeRow?.models.find((model) => model.key === modelKey) ?? null;
    const label = variant
      ? variant.mode === null ? variant.model.label : `${variant.model.label} · ${variant.reasoning[0].mode_label}`
      : knownModel ? `${knownModel.label} · mode unavailable`
      : modelKey ?? "model unavailable";
    models.unshift({ id: modelId, label, detail: null,
      unavailable_reason: routeRow && routeRow.readiness.kind !== "Ready" ? routeRow.readiness.explanation
        : variant ? choiceUnavailable(variant.reasoning[0])
        : "this model or mode is no longer available" });
  }
  return (
    <div className={styles.picker}>
      <FeedbackBusy pending={false} />
      {catalogRead.error ? <FeedbackFailure scope="Local" occurrence={occurrence} content={{tone: "Warning", title: "couldn’t refresh model availability"}} announcement="Polite" actions={[{label: "retry", onClick: catalogRead.refetch, busy: catalogRead.refreshing}]} /> : null}
      <ChoicePicker label="provider" value={providerId} options={providers} disabled={disabled}
        footer={null} onOpen={refresh}
        onChange={(key) => {
          const selected = routes.find((row) => routeKey(row.route) === key);
          if (selected) onChange(chooseRoute(catalog, selected.route, value));
        }} />
      <ChoicePicker label="model" value={modelId} options={models} disabled={disabled || !routeRow}
        footer={null} onOpen={refresh}
        onChange={(key) => {
          const selected = variants.find((item) => item.key === key);
          if (route && selected)
            onChange(chooseModel(catalog, route, selected.model.key, selected.mode, value));
        }} />
      <EffortPicker variant={variant} value={value}
        disabled={disabled || (!variant && value.kind !== "Selected")}
        onOpen={refresh}
        onChange={(key) => {
          if (route && variant) onChange(chooseThinking(route, variant.model.key, key));
        }} />
    </div>
  );
}
