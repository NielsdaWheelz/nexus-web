import { expectExactRecord, expectNonemptyString, expectRecord } from "@/lib/validation";
import {
  decodeGenerationRoute,
  decodeGenerationSelectionSpec,
  findGenerationCandidate,
  selectionFor,
  type GenerationCandidate,
  type GenerationCatalog,
  type GenerationCatalogRoute,
  type GenerationModelRow,
  type GenerationRoute,
  type GenerationSelectionSpec,
} from "./generationCatalog";

export type SelectionDraft =
  | { readonly kind: "Uninitialized" }
  | { readonly kind: "ModelRequired"; readonly route: GenerationRoute }
  | {
      readonly kind: "EffortRequired";
      readonly route: GenerationRoute;
      readonly modelKey: string;
    }
  | { readonly kind: "Selected"; readonly selection: GenerationSelectionSpec };

export function decodeSelectionDraft(
  raw: unknown,
  name = "selection draft",
): SelectionDraft {
  const value = expectRecord(raw, name);
  switch (value.kind) {
    case "Uninitialized":
      expectExactRecord(value, ["kind"], name);
      return { kind: "Uninitialized" };
    case "ModelRequired":
      expectExactRecord(value, ["kind", "route"], name);
      return {
        kind: "ModelRequired",
        route: decodeGenerationRoute(value.route, `${name}.route`),
      };
    case "EffortRequired":
      expectExactRecord(value, ["kind", "route", "modelKey"], name);
      return {
        kind: "EffortRequired",
        route: decodeGenerationRoute(value.route, `${name}.route`),
        modelKey: expectNonemptyString(value.modelKey, `${name}.modelKey`),
      };
    case "Selected":
      expectExactRecord(value, ["kind", "selection"], name);
      return {
        kind: "Selected",
        selection: decodeGenerationSelectionSpec(value.selection, `${name}.selection`),
      };
    default:
      throw new TypeError(`${name}.kind is invalid`);
  }
}

export function routeForSelection(selection: GenerationSelectionSpec): GenerationRoute {
  if (selection.route === "CodexPersonal") return { kind: "CodexPersonal" };
  return decodeGenerationRoute(
    { kind: "ProviderApi", provider: selection.model_ref.split(":", 1)[0] },
    "selection route",
  );
}

function sameRoute(left: GenerationRoute, right: GenerationRoute): boolean {
  return left.kind === right.kind &&
    (left.kind === "CodexPersonal" ||
      (right.kind === "ProviderApi" && left.provider === right.provider));
}

function selectableModels(route: GenerationCatalogRoute): GenerationModelRow[] {
  return route.models.filter((model) =>
    model.reasoning.some((reasoning) => reasoning.chat_state.kind === "Selectable"),
  );
}

function selectedRoute(catalog: GenerationCatalog, route: GenerationRoute): GenerationCatalogRoute {
  const row = catalog.routes.find((candidate) => sameRoute(candidate.route, route));
  if (row === undefined) throw new TypeError("selected provider is absent from the catalog");
  return row;
}

export function changeGenerationRoute(
  catalog: GenerationCatalog,
  route: GenerationRoute,
): SelectionDraft {
  const models = selectableModels(selectedRoute(catalog, route));
  if (models.length === 0) throw new TypeError("selected provider has no selectable models");
  return models.length === 1
    ? changeGenerationModel(catalog, route, models[0].key)
    : { kind: "ModelRequired", route };
}

export function changeGenerationModel(
  catalog: GenerationCatalog,
  route: GenerationRoute,
  modelKey: string,
): SelectionDraft {
  const row = selectedRoute(catalog, route);
  const model = selectableModels(row).find((candidate) => candidate.key === modelKey);
  if (model === undefined) throw new TypeError("selected model is not selectable");
  const efforts = model.reasoning.filter((reasoning) => reasoning.chat_state.kind === "Selectable");
  const defaultReasoning = model.source_default_reasoning;
  const sourceDefault =
    defaultReasoning.kind === "Present"
      ? efforts.find((effort) => effort.key === defaultReasoning.value)
      : undefined;
  const effort = sourceDefault ?? (efforts.length === 1 ? efforts[0] : undefined);
  return effort === undefined
    ? { kind: "EffortRequired", route, modelKey }
    : { kind: "Selected", selection: selectionFor(row, model, effort) };
}

export function changeGenerationEffort(
  catalog: GenerationCatalog,
  route: GenerationRoute,
  modelKey: string,
  effortKey: string,
): SelectionDraft {
  const row = selectedRoute(catalog, route);
  const model = selectableModels(row).find((candidate) => candidate.key === modelKey);
  const effort = model?.reasoning.find(
    (candidate) => candidate.key === effortKey && candidate.chat_state.kind === "Selectable",
  );
  if (model === undefined || effort === undefined) {
    throw new TypeError("selected effort is not selectable");
  }
  return { kind: "Selected", selection: selectionFor(row, model, effort) };
}

export function selectableGenerationCandidate(
  catalog: GenerationCatalog,
  draft: SelectionDraft,
): GenerationCandidate | null {
  if (draft.kind !== "Selected") return null;
  const candidate = findGenerationCandidate(catalog, draft.selection);
  return candidate?.reasoning.chat_state.kind === "Selectable" ? candidate : null;
}
