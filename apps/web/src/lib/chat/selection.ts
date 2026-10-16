import type { Schema } from "@/lib/api/wire";
import { isRecord } from "@/lib/validation";
import type { Catalog, Selection } from "./wire";

// The exact generation a draft will run: chosen from the catalog, never
// substituted. The browser owns no allowlist; the server rejects stale choices.

export type Route = Schema<"CodexPersonalRoute"> | Schema<"ProviderApiRoute">;
export type SelectionDraft =
  | { kind: "Uninitialized" }
  | { kind: "ModelRequired"; route: Route }
  | { kind: "ThinkingRequired"; route: Route; modelKey: string }
  | { kind: "Selected"; selection: Selection };
type CatalogRoute = Catalog["routes"][number];
type CatalogModel = CatalogRoute["models"][number];
export type ReasoningChoice = CatalogModel["reasoning"][number];
export type SelectionEditor =
  | SelectionDraft
  | { kind: "EffortRequired"; route: Route; model_key: string; mode: string | null };
export type ModelVariant = {
  key: string;
  model: CatalogModel;
  mode: string | null;
  reasoning: ReasoningChoice[];
};

/** Persisted browser storage only: null for a record this build cannot read. */
export function decodeSelectionDraft(raw: unknown): SelectionDraft | null {
  if (!isRecord(raw)) return null;
  const { route, selection: s, modelKey } = raw;
  const okRoute =
    isRecord(route) &&
    (route.kind === "CodexPersonal" ||
      (route.kind === "ProviderApi" && typeof route.provider === "string"));
  const okSelection =
    isRecord(s) &&
    typeof s.reasoning === "string" &&
    typeof (s.route === "CodexPersonal"
      ? s.model
      : s.route === "ProviderApi" && s.model_ref) === "string";
  const ok =
    raw.kind === "Uninitialized" ||
    (raw.kind === "ModelRequired" && okRoute) ||
    (raw.kind === "ThinkingRequired" &&
      okRoute &&
      typeof modelKey === "string") ||
    (raw.kind === "Selected" && okSelection);
  // justify-type-assertion: checked structurally above; a stale route or
  // model never matches the catalog, and the server validates every send.
  return ok ? (raw as SelectionDraft) : null;
}

export const modelKeyOf = (selection: Selection) =>
  selection.route === "CodexPersonal" ? selection.model : selection.model_ref;

export function sameSelection(a: Selection, b: Selection): boolean {
  return (
    a.route === b.route &&
    modelKeyOf(a) === modelKeyOf(b) &&
    a.reasoning === b.reasoning
  );
}

export const routeKey = (route: Route) =>
  route.kind === "CodexPersonal"
    ? "CodexPersonal"
    : `ProviderApi:${route.provider}`;

export function catalogRoute(
  catalog: Catalog,
  route: Route,
): CatalogRoute | null {
  return catalog.routes.find((row) => routeKey(row.route) === routeKey(route)) ?? null;
}

export const variantKey = (modelKey: string, mode: string | null) =>
  JSON.stringify([modelKey, mode]);

/** Only actual model/mode combinations become options, in source order. */
export function modelVariants(row: CatalogRoute | null): ModelVariant[] {
  return (row?.models ?? []).flatMap((model) =>
    [...new Set(model.reasoning.map((choice) => choice.mode))].flatMap((mode) => {
      const reasoning = model.reasoning
        .filter((choice) => choice.mode === mode)
        .sort((a, b) => a.effort_order - b.effort_order);
      return [{ key: variantKey(model.key, mode), model, mode, reasoning }];
    }),
  );
}

function lookup(catalog: Catalog, selection: Selection) {
  const model = catalog.routes
    .filter((row) => row.route.kind === selection.route)
    .flatMap((row) => row.models.map((model) => ({ row, model })))
    .find(({ model }) => model.key === modelKeyOf(selection)) ?? null;
  const choice = model?.model.reasoning.find(
    (row) => row.key === selection.reasoning,
  );
  return { row: model?.row ?? null, model: model?.model ?? null, choice: choice ?? null };
}

export function routeOf(catalog: Catalog, selection: Selection): Route | null {
  if (selection.route === "CodexPersonal")
    return catalog.routes.find((row) => row.route.kind === "CodexPersonal")?.route ?? null;
  return lookup(catalog, selection).row?.route ?? null;
}

