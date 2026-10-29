import type { Schema } from "@/lib/api/wire";
import type { Catalog, Selection } from "./wire";

// The exact generation a draft will run: chosen from the catalog, never
// substituted. The browser owns no allowlist; the server rejects stale choices.

export type Route = Schema<"CodexPersonalRoute"> | Schema<"ProviderApiRoute">;
type CatalogRoute = Catalog["routes"][number];
type CatalogModel = CatalogRoute["models"][number];
export type ReasoningChoice = CatalogModel["reasoning"][number];
/** A draft keeps incomplete intent; only `Selected` can be sent. */
export type SelectionEditor =
  | { readonly kind: "Uninitialized" }
  | { readonly kind: "DefaultUnavailable"; readonly route: Route; readonly model_key: string; readonly mode: string | null }
  | { readonly kind: "Selected"; readonly selection: Selection; readonly route: Route | null };
export type ModelVariant = {
  key: string;
  model: CatalogModel;
  mode: string | null;
  reasoning: ReasoningChoice[];
};

export const modelKeyOf = (selection: Selection) =>
  selection.route === "CodexPersonal" ? selection.model : selection.model_ref;

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

const variantKey = (modelKey: string, mode: string | null) =>
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

function lookup(catalog: Catalog, selection: Selection, route: Route | null = null) {
  const model = catalog.routes
    .filter((row) => route ? routeKey(row.route) === routeKey(route) : row.route.kind === selection.route)
    .flatMap((row) => row.models.map((model) => ({ row, model })))
    .find(({ model }) => model.key === modelKeyOf(selection)) ?? null;
  const choice = model?.model.reasoning.find(
    (row) => row.key === selection.reasoning,
  );
  return { row: model?.row ?? null, model: model?.model ?? null, choice: choice ?? null };
}

export function routeOf(catalog: Catalog, selection: Selection): Route | null {
  if (selection.route === "CodexPersonal")
    return { kind: "CodexPersonal" };
  return lookup(catalog, selection).row?.route ?? catalog.routes.find((row) =>
    row.route.kind === selection.route && row.default_model.model_key === modelKeyOf(selection))?.route ?? null;
}

export function editorRoute(value: SelectionEditor): Route | null {
  if (value.kind === "Selected") return value.route;
  return value.kind === "Uninitialized" ? null : value.route;
}

export function editorVariant(catalog: Catalog, value: SelectionEditor): ModelVariant | null {
  const route = editorRoute(value);
  if (!route) return null;
  if (value.kind === "DefaultUnavailable")
    return modelVariants(catalogRoute(catalog, route)).find((variant) =>
      variant.model.key === value.model_key && variant.mode === value.mode) ?? null;
  if (value.kind !== "Selected") return null;
  const { choice } = lookup(catalog, value.selection, value.route);
  if (!choice) return null;
  return modelVariants(catalogRoute(catalog, route)).find((variant) =>
    variant.model.key === modelKeyOf(value.selection) && variant.mode === choice.mode) ?? null;
}

export function choiceUnavailable(choice: ReasoningChoice): string | null {
  return choice.chat_state.kind === "Selectable" ? null : choice.chat_state.explanation;
}

export function isSelectable(catalog: Catalog, selection: Selection, route: Route | null = null): boolean {
  return lookup(catalog, selection, route).choice?.chat_state.kind === "Selectable";
}

export function chooseRoute(catalog: Catalog, route: Route, current: SelectionEditor): SelectionEditor {
  const previous = editorRoute(current);
  if (current.kind === "Selected" && previous && routeKey(previous) === routeKey(route)) return current;
  const row = catalogRoute(catalog, route);
  if (!row) return current;
  return chooseModel(catalog, route, row.default_model.model_key, row.default_model.mode, current);
}

export function chooseModel(
  catalog: Catalog,
  route: Route,
  modelKey: string,
  mode: string | null,
  current: SelectionEditor,
): SelectionEditor {
  const previousRoute = editorRoute(current);
  const sameRoute = previousRoute !== null && routeKey(previousRoute) === routeKey(route);
  const previousVariant = editorVariant(catalog, current);
  if (current.kind === "Selected" && sameRoute && previousVariant?.key === variantKey(modelKey, mode)) return current;
  const choice = catalogRoute(catalog, route)?.models.find((row) => row.key === modelKey)
    ?.reasoning.find((row) => row.mode === mode && row.chat_default);
  return choice
    ? chooseThinking(route, modelKey, choice.key)
    : { kind: "DefaultUnavailable", route, model_key: modelKey, mode };
}

export function chooseThinking(
  route: Route,
  modelKey: string,
  reasoningKey: string,
): Extract<SelectionEditor, { kind: "Selected" }> {
  return {
    kind: "Selected",
    route,
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
  const route = editorRoute(draft);
  const row = route ? catalogRoute(catalog, route) : null;
  if (row && row.readiness.kind !== "Ready") return row.readiness.explanation;
  if (draft.kind === "DefaultUnavailable") {
    if (!catalogRoute(catalog, draft.route)) return "provider unavailable. choose provider.";
    const variant = editorVariant(catalog, draft);
    return variant ? "default effort unavailable" : "default model unavailable";
  }
  if (draft.kind === "Uninitialized") return "loading models…";
  if (!route || !row) return "provider unavailable. choose provider.";
  const { model, choice } = lookup(catalog, draft.selection, route);
  if (!model)
    return "model unavailable. choose model.";
  if (!choice)
    return "effort unavailable. choose effort.";
  const state = choice.chat_state;
  if (state.kind === "Selectable") return null;
  return state.explanation;
}
