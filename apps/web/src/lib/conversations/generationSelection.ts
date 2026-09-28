import { expectExactRecord, expectNonemptyString, expectRecord } from "@/lib/validation";
import {
  decodeGenerationRoute,
  findGenerationModel,
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
      readonly kind: "ThinkingRequired";
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
    case "ThinkingRequired":
      expectExactRecord(value, ["kind", "route", "modelKey"], name);
      return {
        kind: "ThinkingRequired",
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

export function routeForSelection(
  catalog: GenerationCatalog,
  selection: GenerationSelectionSpec,
): GenerationRoute | null {
  return findGenerationModel(catalog, selection)?.route.route ?? null;
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
  const choices = model.reasoning.filter((reasoning) => reasoning.chat_state.kind === "Selectable");
  const defaultReasoning = model.source_default_reasoning;
  const sourceDefault =
    defaultReasoning.kind === "Present"
      ? choices.find((choice) => choice.key === defaultReasoning.value)
      : undefined;
  const choice = sourceDefault ?? (choices.length === 1 ? choices[0] : undefined);
  return choice === undefined
    ? { kind: "ThinkingRequired", route, modelKey }
    : { kind: "Selected", selection: selectionFor(row, model, choice) };
}

export function changeGenerationThinking(
  catalog: GenerationCatalog,
  route: GenerationRoute,
  modelKey: string,
  reasoningKey: string,
): SelectionDraft {
  const row = selectedRoute(catalog, route);
  const model = selectableModels(row).find((candidate) => candidate.key === modelKey);
  const choice = model?.reasoning.find(
    (candidate) => candidate.key === reasoningKey && candidate.chat_state.kind === "Selectable",
  );
  if (model === undefined || choice === undefined) {
    throw new TypeError("selected thinking option is not selectable");
  }
  return { kind: "Selected", selection: selectionFor(row, model, choice) };
}

export function selectionUnavailabilityMessage(
  catalog: GenerationCatalog,
  selection: GenerationSelectionSpec,
): string | null {
  const candidate = findGenerationModel(catalog, selection);
  if (candidate === null) return "this model is no longer available. choose a current model.";
  const choice = candidate.model.reasoning.find((row) => row.key === selection.reasoning);
  if (choice === undefined) {
    return "this thinking setting is no longer available. choose another.";
  }
  if (choice.chat_state.kind === "Ineligible") return choice.chat_state.explanation;
  if (choice.chat_state.kind !== "Selectable") {
    return "this selection is currently unavailable. choose another.";
  }
  return null;
}

export function selectableGenerationCandidate(
  catalog: GenerationCatalog,
  draft: SelectionDraft,
): GenerationCandidate | null {
  if (draft.kind !== "Selected") return null;
  const candidate = findGenerationCandidate(catalog, draft.selection);
  return candidate?.reasoning.chat_state.kind === "Selectable" ? candidate : null;
}
