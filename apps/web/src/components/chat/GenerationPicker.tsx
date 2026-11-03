"use client";

import { useLayoutEffect } from "react";
import { Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
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
  MODEL_UNAVAILABLE,
  modelKeyOf,
  modelVariants,
  routeKey,
  unreadyReason,
  type SelectionEditor,
} from "@/lib/chat/selection";
import type { Catalog } from "@/lib/chat/wire";
import EffortPicker from "./EffortPicker";
import styles from "./ChatComposer.module.css";

/** The three choices share one read and commit only advertised exact selections. Cold, each
 * trigger stays pressable and opens on the ruling; a failed read opens with its fact, and the press
 * reads again. A failed revalidation over shown rows says nothing. */
export default function GenerationPicker({
  catalogRead,
  value,
  onChange,
  disabled,
  waiting = false,
}: {
  catalogRead: ServerValue<Catalog>;
  value: SelectionEditor;
  onChange(value: SelectionEditor): void;
  disabled: boolean;
  /** The choice shown is still being recalled: effort spins, stays pressable, and opens on the ruling. */
  waiting?: boolean;
}) {
  // Complete only the committed unresolved intent. No deferred callback can
  // overwrite a later explicit choice, and exact selections are never normalized.
  useLayoutEffect(() => {
    if (disabled || catalogRead.status !== "ready" || value.kind !== "DefaultUnavailable") return;
    const next = chooseModel(catalogRead.data, value.route, value.model_key, value.mode, value);
    if (next.kind === "Selected") onChange(next);
  }, [catalogRead, value, onChange, disabled]);
  if (catalogRead.status !== "ready") {
    const unready = catalogRead.status === "loading" ? <Ruling />
      : <Failed error={catalogRead.error} noun="models" retry={{ run: () => void catalogRead.refetch(), busy: catalogRead.retrying }} />;
    const reread = () => { if (catalogRead.status === "failed" && !catalogRead.retrying) void catalogRead.refetch(); };
    return <div className={styles.picker}>
      <ChoicePicker label="provider" value={null} options={[]} disabled={disabled} busy={catalogRead.status === "loading" || catalogRead.retrying} footer={unready} onOpen={reread} onChange={() => {}} />
      <ChoicePicker label="model" value={null} options={[]} disabled={disabled} busy={catalogRead.status === "loading" || catalogRead.retrying} footer={unready} onOpen={reread} onChange={() => {}} />
      <EffortPicker variant={null} value={value} disabled={disabled} waiting={catalogRead.status === "loading"} unready={unready} onOpen={reread} onChange={() => {}} />
    </div>;
  }
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
      unavailable_reason: row.readiness.kind !== "Ready" ? unreadyReason(row.readiness)
        : choices.some((choice) => choice.chat_state.kind === "Selectable")
        ? null : choices[0] ? choiceUnavailable(choices[0]) : "no chat models available.",
    };
  });
  const missingId = JSON.stringify(value);
  const providerId = route ? routeKey(route) : value.kind === "Selected" ? missingId : null;
  if (providerId !== null && !providers.some((option) => option.id === providerId))
    providers.unshift({ id: providerId, label: routeRow?.label ?? (route?.kind === "ProviderApi" ? route.provider : route?.kind === "CodexPersonal" ? "Codex" : "unknown provider"), detail: null,
      unavailable_reason: route ? "this provider isn’t available now." : MODEL_UNAVAILABLE });
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
      unavailable_reason: routeRow && routeRow.readiness.kind !== "Ready" ? unreadyReason(routeRow.readiness)
        : variant ? choiceUnavailable(variant.reasoning[0])
        : MODEL_UNAVAILABLE });
  }
  return (
    <div className={styles.picker}>
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
        disabled={disabled || (!variant && value.kind !== "Selected" && !waiting)}
        waiting={waiting} unready={waiting && !variant ? <Ruling /> : null}
        onOpen={refresh}
        onChange={(key) => {
          if (route && variant) onChange(chooseThinking(route, variant.model.key, key));
        }} />
    </div>
  );
}
