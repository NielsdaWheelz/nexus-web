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
): CatalogRoute | undefined {
  return catalog.routes.find((row) => routeKey(row.route) === routeKey(route));
}

export function selectableModels(row: CatalogRoute | undefined) {
  return (row?.models ?? []).filter((model) =>
    model.reasoning.some((choice) => choice.chat_state.kind === "Selectable"),
  );
}

function lookup(catalog: Catalog, selection: Selection) {
  const model = catalog.routes
    .filter((row) => row.route.kind === selection.route)
    .flatMap((row) => row.models.map((model) => ({ row, model })))
    .find(({ model }) => model.key === modelKeyOf(selection));
  const choice = model?.model.reasoning.find(
    (row) => row.key === selection.reasoning,
  );
  return { ...model, choice };
}

export function routeOf(catalog: Catalog, selection: Selection): Route | null {
  return lookup(catalog, selection).row?.route ?? null;
}

export function isSelectable(catalog: Catalog, selection: Selection): boolean {
  return lookup(catalog, selection).choice?.chat_state.kind === "Selectable";
}

export function chooseRoute(catalog: Catalog, route: Route): SelectionDraft {
  const models = selectableModels(catalogRoute(catalog, route));
  return models.length === 1
    ? chooseModel(catalog, route, models[0].key)
    : { kind: "ModelRequired", route };
}

export function chooseModel(
  catalog: Catalog,
  route: Route,
  modelKey: string,
): SelectionDraft {
  const model = catalogRoute(catalog, route)?.models.find(
    (row) => row.key === modelKey,
  );
  const choices = (model?.reasoning ?? []).filter(
    (c) => c.chat_state.kind === "Selectable",
  );
  const fallback = model?.source_default_reasoning;
  const choice =
    choices.find(
      (c) => fallback?.kind === "Present" && c.key === fallback.value,
    ) ?? (choices.length === 1 ? choices[0] : undefined);
  return choice
    ? chooseThinking(route, modelKey, choice.key)
    : { kind: "ThinkingRequired", route, modelKey };
}

export function chooseThinking(
  route: Route,
  modelKey: string,
  reasoningKey: string,
): SelectionDraft {
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
  draft: SelectionDraft,
): string | null {
  if (draft.kind === "ThinkingRequired") return "Choose a thinking setting.";
  if (draft.kind !== "Selected") return "Choose a model.";
  const { model, choice } = lookup(catalog, draft.selection);
  if (!model)
    return "This model is no longer available. Choose a current model.";
  if (!choice)
    return "This thinking setting is no longer available. Choose another.";
  const state = choice.chat_state;
  if (state.kind === "Selectable") return null;
  return state.kind === "Ineligible"
    ? state.explanation
    : "This selection is currently unavailable. Choose another.";
}