export function editorRoute(catalog: Catalog, value: SelectionEditor): Route | null {
  if (value.kind === "Selected") return routeOf(catalog, value.selection);
  return value.kind === "Uninitialized" ? null : value.route;
}

export function editorVariant(catalog: Catalog, value: SelectionEditor): ModelVariant | null {
  const route = editorRoute(catalog, value);
  if (!route) return null;
  if (value.kind === "EffortRequired")
    return modelVariants(catalogRoute(catalog, route)).find((variant) =>
      variant.model.key === value.model_key && variant.mode === value.mode) ?? null;
  if (value.kind !== "Selected") return null;
  const { choice } = lookup(catalog, value.selection);
  if (!choice) return null;
  return modelVariants(catalogRoute(catalog, route)).find((variant) =>
    variant.model.key === modelKeyOf(value.selection) && variant.mode === choice.mode) ?? null;
}

export function choiceUnavailable(choice: ReasoningChoice): string | null {
  return choice.chat_state.kind === "Selectable" ? null : choice.chat_state.explanation;
}

export function isSelectable(catalog: Catalog, selection: Selection): boolean {
  return lookup(catalog, selection).choice?.chat_state.kind === "Selectable";
}

export function chooseRoute(catalog: Catalog, route: Route, current: SelectionEditor): SelectionEditor {
  const previous = editorRoute(catalog, current);
  return previous && routeKey(previous) === routeKey(route)
    ? current
    : { kind: "ModelRequired", route };
}

export function chooseModel(
  catalog: Catalog,
  route: Route,
  modelKey: string,
  mode: string | null,
  current: SelectionEditor,
): SelectionEditor {
  const previousRoute = editorRoute(catalog, current);
  const sameRoute = previousRoute !== null && routeKey(previousRoute) === routeKey(route);
  const previousVariant = editorVariant(catalog, current);
  if (sameRoute && previousVariant?.key === variantKey(modelKey, mode)) return current;
  const model = catalogRoute(catalog, route)?.models.find(
    (row) => row.key === modelKey,
  ) ?? null;
  const choices = (model?.reasoning ?? []).filter(
    (c) => c.mode === mode && c.chat_state.kind === "Selectable",
  );
  const previousEffort = sameRoute && current.kind === "Selected"
    ? lookup(catalog, current.selection).choice?.effort ?? null
    : null;
  const fallback = model?.source_default_reasoning ?? null;
  const choice =
    choices.find((c) => previousEffort !== null && c.effort === previousEffort) ?? choices.find(
      (c) => fallback != null && c.key === fallback,
    ) ?? (choices.length === 1 ? choices[0] : null);
  return choice
    ? chooseThinking(route, modelKey, choice.key)
    : { kind: "EffortRequired", route, model_key: modelKey, mode };
}

export function chooseThinking(
  route: Route,
  modelKey: string,
  reasoningKey: string,
): Extract<SelectionDraft, { kind: "Selected" }> {
  return {
    kind: "Selected",
    selection:
      route.kind === "CodexPersonal"
        ? { route: "CodexPersonal", model: modelKey, reasoning: reasoningKey }
        : {
            route: "ProviderApi",
            model_ref: modelKey,
            reasoning: reasoningKey,
          },
  };
}

/** Why this draft cannot be sent; null when it can. */
export function unavailability(
  catalog: Catalog,
  draft: SelectionEditor,
): string | null {
  if (draft.kind === "EffortRequired") {
    if (!catalogRoute(catalog, draft.route)) return "provider unavailable. choose provider.";
    const variant = editorVariant(catalog, draft);
    if (!variant) return "model unavailable. choose model.";
    return variant.reasoning.some((choice) => choice.chat_state.kind === "Selectable")
      ? "choose effort" : choiceUnavailable(variant.reasoning[0]);
  }
  if (draft.kind !== "Selected")
    return draft.kind !== "Uninitialized" && !catalogRoute(catalog, draft.route)
      ? "provider unavailable. choose provider." : "choose model";
  if (!routeOf(catalog, draft.selection)) return "provider unavailable. choose provider.";
  const { model, choice } = lookup(catalog, draft.selection);
  if (!model)
    return "model unavailable. choose model.";
  if (!choice)
    return "effort unavailable. choose effort.";
  const state = choice.chat_state;
  if (state.kind === "Selectable") return null;
  return state.explanation;
}
